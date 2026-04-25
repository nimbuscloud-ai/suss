// graphqlShared.ts — helpers shared by GraphQL discovery handlers
// (resolverMap, graphqlHookCall, graphqlImperativeCall).
//
// Document-resolution and parse machinery lives here so each handler
// stays focused on its own discovery shape.

import fs from "node:fs";
import path from "node:path";

import {
  type DocumentNode as GraphqlDocumentNode,
  Kind as GraphqlKind,
  type OperationDefinitionNode as GraphqlOperationDefinitionNode,
  type TypeNode as GraphqlTypeNode,
  parse as graphqlParse,
  print as graphqlPrint,
} from "graphql";
import { Node } from "ts-morph";

import type { FunctionRoot } from "../conditions.js";

/**
 * Parse a gql document source via graphql-js. Extracts everything
 * downstream layers need: operation type (query / mutation /
 * subscription), optional operation name, variable declarations
 * (including type-string and required flag), and root-level selection
 * field names. We run the full parser rather than a regex because
 * once you want variables you're re-implementing a recursive-descent
 * parser anyway, and graphql-js is already a transitive dep of the
 * checker and stub-appsync.
 *
 * Returns null for any parse failure — the adapter keeps moving
 * rather than halting on a malformed query literal.
 */
export function parseGraphqlOperation(source: string): {
  operationType: "query" | "mutation" | "subscription";
  operationName?: string;
  variables: Array<{ name: string; type: string; required: boolean }>;
  rootFields: string[];
} | null {
  const op = parseFirstOperationDefinition(source);
  if (op === null) {
    return null;
  }
  const operationType =
    op.operation === "mutation"
      ? "mutation"
      : op.operation === "subscription"
        ? "subscription"
        : "query";
  const variables = (op.variableDefinitions ?? []).map((def) => ({
    name: def.variable.name.value,
    type: printGraphqlType(def.type),
    required: def.type.kind === GraphqlKind.NON_NULL_TYPE,
  }));
  const rootFields: string[] = [];
  for (const selection of op.selectionSet.selections) {
    if (selection.kind === GraphqlKind.FIELD) {
      rootFields.push(selection.name.value);
    }
  }
  const name = op.name?.value;
  return {
    operationType,
    ...(name !== undefined ? { operationName: name } : {}),
    variables,
    rootFields,
  };
}

