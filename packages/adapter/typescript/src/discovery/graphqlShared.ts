// graphqlShared.ts: helpers shared by GraphQL discovery handlers
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
  type SelectionSetNode as GraphqlSelectionSetNode,
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
 * say which module the way it says which module a transparent wrapper uses.
 */
const DOCUMENT_TAGS = new Set(["gql", "graphql"]);

/**
 * The one tag name taken at face value without checking where it came
 * from. `gql` marks a GraphQL document across every client library and
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
 * Returns null for any parse failure: the adapter keeps moving
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
 * stub-appsync uses for consistency: both packages feed
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
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * State carried through assembling one document out of a template and
 * its `${...}` interpolations. An interpolated fragment can itself
 * interpolate another, so assembly recurses; `seen` makes a document
 * splice at most once, which also stops a cycle between two fragments
 * that interpolate each other.
 */
interface DocumentAssembly {
  resolution: ResolutionStore | undefined;
  /** Tagged templates (or tag calls) already spliced into this document. */
  seen: Set<Node>;
  /** Written text of each `${...}` that resolved to no document. */
  unresolvedInterpolations: string[];
  /**
   * Set when an unresolved `${...}` was written inside a selection
   * set, where dropping it would change what the operation itself
   * selects. At top level a dropped interpolation can only cost
   * fragment definitions, and the spreads left dangling record
   * exactly which.
   */
  unresolvedInsideSelection: boolean;
}

function startAssembly(
  resolution: ResolutionStore | undefined,
): DocumentAssembly {
  return {
    resolution,
    seen: new Set(),
    unresolvedInterpolations: [],
    unresolvedInsideSelection: false,
  };
}

/**
 * The text a template literal gives once every `${...}` is spliced.
 * A substitution that resolves to a document contributes its text in
 * place; one that does not is dropped and recorded on the assembly, at
 * top level as a lost fragment definition and inside a selection set
 * as a lost selection.
 */
function assembledTemplateText(
  template: Node,
  assembly: DocumentAssembly,
): string | null {
  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    return innerTemplateText(template);
  }
  if (!Node.isTemplateExpression(template)) {
    return null;
  }
  let text = template.getHead().getLiteralText();
  for (const span of template.getTemplateSpans()) {
    const spliced = interpolatedDocumentText(span.getExpression(), assembly);
    if (spliced === null) {
      assembly.unresolvedInterpolations.push(
        singleLine(span.getExpression().getText()),
      );
      if (openBraceDepth(text) > 0) {
        assembly.unresolvedInsideSelection = true;
      }
    } else {
      text += `\n${spliced}\n`;
    }
    text += span.getLiteral().getLiteralText();
  }
  return text;
}

/**
 * How many selection sets are open at the end of `text`. Counted over
 * braces because at an interpolation point the document does not parse
 * yet, and GraphQL gives braces no other role a gql template would use.
 */
