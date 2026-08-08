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

import { resolveAliasedSymbol } from "../moduleExports.js";

import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The names a GraphQL document tag goes by. `gql` is the tag every
 * client library ships; `graphql` is what GraphQL Code Generator's
 * client preset calls its generated function. Both appear as a tagged
 * template and as a plain call, and the generated module they come from
 * is named by the project rather than by a library, so a pack cannot
 * name the module the way it names a transparent wrapper's.
 */
const DOCUMENT_TAGS = new Set(["gql", "graphql"]);

/**
 * The one tag name taken at face value without checking where it came
 * from. `gql` names a GraphQL document across every client library and
 * almost nothing else, so a local function called `gql` whose argument
 * parses as GraphQL is a document by any reading. `graphql` is a common
 * enough name for a local helper that it has to come from an import to
 * count.
 */
const UNQUALIFIED_DOCUMENT_TAG = "gql";

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

export type GraphqlOperationType = "query" | "mutation" | "subscription";

/**
 * Result of resolving a hook / imperative call argument to the GraphQL
 * document it references.
 *
 *   - `document` set    → the document body was read statically; the
 *                         caller parses it for the full operation shape.
 *   - `document` unset, `operationType`/`operationName` set → header-only:
 *                         the body wasn't readable but the operation
 *                         header was recovered from the
 *                         `TypedDocumentNode<Result, Vars>` type argument.
 *   - `unresolved` set  → recognized as a GraphQL document reference but
 *                         the header couldn't be fully read. The caller
 *                         still emits the boundary (operation type comes
 *                         from the call shape) and surfaces the gap so
 *                         nothing is silently dropped.
 */
export interface DocumentResolution {
  document?: string;
  operationType?: GraphqlOperationType;
  operationName?: string;
  unresolved?: { reference: string; reason: string };
}

/**
 * Resolve a hook / imperative call argument to a GraphQL document.
 *
 * Tries, in order:
 *
 *   `useQuery(gql\`query ...\`)`
 *       an inline gql tag.
 *   `useQuery(gql(\`query ...\`))`
 *       an inline tag call, which is how graphql-codegen's client
 *       preset is written.
 *   `useQuery(GET_USER)`
 *       a named constant holding either, in this module or in another
 *       one, through any depth of aliasing and re-export barrels.
 *   `import GET_USER from "./q.graphql"`
 *       a `.graphql` / `.gql` file import.
 *   `useQuery(FooDocument)`
 *       a generated TypedDocumentNode object literal (graphql-codegen
 *       client preset), same module or cross module.
 *   `useQuery(FooDocument)` whose body isn't a readable object literal
 *       the operation header off the `TypedDocumentNode<FooQuery,
 *       FooQueryVariables>` type arguments.
 *
 * A document the code computes (a ternary, a builder call) has no
 * written form to read, so it resolves to nothing rather than to a
 * guess.
 *
 * Returns null when the argument isn't recognizable as a GraphQL
 * document reference. The caller pairs that with `unreadableDocument`
 * so the call is still reported, as a gap. Returns a
 * `DocumentResolution` with `unresolved` set when it IS recognizable
 * but the header couldn't be fully read.
 */
export function resolveGraphqlDocument(
  arg: Node,
  resolution?: ResolutionStore,
): DocumentResolution | null {
  // Peel `FooDocument as DocumentNode` / parenthesization at the call
  // site so the underlying identifier or tagged template is reached.
  const stripped = stripDocumentNodeCasts(arg);
  const inline = documentTextFromExpression(stripped);
  if (inline !== null) {
    return { document: inline };
  }
  const templateText = resolveGqlTemplateText(stripped);
  if (templateText !== null) {
    return { document: templateText };
  }
  const objectDoc = resolveTypedDocumentSource(stripped);
  if (objectDoc !== null) {
    return { document: objectDoc };
  }
  const throughFacts = resolveThroughFacts(stripped, resolution);
  if (throughFacts !== null) {
    return { document: throughFacts };
  }
  return resolveTypedDocumentHeader(stripped);
}