function parseFirstOperationDefinition(
  source: string,
): GraphqlOperationDefinitionNode | null {
  try {
    const doc = graphqlParse(source);
    for (const def of doc.definitions) {
      if (def.kind === GraphqlKind.OPERATION_DEFINITION) {
        return def;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Reconstruct `User!`, `[ID!]!`, `[[Int]]` etc. as a single readable
 * type string from a parsed GraphQL type node. Matches the shape
 * stub-appsync uses for consistency — both packages feed
 * `ref:<printed-type>` into TypeShape, and keeping the printing rule
 * identical means a consumer's `$id: ID!` variable and a resolver's
 * `id: ID!` arg read as the same ref.
 */
function printGraphqlType(node: GraphqlTypeNode): string {
  if (node.kind === GraphqlKind.NON_NULL_TYPE) {
    return `${printGraphqlType(node.type)}!`;
  }
  if (node.kind === GraphqlKind.LIST_TYPE) {
    return `[${printGraphqlType(node.type)}]`;
  }
  return node.name.value;
}

/**
 * Peel the surrounding backticks off a template-literal source so the
 * operation-header regex matches the GraphQL content (the regex
 * starts with `\s*` for leading whitespace inside the literal, not
 * for the backtick character itself).
 */
function innerTemplateText(template: Node): string {
  const raw = template.getText();
  // Template literals are always wrapped in backticks; substring
  // between them is the GraphQL document. For TemplateExpression
  // with `${...}` substitutions we only need the head — interpolation
  // can't live inside the operation-header, so the leading portion
  // suffices for name extraction.
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Resolve a hook-call argument to the inner source text of its
 * gql-tagged template literal. Handles:
 *   `useQuery(gql\`query ...\`)`             — inline gql tag
 *   `useQuery(GET_USER)`                      — const-bound gql tag
 *   `import GET_USER from "./q.graphql"`      — .graphql file import
 *
 * The `.graphql` / `.gql` file path resolves relative to the source
 * file. Files that don't exist on disk (common under
 * `useInMemoryFileSystem` test projects) fall back to null rather
 * than throwing — discovery stays advisory, not punitive.
 */
export function resolveGqlTemplateText(arg: Node): string | null {
  if (Node.isTaggedTemplateExpression(arg)) {
    const tag = arg.getTag();
    if (!Node.isIdentifier(tag) || tag.getText() !== "gql") {
      return null;
    }
    return innerTemplateText(arg.getTemplate());
  }
  if (Node.isIdentifier(arg)) {
    const symbol = arg.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init !== undefined && Node.isTaggedTemplateExpression(init)) {
          return resolveGqlTemplateText(init);
        }
      }
      // Default-import form: `import GET_USER from "./q.graphql"`.
      // The declaration on the symbol chain is an ImportClause whose
      // parent import declaration points at the module specifier.
      if (Node.isImportClause(decl) || Node.isImportSpecifier(decl)) {
        const fromGraphqlFile = resolveGraphqlFileImport(decl);
        if (fromGraphqlFile !== null) {
          return fromGraphqlFile;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a hook-call argument that's a TypedDocumentNode reference —
 * the dominant production shape produced by GraphQL Code Generator. The
 * declaration looks like:
 *
 *   export const FooDocument = {
 *     kind: "Document",
 *     definitions: [{
 *       kind: "OperationDefinition",
 *       operation: "query",
 *       name: { kind: "Name", value: "Foo" },
 *       ...
 *     }],
 *   } as unknown as DocumentNode<FooQuery, FooQueryVariables>;
 *
 * Strategy: walk the identifier to its initializer, evaluate the
 * object-literal AST as a plain JS value (the JSON-shaped structure
 * mirrors a graphql-js DocumentNode), then re-serialize via
 * `graphqlPrint` so the rest of the pipeline (which expects a GraphQL
 * source string) works unchanged.
 */
export function resolveTypedDocumentSource(arg: Node): string | null {
  if (!Node.isIdentifier(arg)) {
    return null;
  }
  const symbol = arg.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  // Follow `import { FooDocument } from "..."` to the source-file
  // declaration. Without aliasing the symbol's declarations land on
  // the ImportSpecifier in the consumer file, which carries no
  // initializer to read. `getAliasedSymbol` resolves to the original
  // VariableDeclaration; falls back to the local symbol when the
  // identifier wasn't imported.
  const resolved = symbol.getAliasedSymbol() ?? symbol;
  for (const decl of resolved.getDeclarations()) {
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    if (init === undefined) {
      continue;
    }
    const inner = stripDocumentNodeCasts(init);
    if (!Node.isObjectLiteralExpression(inner)) {
      continue;
    }
    const evaluated = evaluateObjectLiteralAsJson(inner);
    if (evaluated === null || typeof evaluated !== "object") {
      continue;
    }
    const doc = evaluated as Record<string, unknown>;
    if (doc.kind !== "Document" || !Array.isArray(doc.definitions)) {
      continue;
    }
    try {
      return graphqlPrint(evaluated as unknown as GraphqlDocumentNode);
    } catch {
      // Malformed AST — skip rather than throw.
      return null;
    }
  }
  return null;
}

/**
 * Strip the `as unknown as DocumentNode<...>` cast that codegen emits.
 * Walks AsExpression chains so a multi-step `expr as unknown as
 * DocumentNode<X, Y>` peels to the inner object literal.
 */
function stripDocumentNodeCasts(node: Node): Node {
  let current: Node = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Evaluate an object-literal / array-literal / primitive-literal AST
 * subtree to the corresponding plain JS value. Returns null on the
 * first node that can't be statically evaluated (computed property
 * names, function references, spread elements, identifier values).
 * The caller decides how to handle a partial parse — this helper is
 * strict so a single unresolvable corner doesn't silently produce
 * a structurally-incomplete document.
 */
function evaluateObjectLiteralAsJson(node: Node): unknown {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  if (Node.isNumericLiteral(node)) {
    return Number(node.getText());
  }
  const kind = node.getText();
  if (kind === "true") {
    return true;
  }
  if (kind === "false") {
    return false;
  }
  if (kind === "null") {
    return null;
  }
  if (Node.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        return null;
      }
      const nameNode = prop.getNameNode();
      let name: string;
      if (Node.isIdentifier(nameNode)) {
        name = nameNode.getText();
      } else if (
        Node.isStringLiteral(nameNode) ||
        Node.isNoSubstitutionTemplateLiteral(nameNode)
      ) {
        name = nameNode.getLiteralValue();
      } else {
        return null;
      }
      const init = prop.getInitializer();
      if (init === undefined) {
        return null;
      }
      const value = evaluateObjectLiteralAsJson(init);
      if (value === undefined) {
        return null;
      }
      out[name] = value;
    }
    return out;
  }
  if (Node.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.getElements()) {
      const value = evaluateObjectLiteralAsJson(el);
      if (value === undefined) {
        return null;
      }
      out.push(value);
    }
    return out;
  }
  return undefined;
}

function resolveGraphqlFileImport(decl: Node): string | null {
  const importDecl = Node.isImportSpecifier(decl)
    ? decl.getImportDeclaration()
    : Node.isImportClause(decl)
      ? decl.getParent()
      : null;
  if (
    importDecl === null ||
    importDecl === undefined ||
    !Node.isImportDeclaration(importDecl)
  ) {
    return null;
  }
  const specifier = importDecl.getModuleSpecifierValue();
  if (!/\.graphql$|\.gql$/.test(specifier)) {
    return null;
  }
  const sourceFile = importDecl.getSourceFile();
  const baseDir = path.dirname(sourceFile.getFilePath());
  const absolute = path.resolve(baseDir, specifier);
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/** Walk to the function (declaration / expression / arrow / method) enclosing the node. */
export function enclosingFunctionRoot(node: Node): FunctionRoot | null {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current as FunctionRoot;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Pick the most specific name available for the enclosing function:
 * declaration / method name first, then containing variable name,
 * then `<anon>`.
 */
export function functionNameOrAnon(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    return func.getName() ?? "<anon>";
  }
  const parent = func.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return "<anon>";
}