function openBraceDepth(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * The document text an interpolated `${...}` expression contributes:
 * an inline gql tag, a named document constant (same module, imported,
 * or behind a barrel), a `.graphql` file import, or a generated
 * TypedDocumentNode literal. Anything else returns null and the caller
 * records the expression as unresolved rather than guessing.
 */
function interpolatedDocumentText(
  expr: Node,
  assembly: DocumentAssembly,
): string | null {
  const stripped = stripDocumentNodeCasts(expr);
  const inline = documentTextFromExpression(stripped, assembly);
  if (inline !== null) {
    return inline;
  }
  const named = resolveGqlTemplateText(stripped, assembly);
  if (named !== null) {
    return named;
  }
  const objectDoc = resolveTypedDocumentSource(stripped);
  if (objectDoc !== null) {
    return objectDoc;
  }
  return resolveThroughFacts(stripped, assembly);
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
  /**
   * Fragment spreads in `document` with no definition in it. Their
   * selections went unread, so the document is partial rather than
   * wrong, and the summary says so.
   */
  unresolvedFragments?: string[];
  unresolved?: { reference: string; reason: string };
}

/**
 * Resolve a hook / imperative call argument to a GraphQL document.
 * A template's `${...}` interpolations resolve through the same ladder
 * and splice in, which is how Apollo codebases compose fragments into
 * operations.
 *
 * Tries, in order:
 *
 *   `useQuery(gql\`query ...\`)`
 *       an inline gql tag.
 *   `useQuery(gql(\`query ...\`))`
 *       an inline tag call, which is how graphql-codegen's client
 *       preset is written.
 *   `useQuery(GET_USER)`
 *       a named constant set to either, in this module or in another
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
  const assembly = startAssembly(resolution);
  // Peel `FooDocument as DocumentNode` / parenthesization at the call
  // site so the underlying identifier or tagged template is reached.
  const stripped = stripDocumentNodeCasts(arg);
  const text =
    documentTextFromExpression(stripped, assembly) ??
    resolveGqlTemplateText(stripped, assembly) ??
    resolveTypedDocumentSource(stripped) ??
    resolveThroughFacts(stripped, assembly);
  if (text !== null) {
    return assembledDocumentResolution(text, stripped, assembly);
  }
  return resolveTypedDocumentHeader(stripped);
}

/**
 * Turn assembled document text into a resolution. An interpolation
 * dropped inside a selection set means the operation's own selections
 * are not all written, so no document is claimed and the boundary
 * degrades to a header plus the reason. A document that parses keeps
 * its dangling spreads beside it as `unresolvedFragments`.
 */
function assembledDocumentResolution(
  text: string,
  arg: Node,
  assembly: DocumentAssembly,
): DocumentResolution {
  const interpolations = assembly.unresolvedInterpolations;
  if (assembly.unresolvedInsideSelection) {
    const header = parseGraphqlOperation(text);
    return {
      ...(header !== null ? { operationType: header.operationType } : {}),
      ...(header?.operationName !== undefined
        ? { operationName: header.operationName }
        : {}),
      unresolved: {
        reference: singleLine(arg.getText()),
        reason: `interpolated ${describeInterpolations(interpolations)} inside a selection set did not resolve to a GraphQL document, so what the operation selects is not statically written`,
      },
    };
  }
  const dangling = danglingFragmentSpreads(text);
  if (dangling === null) {
    if (interpolations.length === 0) {
      // Unparseable text with nothing dropped is what the reader found;
      // hand it through unchanged and let the caller's parse decide.
      return { document: text };
    }
    return {
      unresolved: {
        reference: singleLine(arg.getText()),
        reason: `the document did not parse after dropping interpolated ${describeInterpolations(interpolations)} that resolved to no GraphQL document`,
      },
    };
  }
  if (dangling.length > 0) {
    return { document: text, unresolvedFragments: dangling };
  }
  if (interpolations.length > 0) {
    return {
      document: text,
      unresolved: {
        reference: singleLine(arg.getText()),
        reason: `interpolated ${describeInterpolations(interpolations)} did not resolve to a GraphQL document, so whatever it contributes is not part of the stored document`,
      },
    };
  }
  return { document: text };
}

function describeInterpolations(interpolations: string[]): string {
  const quoted = interpolations.map((text) => `\`${text}\``).join(", ");
  return interpolations.length === 1
    ? `expression ${quoted}`
    : `expressions ${quoted}`;
}

/**
 * Fragment spreads in `text` with no matching definition in it, or
 * null when the text does not parse. Sorted so two runs agree.
 */
function danglingFragmentSpreads(text: string): string[] | null {
  let doc: GraphqlDocumentNode;
  try {
    doc = graphqlParse(text);
  } catch {
    return null;
  }
  const defined = new Set<string>();
  for (const def of doc.definitions) {
    if (def.kind === GraphqlKind.FRAGMENT_DEFINITION) {
      defined.add(def.name.value);
    }
  }
  const dangling = new Set<string>();
  for (const def of doc.definitions) {
    if (
      def.kind === GraphqlKind.OPERATION_DEFINITION ||
      def.kind === GraphqlKind.FRAGMENT_DEFINITION
    ) {
      collectDanglingSpreads(def.selectionSet, defined, dangling);
    }
  }
  return [...dangling].sort();
}

function collectDanglingSpreads(
  selectionSet: GraphqlSelectionSetNode,
  defined: ReadonlySet<string>,
  dangling: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === GraphqlKind.FRAGMENT_SPREAD) {
      if (!defined.has(selection.name.value)) {
        dangling.add(selection.name.value);
      }
      continue;
    }
    if (selection.selectionSet !== undefined) {
      collectDanglingSpreads(selection.selectionSet, defined, dangling);
    }
  }
}

