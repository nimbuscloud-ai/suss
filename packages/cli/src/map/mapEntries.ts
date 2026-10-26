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
  bindingIs,
  boundaryKey,
  readGraphqlMetadata,
  readWrapperMetadata,
} from "@suss/behavioral-ir";
import { withChildShapes, withDefinitionsInlined } from "@suss/ir-core";

import { formatBodyShape, formatCondition } from "../inspect.js";
import { repositoryKeyOf, type UnitTable } from "./mapUnits.js";

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

const SERVES_A_FIELD: ReadonlySet<BehavioralSummary["kind"]> = new Set([
  "resolver",
  "handler",
]);

interface Served {
  kind: EntryKind;
  method: string;
  path: string;
}

/** What a summary serves as an entry point, or null when it serves none. */
export function entryServedBy(summary: BehavioralSummary): Served | null {
  const binding = summary.identity.boundaryBinding;
  if (
    summary.kind === "handler" &&
    bindingIs(binding, "rest") &&
    binding.semantics.method !== null &&
    binding.semantics.path !== null
  ) {
    return {
      kind: "rest",
      method: binding.semantics.method.toUpperCase(),
      path: binding.semantics.path,
    };
  }
  // A Lambda that AppSync routes a field to is a handler, which the
  // template binds to the field, so it serves the field as a resolver does.
  if (
    SERVES_A_FIELD.has(summary.kind) &&
    bindingIs(binding, "graphql-resolver") &&
    binding.semantics.typeName !== null &&
    GRAPHQL_ROOT_TYPES.has(binding.semantics.typeName)
  ) {
    return {
      kind: "graphql",
      method: binding.semantics.typeName,
      path: binding.semantics.fieldName,
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

  const add = (
    summary: BehavioralSummary,
    index: number,
    bucket: Map<MapEntry, BehavioralSummary[]>,
    list: "units" | "specs",
  ) => {
    const entry = entries[index] as MapEntry;
    if (!entryOf.has(summary)) {
      entryOf.set(summary, index);
    }
    bucket.set(entry, [...(bucket.get(entry) ?? []), summary]);
    entry[list].push(units.of(summary));
  };
  const entryAt = (
    where: string,
    key: string,
    served: Served,
    framework: string,
  ) => {
    const seen = byKey.get(where);
    if (seen !== undefined) {
      return seen;
    }
    byKey.set(where, entries.length);
    entries.push(emptyEntry(key, served, framework));
    return entries.length - 1;
  };

  // Two repositories can each serve `GET /health`, and those are two
  // routes, so code is keyed by its repository as well. A spec joins every
  // route in code with its key, whichever repository serves it.
  const codeByKey = new Map<string, number[]>();
  const specs: BehavioralSummary[] = [];
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
    if (units.isSpec(summary)) {
      specs.push(summary);
      continue;
    }

    const index = entryAt(
      `${repositoryKeyOf(summary)}\u0000${key}`,
      key,
      served,
      binding?.recognition ?? "",
    );
    if (!(codeByKey.get(key) ?? []).includes(index)) {
      codeByKey.set(key, [...(codeByKey.get(key) ?? []), index]);
    }
    add(summary, index, servedBy, "units");
  }

  for (const summary of specs) {
    const binding = summary.identity.boundaryBinding;
    const served = entryServedBy(summary);
    const key = binding === null ? null : boundaryKey(binding);
    if (served === null || key === null) {
      continue;
    }
    const targets = codeByKey.get(key) ?? [
      entryAt(`spec\u0000${key}`, key, served, binding?.recognition ?? ""),
    ];
    for (const index of targets) {
      add(summary, index, declaredBy, "specs");
    }
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

  entry.outcomes = code.flatMap((summary) => {
    const names = definedNames(summary);
    return summary.transitions.map((transition) =>
      outcomeOf(transition, units.of(summary), names),
    );
  });
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

function outcomeOf(
  transition: Transition,
  unit: number,
  names: ReadonlyMap<string, string>,
): MapOutcome {
  const output = transition.output;
  return {
    status: statusOf(transition),
    output: output.type,
    exception: output.type === "throw" ? output.exceptionType : null,
    returns:
      output.type === "return" && output.value !== null
        ? formatBodyShape(namesOnly(output.value, names))
        : null,
    conditions: transition.conditions.map((condition) =>
      formatCondition(condition),
    ),
    unit,
    line: transition.location.start,
    wrapper: readWrapperMetadata(transition)?.from?.name ?? null,
  };
}

/**
 * The shape the check put in place of a ref to each type the summary
 * defines, keyed by its text, so the page can print the type's name
 * again where the check spelled it out.
 */
function definedNames(summary: BehavioralSummary): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of Object.keys(summary.definitions ?? {})) {
    const spelled = withDefinitionsInlined(
      { type: "ref", name, def: name },
      summary.definitions,
    );
    names.set(JSON.stringify(spelled), name);
  }
  return names;
}

/** The shape with each type down to its name, so the page prints `Campaign` and links it, where `inspect` adds the file. */
function namesOnly(
  shape: TypeShape,
  names: ReadonlyMap<string, string>,
): TypeShape {
  if (shape.type === "ref") {
    return { type: "ref", name: shape.name };
  }
  const defined = names.get(JSON.stringify(shape));
  return defined === undefined
    ? withChildShapes(shape, (inner) => namesOnly(inner, names))
    : { type: "ref", name: defined };
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
  const binding = summary.identity.boundaryBinding;
  if (summary.kind !== "component" || !bindingIs(binding, "rest")) {
    return null;
  }
  return binding.semantics.path;
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
