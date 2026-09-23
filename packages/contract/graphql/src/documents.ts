/**
 * Reads committed `.graphql` and `.gql` operation documents and writes one
 * client summary per operation, with no call site to trace. The document
 * text goes where the TypeScript adapter puts documents it finds in code,
 * so the checker's GraphQL pairing pass reads both the same way.
 *
 * Fragment spreads are inlined from every file read. The README describes
 * what happens to a spread that cannot be expanded.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type DefinitionNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type InlineFragmentNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  print,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";

import {
  graphqlOperationBinding,
  withGraphqlMetadata,
} from "@suss/behavioral-ir";

import { typeNodeToShape } from "./typeShape.js";

import type {
  BehavioralSummary,
  Gap,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

export interface GraphqlDocumentsOptions {
  /**
   * Recognition tag for the operation binding. Defaults to
   * `"graphql-documents"`, so findings can tell these operations apart
   * from operations found at a call site.
   */
  recognition?: string;
  /**
   * Transport recorded on the boundary binding. Defaults to
   * `"http-graphql"`, the same as the schema reader.
   */
  transport?: string;
  /**
   * The directory an anonymous operation's name is relative to, so the
   * name is the same on every machine. Without it the path is used as is.
   */
  rootDir?: string;
}

/** One document's text and the path it came from. */
export interface DocumentSource {
  /** Path recorded on each summary's `location.file`. */
  path: string;
  text: string;
}

/**
 * Converts documents already in memory into one summary per operation.
 * Fragments resolve across the whole set, so a file of fragments alone
 * contributes definitions but does not produce a summary.
 */
export function graphqlDocumentsToSummaries(
  sources: DocumentSource[],
  options: GraphqlDocumentsOptions = {},
): BehavioralSummary[] {
  const recognition = options.recognition ?? "graphql-documents";
  const transport = options.transport ?? "http-graphql";

  const parsed: { source: DocumentSource; doc: DocumentNode }[] = [];
  for (const source of sources) {
    const doc = safeParse(source.text);
    if (doc === null) {
      continue;
    }
    parsed.push({ source, doc });
  }

  const fragments = collectFragments(parsed);

  // Transition ids are built from the summary name, so a repeated name
  // would make two operations look like one.
  const takenNames = new Set<string>();

  const out: BehavioralSummary[] = [];
  for (const { source, doc } of parsed) {
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) {
        continue;
      }
      const name = distinctName(
        operationName(def, source.path, options.rootDir),
        takenNames,
      );
      out.push(
        buildOperationSummary(def, name, source.path, fragments, {
          recognition,
          transport,
        }),
      );
    }
  }
  return out;
}

/**
 * An anonymous operation is named after its file and operation type,
 * since nothing else tells two of them apart.
 */
function operationName(
  op: OperationDefinitionNode,
  file: string,
  rootDir: string | undefined,
): string {
  const declared = op.name?.value;
  if (declared !== undefined) {
    return declared;
  }
  return `${displayPath(file, rootDir)}:${op.operation}`;
}

function displayPath(file: string, rootDir: string | undefined): string {
  if (rootDir === undefined) {
    return file;
  }
  const relative = path.relative(rootDir, file);
  if (relative === "" || relative.startsWith("..")) {
    return file;
  }
  return relative.split(path.sep).join("/");
}

function distinctName(candidate: string, taken: Set<string>): string {
  let name = candidate;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${candidate}#${suffix}`;
    suffix += 1;
  }
  taken.add(name);
  return name;
}

/**
 * Reads `.graphql` and `.gql` files and converts them. A file that cannot
 * be read is skipped, so one bad path does not lose the rest.
 */
export function graphqlDocumentFilesToSummaries(
  filepaths: string[],
  options: GraphqlDocumentsOptions = {},
): BehavioralSummary[] {
  const sources: DocumentSource[] = [];
  for (const filepath of filepaths) {
    let text: string;
    try {
      text = fs.readFileSync(filepath, "utf8");
    } catch {
      continue;
    }
    sources.push({ path: filepath, text });
  }
  return graphqlDocumentsToSummaries(sources, options);
}

/**
 * Reads one document file, or every `.graphql` and `.gql` file under a
 * directory, skipping `node_modules`. Throws when nothing exists at the
 * path. `suss contract --from graphql-documents <path>` calls this.
 */
