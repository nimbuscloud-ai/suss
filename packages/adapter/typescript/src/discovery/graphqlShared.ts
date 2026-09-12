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

import type {
  ImportDeclaration,
  Project,
  SourceFile,
  Symbol as TsSymbol,
} from "ts-morph";
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
  /**
   * Expressions part-way through being read as plain string text. A
   * string constant may interpolate another, so reaching one that is
   * already open means the constants interpolate each other and there is
   * no text to arrive at.
   */
  assembling: Set<Node>;
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
  /**
   * Where the tag of the document being assembled came from. The first
   * tag reached is the document's own; an interpolated document's tag
   * says nothing about how the outer one is built.
   */
  tagOrigin: DocumentTagOrigin | null;
}

function startAssembly(
  resolution: ResolutionStore | undefined,
): DocumentAssembly {
  return {
    resolution,
    seen: new Set(),
    assembling: new Set(),
    unresolvedInterpolations: [],
    unresolvedInsideSelection: false,
    tagOrigin: null,
  };
}

/**
 * The text a template literal gives once every `${...}` is spliced.
 * A substitution that resolves to a document contributes its text in
 * place; one that does not is dropped and recorded on the assembly, at
 * top level as a lost fragment definition and inside a selection set
 * as a lost selection.
 *
 * `openDepth` is how many selection sets were already open where this
 * template was written. It is zero for a document, which starts at the
 * top level, and it is the depth at the interpolation point for a plain
 * string spliced as text, which continues the document around it.
 */
