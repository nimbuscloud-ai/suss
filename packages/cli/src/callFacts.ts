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
import {
  constant,
  Database,
  evaluate,
  lit,
  notLit,
  rule,
  variable as v,
} from "@suss/datalog";

import { resolveTarget, unitsServing } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { BodyMatch, Rule, TagAlgebra } from "@suss/datalog";
import type { ResolvedTarget, TargetTouch } from "./target.js";

/** What `functionOf` returns. */
export type FunctionKey = string;

/**
 * Where a call came from: the caller's body, only the caller's binding
 * to the export it imports, or a function the caller passed to
 * something else that calls it back. A written call can be proved from
 * source; a bound one has no call expression to find; a passed one runs
 * through a parameter one hop further in.
 */
export type CallRecord = "written" | "bound" | "passed";

export interface CallHop {
  callee: string;
  /** Null when the call is to an export nothing here provides. */
  to: FunctionKey | null;
  recorded: CallRecord;
}

/** The calls from one function to another, in the order they are made. */
export type CallPath = readonly CallHop[];

/** The callees along a path, which is how an answer prints it. */
export function callSpellings(path: CallPath): string[] {
  return path.map((hop) => hop.callee);
}

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
  const passes: Array<[FunctionKey, FunctionKey, number, FunctionKey]> = [];
  const callsParameter: Array<[FunctionKey, number, string]> = [];

  for (const summary of summaries) {
    const fn = functionOf(summary);
    units.set(fn, [...(units.get(fn) ?? []), summary]);
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        const to =
          effect.summary === undefined ? undefined : byId.get(effect.summary);
        if (to !== undefined) {
          invocation.push([fn, functionOf(to), effect.callee]);
        }
        if (effect.calleeParameter !== undefined) {
          callsParameter.push([
            fn,
            effect.calleeParameter,
            `${summary.identity.name}, which calls it as ${effect.callee}`,
          ]);
        }
        if (to === undefined || effect.argsSummary === undefined) {
          continue;
        }
        for (const [position, summaryId] of Object.entries(
          effect.argsSummary,
        )) {
          const passedTo = byId.get(summaryId);
          if (passedTo !== undefined) {
            passes.push([
              fn,
              functionOf(to),
              Number(position),
              functionOf(passedTo),
            ]);
          }
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
    for (const fact of passes) {
      db.add("passes", fact);
    }
    for (const fact of callsParameter) {
      db.add("callsParameter", fact);
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
const W = v("w");
const B = v("b");
const I = v("i");

const CALLS: Rule[] = [
  rule(
    "calls",
    [F, G, L, constant("written")],
    [lit("invocation", F, G, L)],
    "calls-written",
  ),
  rule(
    "calls",
    [F, G, L, constant("bound")],
    [lit("boundTo", F, K, L), lit("provides", G, K)],
    "calls-bound",
  ),
  // F passes G to B at position I, and B calls its own parameter I: the
  // join is what makes a callback reachable through the function it was
  // handed to, and L is the sentence B's own scan wrote for that call.
  rule(
    "calls",
    [F, G, L, constant("passed")],
    [lit("passes", F, B, I, G), lit("callsParameter", B, I, L)],
    "calls-passed",
  ),
  rule("provided", [K], [lit("provides", G, K)], "provided"),
];

// When some summary provides the export, the calls-bound rule already
// links the caller to that provider. The reaches-bound rule is for an
// export nothing here provides, so the chain can still end at it.
const REACHING: Rule[] = [
  ...CALLS,
  rule("reaches", [F], [lit("atTarget", F)], "reaches-at"),
  rule(
    "reaches",
    [F],
    [lit("target", T), lit("calls", F, T, L, W)],
    "reaches-into",
  ),
  rule(
    "reaches",
    [F],
    [lit("targetKey", K), lit("boundTo", F, K, L), notLit("provided", K)],
    "reaches-bound",
  ),
  rule(
    "reaches",
    [F],
    [lit("reaches", G), lit("calls", F, G, L, W)],
    "reaches-through",
  ),
];

const REACHED: Rule[] = [
  ...CALLS,
  rule(
    "reached",
    [G],
    [lit("start", F), lit("calls", F, G, L, W)],
    "reached-from",
  ),
  rule(
    "reached",
    [G],
    [lit("reached", F), lit("calls", F, G, L, W)],
    "reached-onward",
  ),
];

/** Which `CallRecord` a `calls` fact's kind slot spells, "written" for anything else. */
const CALL_RECORD_OF: Record<string, CallRecord> = {
  written: "written",
  bound: "bound",
  passed: "passed",
};

/** The hop recorded by the `calls` fact at `index` in a rule body. */
function callAt(body: readonly BodyMatch[], index: number): CallHop {
  const match = body[index];
  if (match?.kind !== "fact") {
    return { callee: "", to: null, recorded: "written" };
  }
  return {
    callee: String(match.tuple[2]),
    to: String(match.tuple[1]),
    recorded: CALL_RECORD_OF[String(match.tuple[3])] ?? "written",
  };
}

/** The hop recorded by the `boundTo` fact at `index`, which lands in no function here. */
function bindingAt(body: readonly BodyMatch[], index: number): CallHop {
  const match = body[index];
  return {
    callee: match?.kind === "fact" ? String(match.tuple[2]) : "",
    to: null,
    recorded: "bound",
  };
}

const PATH_OF: Record<
  string,
  (body: readonly BodyMatch[], tags: readonly CallPath[]) => CallPath
> = {
  "calls-written": () => [],
  "calls-bound": () => [],
  "calls-passed": () => [],
  provided: () => [],
  "reaches-at": () => [],
  "reaches-into": (body) => [callAt(body, 1)],
  "reaches-bound": (body) => [bindingAt(body, 1)],
  "reaches-through": (body, tags) => [callAt(body, 1), ...tags[0]],
  "reached-from": (body) => [callAt(body, 1)],
  "reached-onward": (body, tags) => [...tags[0], callAt(body, 1)],
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
    return callSpellings(incoming).join(" ") < callSpellings(stored).join(" ")
      ? incoming
      : stored;
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
  // Bound callers are placed below from boundTo/provides directly,
  // since a "calls" fact of that kind says the same thing a second way.
  evaluate(db, CALLS);
  for (const fn of target.functions) {
    for (const tuple of db.lookup("calls", 1, fn)) {
      if (tuple[3] === "bound") {
        continue;
      }
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
    return {
      found: true,
      target: reachTargetOf(resolution.target),
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

  const target = reachTargetOfUnits(units);
  const byName = !resolution.matched || resolution.target.kind === "summary";
  if (byName && target.functions.length > 1) {
    const candidates = target.functions.map((fn) =>
      summaryIdentifier(representativeUnit(facts, fn)),
    );
    return {
      found: false,
      headline: `${spec} could mean ${target.functions.length} functions here: ${candidates.join(", ")}. Ask about one of them.`,
    };
  }

  return {
    found: true,
    target,
    label:
      target.functions.length === 1
        ? summaryIdentifier(representativeUnit(facts, target.functions[0]))
        : spec,
  };
}

/**
 * What a reach question ends at. A boundary is reached by touching it
 * or by calling into whatever serves it; a unit is reached by calling
 * it. A caller bound to a function-call boundary is placed by that
 * binding, and anything else touching the boundary is at it already.
 */
export function reachTargetOf(target: ResolvedTarget): ReachTarget {
  if (target.kind !== "boundary") {
    return reachTargetOfUnits(target.summaries);
  }
  return reachTargetOfTouches(target.touches);
}

/** The reach target for a boundary, given every touch on it. */
export function reachTargetOfTouches(
  touches: ReadonlyArray<TargetTouch>,
): ReachTarget {
  const providers = new Set(unitsServing(touches));
  const keys = new Set<string>();
  const at = new Set<FunctionKey>();
  for (const touch of touches) {
    const binding = touch.touched.binding;
    const key = boundaryKey(binding);
    if (key !== null) {
      keys.add(key);
    }
    if (providers.has(touch.summary)) {
      continue;
    }
    const placedByBinding =
      binding === touch.summary.identity.boundaryBinding &&
      bindingIs(binding, "function-call") &&
      key !== null;
    if (!placedByBinding) {
      at.add(functionOf(touch.summary));
    }
  }
  return {
    functions: [...new Set([...providers].map((unit) => functionOf(unit)))],
    keys: [...keys],
    at: [...at],
  };
}

/** The reach target for some units: their functions, and the exports they provide. */
function reachTargetOfUnits(
  units: ReadonlyArray<BehavioralSummary>,
): ReachTarget {
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
    functions: [...new Set(units.map((unit) => functionOf(unit)))],
    keys: [...keys],
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