export function graphqlDocumentsPathToSummaries(
  specPath: string,
  options: GraphqlDocumentsOptions = {},
): BehavioralSummary[] {
  const absolute = path.resolve(specPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `No GraphQL documents found at "${specPath}". Pass a .graphql/.gql file or a directory containing them.`,
    );
  }
  const stat = fs.statSync(absolute);
  const isDirectory = stat.isDirectory();
  const files = isDirectory ? walkForDocuments(absolute) : [absolute];
  return graphqlDocumentFilesToSummaries(files, {
    rootDir: isDirectory ? absolute : path.dirname(absolute),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walkForDocuments(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (/\.(graphql|gql)$/.test(entry.name)) {
        out.push(full);
      }
    } else if (entry.isDirectory() && entry.name !== "node_modules") {
      out.push(...walkForDocuments(full));
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

interface BindingConfig {
  recognition: string;
  transport: string;
}

/**
 * The first definition in read order wins, so two runs over the same
 * files agree. A spread of a name in `competingFiles` gets a gap.
 */
interface FragmentIndex {
  definitions: Map<string, FragmentDefinitionNode>;
  competingFiles: Map<string, string[]>;
}

function collectFragments(
  parsed: { source: DocumentSource; doc: DocumentNode }[],
): FragmentIndex {
  const definitions = new Map<string, FragmentDefinitionNode>();
  const definingFiles = new Map<string, string[]>();
  for (const { source, doc } of parsed) {
    for (const def of doc.definitions) {
      if (def.kind !== Kind.FRAGMENT_DEFINITION) {
        continue;
      }
      const name = def.name.value;
      if (!definitions.has(name)) {
        definitions.set(name, def);
      }
      definingFiles.set(name, [
        ...(definingFiles.get(name) ?? []),
        source.path,
      ]);
    }
  }

  const competingFiles = new Map<string, string[]>();
  for (const [name, files] of definingFiles) {
    if (files.length > 1) {
      competingFiles.set(name, files);
    }
  }
  return { definitions, competingFiles };
}

function buildOperationSummary(
  op: OperationDefinitionNode,
  name: string,
  file: string,
  fragments: FragmentIndex,
  config: BindingConfig,
): BehavioralSummary {
  const operationType = op.operation;
  const operationName = op.name?.value;

  const unexpanded = emptyUnexpandedSpreads();
  const inlined = inlineSpreadsInOperation(op, fragments, unexpanded);
  const documentText = print(documentOf(inlined));
  const responseShape = selectionSetToShape(inlined.selectionSet);

  return {
    kind: "client",
    location: {
      file,
      range: { start: op.loc?.start ?? 0, end: op.loc?.end ?? 0 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: graphqlOperationBinding({
        transport: config.transport,
        recognition: config.recognition,
        operationType,
        ...(operationName !== undefined ? { operationName } : {}),
      }),
    },
    inputs: buildVariableInputs(op),
    transitions: buildTransitions(name, responseShape),
    gaps: unexpandedSpreadGaps(unexpanded, fragments),
    confidence: { source: "declared", level: "high" },
    metadata: withGraphqlMetadata(undefined, {
      document: documentText,
      ...(unexpanded.missing.size > 0
        ? { unresolvedFragments: [...unexpanded.missing].sort() }
        : {}),
    }),
  };
}

function buildVariableInputs(op: OperationDefinitionNode): Input[] {
  const variables = op.variableDefinitions ?? [];
  return variables.map<Input>((variable, index) => ({
    type: "parameter",
    name: variable.variable.name.value,
    position: index,
    // The TypeScript adapter gives an operation's `$variables` the same
    // role, so the checker treats both alike.
    role: "variable",
    shape: typeNodeToShape(variable.type),
  }));
}

function buildTransitions(
  name: string,
  responseShape: TypeShape,
): Transition[] {
  return [
    {
      id: `${name}:return:success`,
      conditions: [],
      output: { type: "return", value: responseShape },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: true,
      confidence: { source: "declared", level: "high" },
      metadata: {
        source: "graphql:operation.success",
      },
    },
    {
      id: `${name}:throw:error`,
      conditions: [
        {
          type: "opaque",
          sourceText: "graphql:operation-error",
          reason: "externalFunction",
        },
      ],
      output: {
        type: "throw",
        exceptionType: "GraphQLError",
        message: null,
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      confidence: { source: "declared", level: "low" },
      metadata: {
        source: "graphql:operation.error",
      },
    },
  ];
}

function unexpandedSpreadGaps(
  unexpanded: UnexpandedSpreads,
  fragments: FragmentIndex,
): Gap[] {
  const gaps: Gap[] = [];
  for (const name of [...unexpanded.missing].sort()) {
    gaps.push(
      // The fragment is probably defined in a file this reader was not
      // given.
      readingGap(
        `Fragment spread "...${name}" has no matching fragment definition in the read set; its selections are not part of this summary.`,
      ),
    );
  }
  for (const name of [...unexpanded.cyclic].sort()) {
    gaps.push(
      readingGap(
        `Fragment spread "...${name}" is part of a fragment cycle, which no server would execute; the repeated spread was left unexpanded.`,
      ),
    );
  }
  for (const name of [...unexpanded.ambiguous].sort()) {
    const files = fragments.competingFiles.get(name) ?? [];
    gaps.push(
      readingGap(
        `Fragment "${name}" is defined in more than one file (${files.join(", ")}); the first definition was used, so the selections here may not be the ones the build resolves.`,
      ),
    );
  }
  return gaps;
}

function readingGap(description: string): Gap {
  return {
    type: "unreadOutcome",
    conditions: [],
    consequence: "unknown",
    description,
  };
}

// ---------------------------------------------------------------------------
// Fragment inlining
// ---------------------------------------------------------------------------

/**
 * A spread that cannot be expanded stays in the document as written.
 * Dropping it could leave an empty selection set, which does not parse,
 * or turn a composite field into a leaf and change the operation.
 */
interface UnexpandedSpreads {
  missing: Set<string>;
  cyclic: Set<string>;
  ambiguous: Set<string>;
}

function emptyUnexpandedSpreads(): UnexpandedSpreads {
  return { missing: new Set(), cyclic: new Set(), ambiguous: new Set() };
}

function inlineSpreadsInOperation(
  op: OperationDefinitionNode,
  fragments: FragmentIndex,
  unexpanded: UnexpandedSpreads,
): OperationDefinitionNode {
  return {
    ...op,
    selectionSet: inlineSelectionSet(
      op.selectionSet,
      fragments,
      [],
      unexpanded,
    ),
  };
}

function inlineSelectionSet(
  selectionSet: SelectionSetNode,
  fragments: FragmentIndex,
  stack: string[],
  unexpanded: UnexpandedSpreads,
): SelectionSetNode {
  const out: SelectionNode[] = [];
  for (const selection of selectionSet.selections) {
    out.push(...inlineOneSelection(selection, fragments, stack, unexpanded));
  }
  return { ...selectionSet, selections: out };
}

function inlineOneSelection(
  selection: SelectionNode,
  fragments: FragmentIndex,
  stack: string[],
  unexpanded: UnexpandedSpreads,
): SelectionNode[] {
  if (selection.kind === Kind.FIELD) {
    if (selection.selectionSet === undefined) {
      return [selection];
    }
    const field: FieldNode = {
      ...selection,
      selectionSet: inlineSelectionSet(
        selection.selectionSet,
        fragments,
        stack,
        unexpanded,
      ),
    };
    return [field];
  }

  if (selection.kind === Kind.FRAGMENT_SPREAD) {
    const fragmentName = selection.name.value;
    if (fragments.competingFiles.has(fragmentName)) {
      unexpanded.ambiguous.add(fragmentName);
    }
    if (stack.includes(fragmentName)) {
      // A fragment cycle is invalid GraphQL. Stop here instead of looping.
      unexpanded.cyclic.add(fragmentName);
      return [selection];
    }
    const fragment = fragments.definitions.get(fragmentName);
    if (fragment === undefined) {
      unexpanded.missing.add(fragmentName);
      return [selection];
    }
    const inlined = inlineSelectionSet(
      fragment.selectionSet,
      fragments,
      [...stack, fragmentName],
      unexpanded,
    );
    return [...inlined.selections];
  }

  // An inline fragment keeps its node, because its type condition matters
  // on a union or interface.
  const inlineFragment: InlineFragmentNode = {
    ...selection,
    selectionSet: inlineSelectionSet(
      selection.selectionSet,
      fragments,
      stack,
      unexpanded,
    ),
  };
  return [inlineFragment];
}

function documentOf(op: OperationDefinitionNode): DocumentNode {
  const definitions: DefinitionNode[] = [op];
  return { kind: Kind.DOCUMENT, definitions };
}

// ---------------------------------------------------------------------------
// Selection set → response TypeShape
// ---------------------------------------------------------------------------

/**
 * Leaves are `unknown`, since only the schema has field types. Fields
 * under an inline fragment merge into the parent record, though without
 * the schema there is no telling whether they appear at run time.
 */
function selectionSetToShape(selectionSet: SelectionSetNode): TypeShape {
  const properties: Record<string, TypeShape> = {};
  mergeSelectionsInto(properties, selectionSet.selections);
  return { type: "record", properties };
}

function mergeSelectionsInto(
  properties: Record<string, TypeShape>,
  selections: readonly SelectionNode[],
): void {
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      const key = selection.alias?.value ?? selection.name.value;
      const selected: TypeShape =
        selection.selectionSet !== undefined
          ? selectionSetToShape(selection.selectionSet)
          : { type: "unknown" };
      // A server returns one object for a field selected both directly
      // and through a fragment, so the two shapes are merged.
      properties[key] = mergeShapes(properties[key], selected);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      mergeSelectionsInto(properties, selection.selectionSet.selections);
    }
    // A spread still here could not be expanded and already has a gap.
  }
}

/**
 * Two records for the same field merge their fields. Otherwise a record
 * wins over `unknown`, since a selection set gives more detail than a leaf.
 */
function mergeShapes(
  existing: TypeShape | undefined,
  incoming: TypeShape,
): TypeShape {
  if (existing === undefined) {
    return incoming;
  }

  if (existing.type === "record" && incoming.type === "record") {
    const properties = { ...existing.properties };
    for (const [key, shape] of Object.entries(incoming.properties)) {
      properties[key] = mergeShapes(properties[key], shape);
    }
    return { type: "record", properties };
  }

  if (existing.type === "record") {
    return existing;
  }

  return incoming;
}

function safeParse(text: string): DocumentNode | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}
