/**
 * The call facts a summary set states, and the reach questions asked
 * over them as rules.
 *
 * A summary says "this calls that" two ways: an invocation effect the
 * run resolved, and a caller-kind unit's own binding to the export it
 * calls. Both are one-hop facts here, `calls` joins them, and a reach
 * question in either direction is the fixpoint over `calls` with the
 * shortest call path kept as the tag on each derived fact.
 *
 * The node is the function, keyed by where it is, since one function
 * is several summaries when it is bound to several exports. A call
 * into any of them is a call into the function.
 */

import {
  BOUNDARY_ROLE,
  bindingIs,
  boundaryKey,
  displayLabel,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";

import { resolveTarget } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { BodyMatch, Rule, TagAlgebra } from "@suss/datalog";

/** What `functionOf` returns. */
export type FunctionKey = string;

/** The calls between two functions, each as the caller writes it. */
export type CallPath = readonly string[];

export interface CallFacts {
  /** Every summary of each function, in the order the run wrote them. */
  units: ReadonlyMap<FunctionKey, BehavioralSummary[]>;
  /** Who calls a function directly, one entry per caller function. */
  callersOf(target: ReachTarget): DirectCall[];
  /** Every function that ends up calling into the target, with the shortest path. */
  reaching(target: ReachTarget): Map<FunctionKey, CallPath>;
  /** Every function these ones end up calling, with the shortest path. */
  reachedFrom(start: Iterable<FunctionKey>): Map<FunctionKey, CallPath>;
}

/** What a reach question ends at, as the facts spell it. */
export interface ReachTarget {
  /** The functions themselves, which nothing reaches by being one of them. */
  functions: ReadonlyArray<FunctionKey>;
  /** The package exports they provide, which a caller can be bound to. */
  keys: ReadonlyArray<string>;
  /** Functions at the target already, when it is a boundary and not a function. */
  at?: ReadonlyArray<FunctionKey>;
}

export interface DirectCall {
  caller: FunctionKey;
  /** The call as the caller writes it, or the export's label when only the binding records it. */
  callee: string;
}

export function readCallFacts(
  summaries: ReadonlyArray<BehavioralSummary>,
): CallFacts {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const units = new Map<FunctionKey, BehavioralSummary[]>();
  const invocation: Array<[FunctionKey, FunctionKey, string]> = [];
  const boundTo: Array<[FunctionKey, string, string]> = [];
  const provides: Array<[FunctionKey, string]> = [];

  for (const summary of summaries) {
    const fn = functionOf(summary);
    units.set(fn, [...(units.get(fn) ?? []), summary]);
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation" || effect.summary === undefined) {
          continue;
        }
        const to = byId.get(effect.summary);
        if (to !== undefined) {
          invocation.push([fn, functionOf(to), effect.callee]);
        }
      }
    }

    const binding = summary.identity.boundaryBinding;
    if (!bindingIs(binding, "function-call")) {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    if (BOUNDARY_ROLE[summary.kind] === "provider") {
      provides.push([fn, key]);
    } else {
      boundTo.push([fn, key, displayLabel(binding)]);
    }
  }

  // A question adds its own facts and derives from them, so each one
  // gets a database of its own over the same base facts.
  const database = (): Database => {
    const db = new Database();
    for (const fact of invocation) {
      db.add("invocation", fact);
    }
    for (const fact of boundTo) {
      db.add("boundTo", fact);
    }
    for (const fact of provides) {
      db.add("provides", fact);
    }
    return db;
  };

  return {
    units,
    callersOf: (target) => directCallers(database(), target),
    reaching: (target) => reachingFunctions(database(), target),
    reachedFrom: (start) => reachedFunctions(database(), start),
  };
}