/**
 * The document text an expression gives when it is written out as a
 * tag: `gql\`...\`` or `gql(\`...\`)`. Returns null for anything else,
 * including a tag call whose argument is built rather than written. A
 * document already spliced into this assembly contributes nothing more,
 * so a fragment two operations both interpolate appears once.
 */
function documentTextFromExpression(
  node: Node,
  assembly: DocumentAssembly,
): string | null {
  if (Node.isTaggedTemplateExpression(node)) {
    if (!isDocumentTag(node.getTag())) {
      return null;
    }
    if (assembly.seen.has(node)) {
      return "";
    }
    assembly.seen.add(node);
    return assembledTemplateText(node.getTemplate(), assembly);
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
  if (assembly.seen.has(node)) {
    return "";
  }
  assembly.seen.add(node);
  return assembledTemplateText(template, assembly);
}

/**
 * Whether an expression is a GraphQL document tag. `import { gql as
 * apolloGql }` is a name the file chose, so when there is an export name
 * that is the one to check.
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
 * read the result as a document. This is what covers a document kept in
 * a named constant: the syntactic walks above follow one variable
 * declaration, and production code puts the document behind an alias, a
 * re-export barrel, or a module the consumer only imports from.
 *
 * The fact layer gives back an expression and no opinion about what it
 * is. Recognizing a tag call as a document is GraphQL's business, so it
 * happens here rather than in the rules.
 */
function resolveThroughFacts(
  arg: Node,
  assembly: DocumentAssembly,
): string | null {
  if (assembly.resolution === undefined || !Node.isIdentifier(arg)) {
    return null;
  }
  const written = assembly.resolution.resolveWrittenValue(arg);
  if (written === null) {
    return null;
  }
  const text = documentTextFromExpression(written, assembly);
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
  /** Spreads in `document` with no definition in it: read partially. */
  unresolvedFragments?: string[];
  unresolved?: { reference: string; reason: string };
}

/**
 * Turn a document resolution into the operation info a discovered unit
 * gets. A readable body is parsed for the full shape; an anonymous
 * operation (`gql\`{ ... }\``, which graphql-js parses as a query by
 * default) takes its type from the call shape (the hook or imperative
 * method). A header-only or unresolvable resolution falls back to the
 * call-shape type and takes the gap through with it. Returns null only when a
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
    return {
      ...operation,
      operationType,
      document: resolution.document,
      ...(resolution.unresolvedFragments !== undefined
        ? { unresolvedFragments: resolution.unresolvedFragments }
        : {}),
      ...(resolution.unresolved !== undefined
        ? { unresolved: resolution.unresolved }
        : {}),
    };
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
 * are the ImportSpecifier, which has no initializer); the fallback
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
 * template literal: inline, const-bound (same or cross module), or
 * imported from a `.graphql` / `.gql` file. Files that don't exist on
 * disk (common under `useInMemoryFileSystem` test projects) fall back
 * to null rather than throwing: discovery stays advisory, not punitive.
 */
export function resolveGqlTemplateText(
  arg: Node,
  assembly: DocumentAssembly,
): string | null {
  const direct = documentTextFromExpression(arg, assembly);
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
  // declaration: the aliased symbol points at a synthetic module with
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
    const text = documentTextFromExpression(
      stripDocumentNodeCasts(init),
      assembly,
    );
    if (text !== null) {
      return text;
    }
  }
  return null;
}

/**
 * Resolve an argument that's a TypedDocumentNode reference: the
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
 * returns a resolution with `unresolved` set: the document body wasn't
 * read: but with the header filled in when the type argument was given.
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
 * when the chain has no such cast.
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
 * The caller decides how to handle a partial parse: this helper is
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