function assembledTemplateText(
  template: Node,
  assembly: DocumentAssembly,
  openDepth = 0,
): string | null {
  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    return innerTemplateText(template);
  }
  if (!Node.isTemplateExpression(template)) {
    return null;
  }
  let text = template.getHead().getLiteralText();
  for (const span of template.getTemplateSpans()) {
    const depth = openDepth + openBraceDepth(text);
    const spliced = interpolatedDocumentText(
      span.getExpression(),
      assembly,
      depth,
    );
    if (spliced === null) {
      assembly.unresolvedInterpolations.push(
        singleLine(span.getExpression().getText()),
      );
      if (depth > 0) {
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
 * TypedDocumentNode literal. Failing all of those, a plain string, whose
 * text becomes part of the document the way it is written. Anything else
 * returns null and the caller records the expression as unresolved
 * rather than guessing.
 *
 * The plain string comes last so a tagged template is read as the
 * document it is rather than as the text inside it.
 */
function interpolatedDocumentText(
  expr: Node,
  assembly: DocumentAssembly,
  openDepth: number,
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
  const fromFacts = resolveThroughFacts(stripped, assembly);
  if (fromFacts !== null) {
    return fromFacts;
  }
  return plainStringText(stripped, assembly, openDepth);
}

/**
 * The text a plain string contributes where it is interpolated. A
 * project that shares a field list between operations writes it as a
 * string rather than as a fragment, and at run time the template
 * evaluates to the surrounding document with that text in it, so
 * splicing the text is reading what the operation sends. Whether the
 * result is GraphQL the schema accepts is left to the parse that already
 * runs on the assembled document.
 *
 * Returns null when the expression is already being read, which is
 * where a pair of constants that interpolate each other ends up.
 */
function plainStringText(
  expr: Node,
  assembly: DocumentAssembly,
  openDepth: number,
): string | null {
  if (assembly.assembling.has(expr)) {
    return null;
  }
  assembly.assembling.add(expr);
  const text = writtenStringText(expr, assembly, openDepth);
  assembly.assembling.delete(expr);
  return text;
}

/**
 * A plain string is a string literal, a template literal with no
 * substitutions, or a template expression assembled the same way a
 * document is, so a substitution inside it that is itself a document
 * splices as one and a substitution nobody can read is recorded on the
 * assembly. A name goes to the fact layer for the expression it is
 * written as, the way a document constant does; a name with no store
 * behind it, or one the store cannot settle on a single write, has no
 * written text here.
 */
function writtenStringText(
  expr: Node,
  assembly: DocumentAssembly,
  openDepth: number,
): string | null {
  if (Node.isStringLiteral(expr)) {
    return expr.getLiteralValue();
  }
  if (
    Node.isNoSubstitutionTemplateLiteral(expr) ||
    Node.isTemplateExpression(expr)
  ) {
    return assembledTemplateText(expr, assembly, openDepth);
  }
  if (assembly.resolution === undefined || !Node.isIdentifier(expr)) {
    return null;
  }
  const written = assembly.resolution.resolveWrittenValue(expr);
  if (written === null) {
    return null;
  }
  return plainStringText(stripDocumentNodeCasts(written), assembly, openDepth);
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
  /**
   * Spreads in `document` the project defines more than once, with
   * different bodies. Which one a build picks is not something the
   * reader can say, so none of them is used and the name stays in
   * `unresolvedFragments` too.
   */
  ambiguousFragments?: string[];
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
  const spreads = fragmentSpreadsIn(text);
  if (spreads === null) {
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
  const filled = fillDanglingSpreads(text, spreads, arg, assembly);
  if (filled.unresolved.length > 0) {
    return {
      document: filled.text,
      unresolvedFragments: filled.unresolved,
      ...(filled.ambiguous.length > 0
        ? { ambiguousFragments: filled.ambiguous }
        : {}),
    };
  }
  if (interpolations.length > 0) {
    return {
      document: filled.text,
      unresolved: {
        reference: singleLine(arg.getText()),
        reason: `interpolated ${describeInterpolations(interpolations)} did not resolve to a GraphQL document, so whatever it contributes is not part of the stored document`,
      },
    };
  }
  return { document: filled.text };
}

/** A document and the spreads in it still without a definition. */
interface FilledDocument {
  text: string;
  unresolved: string[];
  ambiguous: string[];
}

/**
 * Give a build-time assembled document a definition for each spread in
 * it, out of the fragments the project writes elsewhere. A document a
 * library's tag sends as written gets nothing: whatever its template
 * does not define is dangling at run time, which is what the spreads
 * left over say.
 *
 * An appended fragment brings the spreads it makes with it, so this
 * goes on until there are none left to look up. A name already in the
 * document, appended or unresolved is settled, which is what stops a
 * cycle between two fragments that spread each other.
 */
function fillDanglingSpreads(
  text: string,
  spreads: FragmentSpreads,
  arg: Node,
  assembly: DocumentAssembly,
): FilledDocument {
  if (spreads.dangling.length === 0 || assembly.tagOrigin !== "project") {
    return { text, unresolved: spreads.dangling, ambiguous: [] };
  }
  const definitions = projectFragmentDefinitions(arg.getProject());
  const settled = new Set<string>(spreads.defined);
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  let filled = text;
  let pending = spreads.dangling;
  while (pending.length > 0) {
    const brought: string[] = [];
    for (const name of pending) {
      if (settled.has(name) || unresolved.has(name)) {
        continue;
      }
      const definition = definitions.get(name);
      if (definition === undefined) {
        unresolved.add(name);
        continue;
      }
      if (definition === null) {
        unresolved.add(name);
        ambiguous.add(name);
        continue;
      }
      filled += `\n\n${definition.text}`;
      settled.add(name);
      brought.push(...definition.spreads);
    }
    pending = brought;
  }
  return {
    text: filled,
    unresolved: [...unresolved].sort(),
    ambiguous: [...ambiguous].sort(),
  };
}

/** One fragment definition, ready to append to a document. */
interface IndexedFragment {
  /** The definition as printed GraphQL. */
  text: string;
  /** The fragments it spreads, which have to be appended with it. */
  spreads: string[];
}

/**
 * Every fragment the project defines, by name. A `null` value means two
 * documents define that name differently.
 */
type FragmentDefinitions = ReadonlyMap<string, IndexedFragment | null>;

interface CachedFragmentIndex {
  definitions: FragmentDefinitions;
  /** What the project looked like when this index was built. */
  signature: string;
}

const fragmentIndexes = new WeakMap<Project, CachedFragmentIndex>();

/** No fragment is defined in a file that never writes the word. */
const FRAGMENT_DEFINITION_TEXT = /\bfragment\s+\w+\s+on\b/;

/**
 * The project's fragment definitions, built on the first document that
 * needs one and kept for the rest of the run. A run adds source files
 * as it follows imports, so an index built before that is rebuilt.
 */
function projectFragmentDefinitions(project: Project): FragmentDefinitions {
  const signature = projectSignature(project);
  const cached = fragmentIndexes.get(project);
  if (cached !== undefined && cached.signature === signature) {
    return cached.definitions;
  }
  const definitions = buildFragmentIndex(project);
  fragmentIndexes.set(project, { definitions, signature });
  return definitions;
}

/**
 * Enough of the project to tell one state of it from another without
 * reading a file: how many source files there are and how much text
 * they come to.
 */
function projectSignature(project: Project): string {
  let files = 0;
  let characters = 0;
  for (const sourceFile of project.getSourceFiles()) {
    files += 1;
    characters += sourceFile.getEnd();
  }
  return `${files}:${characters}`;
}

function buildFragmentIndex(project: Project): FragmentDefinitions {
  const definitions = new Map<string, IndexedFragment | null>();
  const sourceFiles = [...project.getSourceFiles()]
    .filter(
      (sourceFile) =>
        !sourceFile.isInNodeModules() && !sourceFile.isDeclarationFile(),
    )
    .sort((left, right) =>
      left.getFilePath().localeCompare(right.getFilePath()),
    );
  for (const sourceFile of sourceFiles) {
    // The text test comes first because this runs over every file the
    // project has, and walking the AST of each is the expensive half.
    if (!FRAGMENT_DEFINITION_TEXT.test(sourceFile.getFullText())) {
      continue;
    }
    for (const text of documentTextsIn(sourceFile)) {
      recordFragmentDefinitions(text, definitions);
    }
  }
  for (const text of graphqlFileTextsNear(sourceFiles)) {
    recordFragmentDefinitions(text, definitions);
  }
  return definitions;
}

/**
 * What the `.graphql` and `.gql` files beside the source say. Codegen
 * scans them for documents the same way it scans the TypeScript, so a
 * fragment written in one is a fragment the build can put into any
 * document that spreads it.
 */
function graphqlFileTextsNear(
  sourceFiles: ReadonlyArray<SourceFile>,
): string[] {
  const roots = [
    ...new Set(
      sourceFiles.map((sourceFile) => path.dirname(sourceFile.getFilePath())),
    ),
  ].sort();
  const texts: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of [...entries].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isFile() && /\.(graphql|gql)$/.test(entry.name)) {
        try {
          texts.push(fs.readFileSync(path.join(root, entry.name), "utf8"));
        } catch {
          // A file the run cannot read says nothing either way.
        }
      }
    }
  }
  return texts;
}

/**
 * Each document written out as a tag in one file, assembled. Every
 * position counts: a client-preset codebase often writes a fragment as
 * a bare `gql(...)` statement assigned to nothing, since codegen finds
 * it by reading the file rather than by following an import.
 */
function documentTextsIn(sourceFile: SourceFile): string[] {
  const texts: string[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      !Node.isTaggedTemplateExpression(node) &&
      !Node.isCallExpression(node)
    ) {
      return;
    }
    const text = documentTextFromExpression(node, startAssembly(undefined));
    if (text !== null && text !== "") {
      texts.push(text);
    }
  });
  return texts;
}

