/**
 * The entry points the code serves: HTTP routes, and the fields on
 * GraphQL's Query, Mutation and Subscription types.
 *
 * An entry point is a boundary key, the one `check` pairs on, so a
 * route a handler serves and a spec declares is one entry with both
 * units on it. A handler's own outcomes are the transitions its summary
 * records, written the way `inspect` writes them.
 */

import {
  boundaryKey,
  readGraphqlMetadata,
  readWrapperMetadata,
} from "@suss/behavioral-ir";

import { formatBodyShape, formatCondition } from "../inspect.js";

import type {
  BehavioralSummary,
  GraphqlDeclaredContract,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  EntryKind,
  GraphqlShape,
  MapEntry,
  MapOutcome,
} from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

export interface GatheredEntries {
  entries: MapEntry[];
  /** The code units that serve each entry, for the reach. */
  servedBy: Map<MapEntry, BehavioralSummary[]>;
  /** The entry each serving or declaring summary belongs to. */
  entryOf: Map<BehavioralSummary, number>;
  pages: Array<{ unit: number; path: string }>;
}

const GRAPHQL_ROOT_TYPES: ReadonlySet<string> = new Set([
  "Query",
  "Mutation",
  "Subscription",
]);

interface Served {
  kind: EntryKind;
  method: string;
  path: string;
}

/** What a summary serves as an entry point, or null when it serves none. */
export function entryServedBy(summary: BehavioralSummary): Served | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  const semantics = binding.semantics as Record<string, unknown>;
  if (
    summary.kind === "handler" &&
    semantics.name === "rest" &&
    typeof semantics.method === "string" &&
    typeof semantics.path === "string"
  ) {
    return {
      kind: "rest",
      method: semantics.method.toUpperCase(),
      path: semantics.path,
    };
  }
  if (
    summary.kind === "resolver" &&
    semantics.name === "graphql-resolver" &&
    typeof semantics.typeName === "string" &&
    typeof semantics.fieldName === "string" &&
    GRAPHQL_ROOT_TYPES.has(semantics.typeName)
  ) {
    return {
      kind: "graphql",
      method: semantics.typeName,
      path: semantics.fieldName,
    };
  }
  return null;
}

export function gatherEntries(
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
): GatheredEntries {
  const entries: MapEntry[] = [];
  const byKey = new Map<string, number>();
  const servedBy = new Map<MapEntry, BehavioralSummary[]>();
  const entryOf = new Map<BehavioralSummary, number>();
  const declaredBy = new Map<MapEntry, BehavioralSummary[]>();
  const pages: Array<{ unit: number; path: string }> = [];

  for (const summary of summaries) {
    const page = pagePathOf(summary);
    if (page !== null) {
      pages.push({ unit: units.of(summary), path: page });
      continue;
    }

    const served = entryServedBy(summary);
    const binding = summary.identity.boundaryBinding;
    const key = binding === null ? null : boundaryKey(binding);
    if (served === null || key === null) {
      continue;
    }

    let index = byKey.get(key);
    if (index === undefined) {
      index = entries.length;
      byKey.set(key, index);
      entries.push(emptyEntry(key, served, binding?.recognition ?? ""));
    }
    const entry = entries[index] as MapEntry;
    entryOf.set(summary, index);
    const spec = units.isSpec(summary);
    const bucket = spec ? declaredBy : servedBy;
    bucket.set(entry, [...(bucket.get(entry) ?? []), summary]);
    (spec ? entry.specs : entry.units).push(units.of(summary));
  }

  for (const entry of entries) {
    const code = servedBy.get(entry) ?? [];
    const specs = declaredBy.get(entry) ?? [];
    fillFromSummaries(entry, code, specs, units);
  }

  return { entries, servedBy, entryOf, pages };
}

function emptyEntry(key: string, served: Served, framework: string): MapEntry {
  return {
    key,
    kind: served.kind,
    method: served.method,
    path: served.path,
    framework,
    units: [],
    specs: [],
    outcomes: [],
    reach: [],
    callers: [],
    findings: [],
    unfollowed: [],
    unread: false,
    shape: null,
    specStatuses: [],
  };
}

