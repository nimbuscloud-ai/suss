// Read committed `.graphql` / `.gql` operation documents and emit one
// client-kind summary per operation, without tracing any call site.
//
// Each query / mutation / subscription definition becomes a summary
// with a `graphql-operation` boundary binding (operationType,
// operationName), inputs from the operation's variable definitions,
// and the full document text at `metadata.graphql.document`, the same
// place the TypeScript adapter puts documents it recovers from client
// call sites, so the checker's GraphQL pairing pass reads both the
// same way.
//
// Fragment spreads are resolved against every fragment definition in
// the read set and inlined into the stored document, so the pairing
// pass sees the selected fields directly. A spread the reader cannot
// expand stays in the document as written and becomes a gap on the
// summary, not a crash.

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

import { graphqlOperationBinding } from "@suss/behavioral-ir";

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
   * `"graphql-documents"` so findings distinguish document-derived
   * operations from call-site-traced ones.
   */
  recognition?: string;
  /**
   * Transport to record on the boundary binding. Defaults to
   * `"http-graphql"` to match the schema reader's resolver side.
   */
  transport?: string;
}

/** One parsed source document, tagged with where it came from. */
export interface DocumentSource {
  /** Path recorded on each summary's `location.file`. */
  path: string;
  /** Raw document text. */
  text: string;
}

/**
 * Convert in-memory operation documents into summaries. Fragments are
 * resolved across the whole set, so a fragment-only document
 * contributes definitions without producing summaries of its own.
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

  const out: BehavioralSummary[] = [];
  for (const { source, doc } of parsed) {
    for (const def of doc.definitions) {
      if (def.kind !== Kind.OPERATION_DEFINITION) {
        continue;
      }
      out.push(
        buildOperationSummary(def, source.path, fragments, {
          recognition,
          transport,
        }),
      );
    }
  }
  return out;
}

/**
 * Read `.graphql` / `.gql` files from disk and convert them to
 * summaries. Unreadable files are skipped, so one bad path does not
 * lose the rest of the set.
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
 * Accept either a single document file or a directory to walk
 * recursively for `.graphql` / `.gql` files. Entry point for the
 * CLI's `suss contract --from graphql-documents <path>`.
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
  const files = stat.isDirectory() ? walkForDocuments(absolute) : [absolute];
  return graphqlDocumentFilesToSummaries(files, options);
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
 * The fragment definitions of the whole read set, keyed by name, plus
 * the names that more than one file defines. The first definition in
 * read order wins so that two runs over the same files agree, and any
 * operation that spreads a contested name carries a gap saying the
 * choice was ambiguous.
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
  file: string,
  fragments: FragmentIndex,
  config: BindingConfig,
): BehavioralSummary {
  const operationType = op.operation;
  const operationName = op.name?.value;
  const name = operationName ?? `${path.basename(file)}:${operationType}`;

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
    metadata: {
      graphql: {
        document: documentText,
        ...(unexpanded.missing.size > 0
          ? { unresolvedFragments: [...unexpanded.missing].sort() }
          : {}),
      },
    },
  };
}

function buildVariableInputs(op: OperationDefinitionNode): Input[] {
  const variables = op.variableDefinitions ?? [];
  return variables.map<Input>((variable, index) => ({
    type: "parameter",
    name: variable.variable.name.value,
    position: index,
    // Same role the TypeScript adapter stamps on operation-header
    // `$variables`, so downstream consumers treat both alike.
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
      // A statement about the reading, not the code: the fragment
      // likely exists somewhere outside the files handed to this
      // reader.
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
 * Spreads the reader could not expand, by reason. A spread in any of
 * these sets stays in the document exactly as it was written: dropping
 * it would leave behind either an empty selection set, which does not
 * parse, or a composite field printed as a leaf, which is a different
 * operation from the one on disk.
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
      // Fragment cycle: invalid GraphQL, but a reader should not loop
      // on it.
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

  // Inline fragment: keep the node (its type condition matters for
  // unions / interfaces) and resolve spreads within it.
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
 * Approximate the response shape from the selection set alone: field
 * names become record properties; leaves are `unknown` because the
 * document does not declare field types (the schema does). Fields
 * behind an inline fragment's type condition merge into the parent
 * record. They may or may not appear at runtime, and without the
 * schema the reader cannot tell which.
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
      // The same field can be selected twice, once in the operation
      // and once through a fragment. A server merges those selections
      // and returns one object with both sets of fields, so the shape
      // has to merge them too.
      properties[key] = mergeShapes(properties[key], selected);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      mergeSelectionsInto(properties, selection.selectionSet.selections);
    }
    // Fragment spreads were already inlined; any survivor was
    // unresolvable and is recorded as a gap.
  }
}

/**
 * Combine two shapes read for the same field. Two records become one
 * record holding both field sets. Otherwise the record wins over an
 * `unknown`, because a selection set says more than a leaf does.
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