function recordFragmentDefinitions(
  text: string,
  definitions: Map<string, IndexedFragment | null>,
): void {
  let doc: GraphqlDocumentNode;
  try {
    doc = graphqlParse(text);
  } catch {
    return;
  }
  for (const definition of doc.definitions) {
    if (definition.kind !== GraphqlKind.FRAGMENT_DEFINITION) {
      continue;
    }
    const name = definition.name.value;
    const printed = graphqlPrint(definition);
    const found = definitions.get(name);
    if (found === undefined) {
      const spreads = new Set<string>();
      collectDanglingSpreads(definition.selectionSet, NO_NAMES, spreads);
      definitions.set(name, { text: printed, spreads: [...spreads] });
      continue;
    }
    if (found?.text !== printed) {
      definitions.set(name, null);
    }
  }
}

/** Nothing is defined here, so every spread counts as one to collect. */
const NO_NAMES: ReadonlySet<string> = new Set();

function describeInterpolations(interpolations: string[]): string {
  const quoted = interpolations.map((text) => `\`${text}\``).join(", ");
  return interpolations.length === 1
    ? `expression ${quoted}`
    : `expressions ${quoted}`;
}

/** What one document says about fragments. */
interface FragmentSpreads {
  /** The fragments the document defines. */
  defined: ReadonlySet<string>;
  /** The spreads in it with no definition there, sorted so two runs agree. */
  dangling: string[];
}