function fillFromSummaries(
  entry: MapEntry,
  code: readonly BehavioralSummary[],
  specs: readonly BehavioralSummary[],
  units: UnitTable,
): void {
  // The code's own spelling of the route reads better than the spec's
  // when both exist, since that is what a reader searches the code for.
  const first = code[0];
  const served = first === undefined ? null : entryServedBy(first);
  if (served !== null) {
    entry.method = served.method;
    entry.path = served.path;
    entry.framework = first?.identity.boundaryBinding?.recognition ?? "";
  }

  entry.outcomes = code.flatMap((summary) =>
    summary.transitions.map((transition) =>
      outcomeOf(transition, units.of(summary)),
    ),
  );
  entry.unread = code.some((summary) =>
    summary.gaps.some((gap) => gap.type === "unreadOutcome"),
  );
  entry.specStatuses = [
    ...new Set(
      specs.flatMap((summary) =>
        summary.transitions
          .map((transition) => statusOf(transition))
          .filter((status): status is number => status !== null),
      ),
    ),
  ].sort((a, b) => a - b);

  if (entry.kind === "graphql") {
    const declared = [...code, ...specs]
      .map((summary) => readGraphqlMetadata(summary)?.declaredContract)
      .find((contract) => contract !== undefined);
    entry.shape = declared === undefined ? null : graphqlShapeOf(declared);
  }
}

function outcomeOf(transition: Transition, unit: number): MapOutcome {
  const output = transition.output;
  return {
    status: statusOf(transition),
    output: output.type,
    exception: output.type === "throw" ? output.exceptionType : null,
    conditions: transition.conditions.map((condition) =>
      formatCondition(condition),
    ),
    unit,
    line: transition.location.start,
    wrapper: readWrapperMetadata(transition)?.from?.name ?? null,
  };
}

/** The status a transition returns: a literal one, or what the framework sends for an uncaught throw. */
export function statusOf(transition: Transition): number | null {
  const output = transition.output;
  if (output.type === "response") {
    const status = output.statusCode;
    return status?.type === "literal" && typeof status.value === "number"
      ? status.value
      : null;
  }
  if (output.type === "throw") {
    return output.statusWhenUncaught ?? null;
  }
  return null;
}

/** A component a client-side router serves at a path, or null for anything else. */
function pagePathOf(summary: BehavioralSummary): string | null {
  const semantics = summary.identity.boundaryBinding?.semantics as
    | Record<string, unknown>
    | undefined;
  if (
    summary.kind !== "component" ||
    semantics?.name !== "rest" ||
    typeof semantics.path !== "string"
  ) {
    return null;
  }
  return semantics.path;
}

export function graphqlShapeOf(
  contract: Pick<GraphqlDeclaredContract, "args" | "returnType">,
): GraphqlShape {
  const shapes = [contract.returnType, ...contract.args.map((a) => a.type)];
  return {
    args: contract.args.map((arg) => ({
      name: arg.name,
      type: formatBodyShape(arg.type),
      required: arg.required,
    })),
    returns: formatBodyShape(contract.returnType),
    refs: [...new Set(shapes.flatMap(refNamesIn))],
  };
}

const REF_CHILDREN: Partial<
  Record<TypeShape["type"], (shape: TypeShape) => TypeShape[]>
> = {
  array: (shape) => (shape.type === "array" ? [shape.items] : []),
  union: (shape) => (shape.type === "union" ? shape.variants : []),
  dictionary: (shape) => (shape.type === "dictionary" ? [shape.values] : []),
};

/** The names of the types a shape refers to, at any depth of lists and unions. */
function refNamesIn(shape: TypeShape): string[] {
  if (shape.type === "ref") {
    return [shape.name];
  }
  const children = REF_CHILDREN[shape.type]?.(shape) ?? [];
  return children.flatMap(refNamesIn);
}