/**
 * The document text an expression carries when it is written out as a
 * tag: `gql\`...\`` or `gql(\`...\`)`. Returns null for anything else,
 * including a tag call whose argument is built rather than written.
 */
function documentTextFromExpression(node: Node): string | null {
  if (Node.isTaggedTemplateExpression(node)) {
    if (!isDocumentTag(node.getTag())) {
      return null;
    }
    return innerTemplateText(node.getTemplate());
  }
  if (!Node.isCallExpression(node)) {
    return null;
  }
  if (!isDocumentTag(node.getExpression())) {
    return null;
  }
  const first = node.getArguments()[0];
  if (first === undefined) {
    return null;
  }
  const template = stripDocumentNodeCasts(first);
  if (
    !Node.isNoSubstitutionTemplateLiteral(template) &&
    !Node.isTemplateExpression(template)
  ) {
    return null;
  }
  return innerTemplateText(template);
}

/**
 * Whether an expression names a GraphQL document tag. `import { gql as
 * apolloGql }` is a name the file chose, so the name the module exports
 * is what answers when there is one.
 */
function isDocumentTag(tag: Node): boolean {
  if (!Node.isIdentifier(tag)) {
    return false;
  }
  if (tag.getText() === UNQUALIFIED_DOCUMENT_TAG) {
    return true;
  }
  const symbol = tag.getSymbol();
  if (symbol === undefined) {
    return false;
  }
  for (const declaration of symbol.getDeclarations()) {
    if (
      Node.isImportSpecifier(declaration) &&
      DOCUMENT_TAGS.has(declaration.getName())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Ask the fact layer what expression the argument is written as, then
 * read the answer as a document. This is what covers a document held in
 * a named constant: the syntactic walks above follow one variable
 * declaration, and production code puts the document behind an alias, a
 * re-export barrel, or a module the consumer only names.
 *
 * The fact layer answers with an expression and no opinion about what
 * it is. Recognizing a tag call as a document is GraphQL's business, so
 * it happens here rather than in the rules.
 */
function resolveThroughFacts(
  arg: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  if (resolution === undefined || !Node.isIdentifier(arg)) {
    return null;
  }
  const written = resolution.resolveWrittenValue(arg);
  if (written === null) {
    return null;
  }
  const text = documentTextFromExpression(written);
  if (text !== null) {
    return text;
  }
  return typedDocumentSourceOf(written);
}

/** Operation shape a discovered GraphQL consumer unit carries. */
export interface ResolvedOperationInfo {
  operationType: GraphqlOperationType;
  operationName?: string;
  document?: string;
  variables: Array<{ name: string; type: string; required: boolean }>;
  rootFields: string[];
  unresolved?: { reference: string; reason: string };
}

/**
 * Turn a document resolution into the operation info a discovered unit
 * carries. A readable body is parsed for the full shape; an anonymous
 * operation (`gql\`{ ... }\``, which graphql-js parses as a query by
 * default) takes its type from the call shape (the hook or imperative
 * method). A header-only or unresolvable resolution falls back to the
 * call-shape type and carries the gap through. Returns null only when a
 * readable document fails to parse.
 */
export function operationInfoFromResolution(
  resolution: DocumentResolution,
  callOperationType: GraphqlOperationType,
): ResolvedOperationInfo | null {
  if (resolution.document !== undefined) {
    const operation = parseGraphqlOperation(resolution.document);
    if (operation === null) {
      return null;
    }
    const operationType =
      operation.operationName !== undefined
        ? operation.operationType
        : callOperationType;
    return { ...operation, operationType, document: resolution.document };
  }
  return {
    operationType: resolution.operationType ?? callOperationType,
    ...(resolution.operationName !== undefined
      ? { operationName: resolution.operationName }
      : {}),
    variables: [],
    rootFields: [],
    ...(resolution.unresolved !== undefined
      ? { unresolved: resolution.unresolved }
      : {}),
  };
}

/**
 * What to report for a call that matched the pack and whose document
 * argument nobody could read. Without it a user cannot tell a file with
 * no GraphQL hooks from a file with five the reader could not follow,
 * and the second is the one worth knowing about. The boundary is
 * emitted with the operation type the call shape gives and the argument
 * text as the reference, so the gap says which call to go look at.
 */
export function unreadableDocument(arg: Node): DocumentResolution {
  return {
    unresolved: {
      reference: singleLine(stripDocumentNodeCasts(arg).getText()),
      reason:
        "the call matched but its document argument did not resolve to a readable GraphQL document",
    },
  };
}

/** The argument text, on one line and short enough to read in a report. */
function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

/**
 * Follow an identifier through same-module const bindings and
 * cross-module named / default imports to the initializer expression(s)
 * of the variable declaration(s) it refers to.
 *
 * `getAliasedSymbol` resolves an import specifier to the exported
 * declaration in the defining module (the local symbol's declarations
 * are the ImportSpecifier, which carries no initializer); the fallback
 * to the local symbol covers same-module bindings that have no alias to
 * follow. This is the single cross-module resolution primitive the
 * GraphQL document resolvers share.
 */
function importedVariableInitializers(identifier: Node): Node[] {
  if (!Node.isIdentifier(identifier)) {
    return [];
  }
  const symbol = identifier.getSymbol();
  if (symbol === undefined) {
    return [];
  }
  const resolved = resolveAliasedSymbol(symbol) ?? symbol;
  const inits: Node[] = [];
  for (const decl of resolved.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init !== undefined) {
        inits.push(init);
      }
    }
  }
  return inits;
}

/**
 * Resolve an argument to the inner source text of its gql-tagged
 * template literal — inline, const-bound (same or cross module), or
 * imported from a `.graphql` / `.gql` file. Files that don't exist on
 * disk (common under `useInMemoryFileSystem` test projects) fall back
 * to null rather than throwing — discovery stays advisory, not punitive.
 */
export function resolveGqlTemplateText(arg: Node): string | null {
  const direct = documentTextFromExpression(arg);
  if (direct !== null) {
    return direct;
  }
  if (!Node.isIdentifier(arg)) {
    return null;
  }
  const symbol = arg.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  // `.graphql` / `.gql` file import resolves against the local import
  // declaration — the aliased symbol points at a synthetic module with
  // no readable initializer, so this branch reads the on-disk file.
  for (const decl of symbol.getDeclarations()) {
    if (Node.isImportClause(decl) || Node.isImportSpecifier(decl)) {
      const fromGraphqlFile = resolveGraphqlFileImport(decl);
      if (fromGraphqlFile !== null) {
        return fromGraphqlFile;
      }
    }
  }
  // A tagged const in this module, or one reached through the import to
  // the defining module's declaration.
  for (const init of importedVariableInitializers(arg)) {
    const text = documentTextFromExpression(stripDocumentNodeCasts(init));
    if (text !== null) {
      return text;
    }
  }
  return null;
}

/**
 * Resolve an argument that's a TypedDocumentNode reference — the
 * dominant production shape produced by GraphQL Code Generator's
 * client-preset. The declaration looks like:
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
 * Strategy: follow the identifier to its initializer (same or cross
 * module), evaluate the object-literal AST as a plain JS value (the
 * JSON-shaped structure mirrors a graphql-js DocumentNode), then
 * re-serialize via `graphqlPrint` so the rest of the pipeline (which
 * expects a GraphQL source string) works unchanged.
 */
export function resolveTypedDocumentSource(arg: Node): string | null {
  if (!Node.isIdentifier(arg)) {
    return null;
  }
  for (const init of importedVariableInitializers(arg)) {
    const source = typedDocumentSourceOf(init);
    if (source !== null) {
      return source;
    }
  }
  return null;
}

/**
 * Read a generated DocumentNode object literal back as GraphQL source.
 * Returns null when the expression isn't such a literal or when any
 * corner of it can't be evaluated statically.
 */
function typedDocumentSourceOf(node: Node): string | null {
  const inner = stripDocumentNodeCasts(node);
  if (!Node.isObjectLiteralExpression(inner)) {
    return null;
  }
  const evaluated = evaluateObjectLiteralAsJson(inner);
  if (evaluated === null || typeof evaluated !== "object") {
    return null;
  }
  const doc = evaluated as Record<string, unknown>;
  if (doc.kind !== "Document" || !Array.isArray(doc.definitions)) {
    return null;
  }
  try {
    return graphqlPrint(evaluated as unknown as GraphqlDocumentNode);
  } catch {
    // Malformed AST, so skip it rather than throw.
    return null;
  }
}

/**
 * Fallback for a TypedDocumentNode reference whose document body isn't a
 * statically-readable object literal (the generated document is produced
 * by a helper call, imported from an opaque module, etc.). Recovers the
 * operation header from the `TypedDocumentNode<Result, Vars>` cast's
 * first type argument, whose codegen name is `<OperationName><Kind>`
 * (e.g. `GetPetQuery`, `CreatePetMutation`, `OnTickSubscription`).
 *
 * Returns null when the argument isn't recognizable as a
 * TypedDocumentNode reference at all. When it IS recognizable, always
 * returns a resolution with `unresolved` set — the document body wasn't
 * read — carrying the header when the type argument was named.
 */
function resolveTypedDocumentHeader(arg: Node): DocumentResolution | null {
  if (!Node.isIdentifier(arg)) {
    return null;
  }
  const reference = arg.getText();
  const symbol = arg.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  const resolved = resolveAliasedSymbol(symbol) ?? symbol;
  for (const decl of resolved.getDeclarations()) {
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    if (init === undefined) {
      continue;
    }
    const typeArgs = documentNodeCastTypeArgs(init);
    if (typeArgs === null) {
      continue;
    }
    const header = operationHeaderFromResultType(typeArgs[0]);
    if (header !== null) {
      return {
        operationType: header.operationType,
        ...(header.operationName !== undefined
          ? { operationName: header.operationName }
          : {}),
        unresolved: {
          reference,
          reason:
            "document body not statically readable; operation header inferred from TypedDocumentNode type arguments",
        },
      };
    }
    return {
      unresolved: {
        reference,
        reason:
          "recognized as a TypedDocumentNode reference but neither the document body nor its type arguments were statically readable",
      },
    };
  }
  return null;
}

/**
 * Walk an `as ...` cast chain and return the type arguments of the first
 * `TypedDocumentNode<...>` / `DocumentNode<...>` reference found, or null
 * when the chain carries no such cast.
 */
function documentNodeCastTypeArgs(node: Node): Node[] | null {
  let current: Node = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    if (Node.isAsExpression(current)) {
      const typeNode = current.getTypeNode();
      if (typeNode !== undefined && Node.isTypeReference(typeNode)) {
        const name = typeNode.getTypeName().getText();
        const simpleName = name.includes(".")
          ? (name.split(".").pop() ?? name)
          : name;
        if (
          simpleName === "TypedDocumentNode" ||
          simpleName === "DocumentNode"
        ) {
          return typeNode.getTypeArguments();
        }
      }
    }
    current = current.getExpression();
  }
  return null;
}

/**
 * Derive the operation header from a codegen result-type reference named
 * `<OperationName><Kind>`. Returns operation type + name when the suffix
 * matches, operation type alone when the name is exactly the kind, and
 * null when the type argument isn't a named reference (inline object
 * type, missing, etc.).
 */
function operationHeaderFromResultType(
  typeNode: Node | undefined,
): { operationType: GraphqlOperationType; operationName?: string } | null {
  if (typeNode === undefined || !Node.isTypeReference(typeNode)) {
    return null;
  }
  const name = typeNode.getTypeName().getText();
  const suffixes: Array<[string, GraphqlOperationType]> = [
    ["Subscription", "subscription"],
    ["Mutation", "mutation"],
    ["Query", "query"],
  ];
  for (const [suffix, operationType] of suffixes) {
    if (name === suffix) {
      return { operationType };
    }
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return { operationType, operationName: name.slice(0, -suffix.length) };
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