/**
 * The fragments `text` defines and the spreads it leaves dangling, or
 * null when the text does not parse.
 */
function fragmentSpreadsIn(text: string): FragmentSpreads | null {
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
  return { defined, dangling: [...dangling].sort() };
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
    assembly.tagOrigin ??= documentTagOrigin(node.getTag());
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
  assembly.tagOrigin ??= documentTagOrigin(node.getExpression());
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
 * Where a document tag came from, which decides what a bare fragment
 * spread in its template means.
 *
 * A tag a library exports parses the template as written and sends
 * that, so a spread the template does not define is dangling when the
 * query runs unless a fragment registry supplies it. A tag the project
 * generates (graphql-codegen's client preset writes one) is a build
 * step: it finds the fragment by name among the documents the project
 * writes and puts the definition in the document it emits, so the same
 * spread is resolved before anything is sent.
 */
type DocumentTagOrigin = "project" | "library";

/**
 * Which of the two a tag is. A tag with no import behind it (a bare
 * `gql`) is read as a library's, since that is what the name means
 * everywhere it appears without one.
 */
function documentTagOrigin(tag: Node): DocumentTagOrigin {
  const symbol = tag.getSymbol();
  if (symbol === undefined) {
    return "library";
  }
  const importDeclaration = importCarrying(symbol);
  if (importDeclaration === null) {
    return originOf(declarationFileOf(symbol));
  }
  // Through the alias chain, so a project module that passes a
  // library's tag along is still that library's.
  const target = declarationFileOf(resolveAliasedSymbol(symbol));
  if (target !== null) {
    return originOf(target);
  }
  // The import resolves to nothing, which is the usual state of the
  // generated directory: it is gitignored, so a fresh checkout has only
  // the specifier to go on.
  return isProjectSpecifier(importDeclaration) ? "project" : "library";
}

function originOf(declaredIn: SourceFile | null): DocumentTagOrigin {
  return declaredIn === null || declaredIn.isInNodeModules()
    ? "library"
    : "project";
}

/** The file a name is written in, past the imports that carry it. */
function declarationFileOf(symbol: TsSymbol | undefined): SourceFile | null {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (importDeclarationAround(declaration) === null) {
      return declaration.getSourceFile();
    }
  }
  return null;
}

/** The import a name came in through, or null when it is written here. */
function importCarrying(symbol: TsSymbol): ImportDeclaration | null {
  for (const declaration of symbol.getDeclarations()) {
    const importDeclaration = importDeclarationAround(declaration);
    if (importDeclaration !== null) {
      return importDeclaration;
    }
  }
  return null;
}

/** The `import ... from "..."` a declaration is part of, if it is one. */
function importDeclarationAround(declaration: Node): ImportDeclaration | null {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.getImportDeclaration();
  }
  if (!Node.isImportClause(declaration)) {
    return null;
  }
  const parent = declaration.getParent();
  return Node.isImportDeclaration(parent) ? parent : null;
}

/**
 * Whether a module specifier points at a module of the project rather
 * than at a package: a relative or absolute path, the `~` root
 * convention, or anything an alias in the project's
 * `compilerOptions.paths` covers.
 */
function isProjectSpecifier(importDeclaration: ImportDeclaration): boolean {
  const specifier = importDeclaration.getModuleSpecifierValue();
  if (/^[./~]/.test(specifier)) {
    return true;
  }
  const aliases = importDeclaration.getProject().getCompilerOptions().paths;
  for (const alias of Object.keys(aliases ?? {})) {
    if (aliasCovers(alias, specifier)) {
      return true;
    }
  }
  return false;
}

/** Whether a `paths` key such as `@app/*` covers a written specifier. */
function aliasCovers(alias: string, specifier: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`).test(specifier);
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
  /** Spreads the project defines more than once, with different bodies. */
  ambiguousFragments?: string[];
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
      ...(resolution.ambiguousFragments !== undefined
        ? { ambiguousFragments: resolution.ambiguousFragments }
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
 * text as the reference, so the gap says which call to go look at. A
 * caller that knows more about why supplies its own `reason`.
 */
export function unreadableDocument(
  arg: Node,
  reason?: string,
): DocumentResolution {
  return {
    unresolved: {
      reference: singleLine(stripDocumentNodeCasts(arg).getText()),
      reason:
        reason ??
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