/** Where a function is, which is the one thing all of its summaries share. */
export function functionOf(summary: BehavioralSummary): FunctionKey {
  const { file, range, workspace } = summary.location;
  return [workspace ?? "", file, range.start, range.end].join(" ");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const F = v("f");
const G = v("g");
const K = v("k");
const L = v("l");
const T = v("t");

const CALLS: Rule[] = [
  rule("calls", [F, G, L], [lit("invocation", F, G, L)], "calls-written"),
  rule(
    "calls",
    [F, G, L],
    [lit("boundTo", F, K, L), lit("provides", G, K)],
    "calls-bound",
  ),
];

const REACHING: Rule[] = [
  ...CALLS,
  rule("reaches", [F], [lit("atTarget", F)], "reaches-at"),
  rule(
    "reaches",
    [F],
    [lit("target", T), lit("calls", F, T, L)],
    "reaches-into",
  ),
  rule(
    "reaches",
    [F],
    [lit("targetKey", K), lit("boundTo", F, K, L)],
    "reaches-bound",
  ),
  rule(
    "reaches",
    [F],
    [lit("reaches", G), lit("calls", F, G, L)],
    "reaches-through",
  ),
];

const REACHED: Rule[] = [
  ...CALLS,
  rule(
    "reached",
    [G],
    [lit("start", F), lit("calls", F, G, L)],
    "reached-from",
  ),
  rule(
    "reached",
    [G],
    [lit("reached", F), lit("calls", F, G, L)],
    "reached-onward",
  ),
];

/** The call spelling on the body fact at `index`, which is always column 2. */
function calleeAt(body: readonly BodyMatch[], index: number): string {
  const match = body[index];
  return match?.kind === "fact" ? String(match.tuple[2]) : "";
}

const PATH_OF: Record<
  string,
  (body: readonly BodyMatch[], tags: readonly CallPath[]) => CallPath
> = {
  "calls-written": () => [],
  "calls-bound": () => [],
  "reaches-at": () => [],
  "reaches-into": (body) => [calleeAt(body, 1)],
  "reaches-bound": (body) => [calleeAt(body, 1)],
  "reaches-through": (body, tags) => [calleeAt(body, 1), ...tags[0]],
  "reached-from": (body) => [calleeAt(body, 1)],
  "reached-onward": (body, tags) => [...tags[0], calleeAt(body, 1)],
};

/** The shortest path wins, and between two of one length the spelling that sorts first. */
const SHORTEST_PATH: TagAlgebra<CallPath> = {
  asserted: [],
  absent: [],
  combine: (tags, derivation) =>
    PATH_OF[derivation.rule.name ?? ""](derivation.body, tags),
  merge: (stored, incoming) => {
    if (incoming.length !== stored.length) {
      return incoming.length < stored.length ? incoming : stored;
    }
    return incoming.join(" ") < stored.join(" ") ? incoming : stored;
  },
};

function pathsOf(db: Database, relation: string): Map<FunctionKey, CallPath> {
  const paths = new Map<FunctionKey, CallPath>();
  for (const tuple of db.facts(relation)) {
    paths.set(String(tuple[0]), db.tagOf(relation, tuple) as CallPath);
  }
  return paths;
}

function reachingFunctions(
  db: Database,
  target: ReachTarget,
): Map<FunctionKey, CallPath> {
  for (const fn of target.functions) {
    db.add("target", [fn]);
  }
  for (const key of target.keys) {
    db.add("targetKey", [key]);
  }
  for (const fn of target.at ?? []) {
    db.add("atTarget", [fn]);
  }
  evaluate(db, REACHING, SHORTEST_PATH);
  const paths = pathsOf(db, "reaches");
  for (const fn of target.functions) {
    paths.delete(fn);
  }
  return paths;
}

function reachedFunctions(
  db: Database,
  start: Iterable<FunctionKey>,
): Map<FunctionKey, CallPath> {
  const from = new Set(start);
  for (const fn of from) {
    db.add("start", [fn]);
  }
  evaluate(db, REACHED, SHORTEST_PATH);
  const paths = pathsOf(db, "reached");
  for (const fn of from) {
    paths.delete(fn);
  }
  return paths;
}

/**
 * One entry per caller function and spelling. A caller the invocation
 * effects already place is not repeated from its binding, which
 * spells the same call a second way.
 */
function directCallers(db: Database, target: ReachTarget): DirectCall[] {
  const own = new Set(target.functions);
  const calls: DirectCall[] = [];
  const seen = new Set<string>();
  for (const fn of target.functions) {
    for (const tuple of db.lookup("invocation", 1, fn)) {
      const caller = String(tuple[0]);
      const callee = String(tuple[2]);
      if (own.has(caller) || seen.has(`${caller} ${callee}`)) {
        continue;
      }
      seen.add(`${caller} ${callee}`);
      calls.push({ caller, callee });
    }
  }

  const placed = new Set(calls.map((call) => call.caller));
  for (const key of target.keys) {
    for (const tuple of db.lookup("boundTo", 1, key)) {
      const caller = String(tuple[0]);
      if (own.has(caller) || placed.has(caller)) {
        continue;
      }
      placed.add(caller);
      calls.push({ caller, callee: String(tuple[2]) });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The function a question is about
// ---------------------------------------------------------------------------

export type SpelledFunctions =
  | {
      found: true;
      target: ReachTarget;
      /** What the answer calls the subject. */
      label: string;
    }
  | { found: false; headline: string };

/**
 * The functions a spelling picks out, and the exports they provide. A
 * boundary spelling picks out the export itself, so a caller bound to
 * it counts even when no summary here provides it. A bare name that
 * is two functions is turned down with both listed.
 */
export function functionsSpelled(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
  facts: CallFacts,
): SpelledFunctions {
  const resolution = resolveTarget(spec, summaries);
  if (resolution.matched && resolution.target.kind === "boundary") {
    const provided = resolution.target.touches
      .filter((touch) => touch.touched.relation === "provides")
      .map((touch) => functionOf(touch.summary));
    const keys = resolution.target.touches
      .map((touch) => boundaryKey(touch.touched.binding))
      .filter((key): key is string => key !== null);
    return {
      found: true,
      target: { functions: [...new Set(provided)], keys: [...new Set(keys)] },
      label: resolution.target.touches[0]?.touched.label ?? spec,
    };
  }

  const units = resolution.matched
    ? resolution.target.summaries
    : summaries.filter(
        (summary) =>
          summary.identity.name === spec ||
          summary.identity.name.endsWith(`.${spec}`),
      );
  if (units.length === 0) {
    return {
      found: false,
      headline: `No summary here is ${spec}. Spell the unit as a file, a summary id, or its function name.`,
    };
  }

  const functions = [...new Set(units.map((unit) => functionOf(unit)))];
  const byName = !resolution.matched || resolution.target.kind === "summary";
  if (byName && functions.length > 1) {
    const candidates = functions.map((fn) =>
      summaryIdentifier(representativeUnit(facts, fn)),
    );
    return {
      found: false,
      headline: `${spec} could mean ${functions.length} functions here: ${candidates.join(", ")}. Ask about one of them.`,
    };
  }

  const keys = new Set<string>();
  for (const unit of units) {
    const binding = unit.identity.boundaryBinding;
    if (
      BOUNDARY_ROLE[unit.kind] === "provider" &&
      bindingIs(binding, "function-call")
    ) {
      const key = boundaryKey(binding);
      if (key !== null) {
        keys.add(key);
      }
    }
  }
  return {
    found: true,
    target: { functions, keys: [...keys] },
    label:
      functions.length === 1
        ? summaryIdentifier(representativeUnit(facts, functions[0]))
        : spec,
  };
}

/**
 * The summary an answer prints for a function: the one for the export
 * it provides, since that is the id its callers know it by, else the
 * first one written.
 */
export function representativeUnit(
  facts: CallFacts,
  fn: FunctionKey,
): BehavioralSummary {
  const units = facts.units.get(fn) ?? [];
  const provider = units.find(
    (unit) =>
      BOUNDARY_ROLE[unit.kind] === "provider" &&
      unit.identity.boundaryBinding !== null,
  );
  const chosen = provider ?? units[0];
  if (chosen === undefined) {
    throw new Error(`no summary for function ${fn}`);
  }
  return chosen;
}
