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
// pass sees the selected fields directly. A spread whose fragment is
// not in the read set becomes a gap on the summary, not a crash.

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

  const fragments = collectFragments(parsed.map((p) => p.doc));

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

function collectFragments(
  docs: DocumentNode[],
): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const doc of docs) {
    for (const def of doc.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def);
      }
    }
  }
  return fragments;
}

function buildOperationSummary(
  op: OperationDefinitionNode,
  file: string,
  fragments: Map<string, FragmentDefinitionNode>,
  config: BindingConfig,
): BehavioralSummary {
  const operationType = op.operation;
  const operationName = op.name?.value;
  const name = operationName ?? `${path.basename(file)}:${operationType}`;

  const unresolved = new Set<string>();
  const inlined = inlineSpreadsInOperation(op, fragments, unresolved);
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
    gaps: [...unresolved].map((fragmentName) =>
      unresolvedFragmentGap(fragmentName),
    ),
    confidence: { source: "declared", level: "high" },
    metadata: {
      graphql: {
        document: documentText,
        ...(unresolved.size > 0
          ? { unresolvedFragments: [...unresolved].sort() }
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

function unresolvedFragmentGap(fragmentName: string): Gap {
  return {
    // A statement about the reading, not the code: the fragment likely
    // exists somewhere outside the files handed to this reader.
    type: "unreadOutcome",
    conditions: [],
    consequence: "unknown",
    description: `Fragment spread "...${fragmentName}" has no matching fragment definition in the read set; its selections are not part of this summary.`,
  };
}

// ---------------------------------------------------------------------------
// Fragment inlining
// ---------------------------------------------------------------------------

function inlineSpreadsInOperation(
  op: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
  unresolved: Set<string>,
): OperationDefinitionNode {
  return {
    ...op,
    selectionSet: inlineSelectionSet(
      op.selectionSet,
      fragments,
      [],
      unresolved,
    ),
  };
}

function inlineSelectionSet(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  stack: string[],
  unresolved: Set<string>,
): SelectionSetNode {
  const out: SelectionNode[] = [];
  for (const selection of selectionSet.selections) {
    out.push(...inlineOneSelection(selection, fragments, stack, unresolved));
  }
  return { ...selectionSet, selections: out };
}

function inlineOneSelection(
  selection: SelectionNode,
  fragments: Map<string, FragmentDefinitionNode>,
  stack: string[],
  unresolved: Set<string>,
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
        unresolved,
      ),
    };
    return [field];
  }

  if (selection.kind === Kind.FRAGMENT_SPREAD) {
    const fragmentName = selection.name.value;
    if (stack.includes(fragmentName)) {
      // Fragment cycle: invalid GraphQL, but a reader should not
      // loop on it. Drop the repeated spread.
      return [];
    }
    const fragment = fragments.get(fragmentName);
    if (fragment === undefined) {
      unresolved.add(fragmentName);
      return [];
    }
    const inlined = inlineSelectionSet(
      fragment.selectionSet,
      fragments,
      [...stack, fragmentName],
      unresolved,
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
      unresolved,
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
      properties[key] =
        selection.selectionSet !== undefined
          ? selectionSetToShape(selection.selectionSet)
          : { type: "unknown" };
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      mergeSelectionsInto(properties, selection.selectionSet.selections);
    }
    // Fragment spreads were already inlined; any survivor was
    // unresolvable and is recorded as a gap.
  }
}

function safeParse(text: string): DocumentNode | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}
