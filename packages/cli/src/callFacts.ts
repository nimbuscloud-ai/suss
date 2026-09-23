/**
 * The call facts in a set of summaries, and the reach questions asked
 * over them as datalog rules.
 *
 * A summary records a call four ways: an invocation effect the run
 * resolved, a wrapper the framework runs on the way in, a caller unit's
 * binding to the export it calls, and a function passed to a callee that
 * calls its parameter. Each becomes a one-hop fact, the `calls` rules join
 * them, and a reach question is the fixpoint over `calls`, with the
 * shortest call path kept as the tag on each fact. A node is a function,
 * keyed by its location, because a function bound to several exports has
 * several summaries and a call into any of them is a call into it.
 */

import {
  BOUNDARY_ROLE,
  bindingIs,
  boundaryKey,
  displayLabel,
  summaryIdentifier,
  wrapperChain,
  wrapperFor,
  wrapperIndex,
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
 * How a call was recorded. `written` is a call expression in the
 * caller's body. `bound` comes only from the caller's binding to an
 * export, so there is no call expression to point at. `passed` is a
 * function the caller hands to a callee, which calls it through a
 * parameter. `wraps` is a wrapper the framework runs in front of the
 * caller, which appears nowhere in the caller's body.
 */
export type CallRecord = "written" | "bound" | "passed" | "wraps";

export interface CallHop {
  callee: string;
  /** Null when the call is to an export nothing here provides. */
  to: FunctionKey | null;
  recorded: CallRecord;
}

/** The calls from one function to another, in the order they are made. */
export type CallPath = readonly CallHop[];

/** The callees along a path, as an answer prints them. */
export function callSpellings(path: CallPath): string[] {
  return path.map((hop) => hop.callee);
}

export interface CallFacts {
  /** Every summary of each function, in the order the run wrote them. */
  units: ReadonlyMap<FunctionKey, BehavioralSummary[]>;
  /**
   * Every call from one function to another, for a caller that walks the
   * graph itself. Asking a reach question per unit would run one fixpoint
   * per unit, which is too slow on a project with a thousand routes.
   */
  edges(): CallEdge[];
  /** The direct callers of a function, one entry per caller and call spelling. */
  callersOf(target: ReachTarget): DirectCall[];
  /** Every function that ends up calling into the target, with the shortest path. */
  reaching(target: ReachTarget): Map<FunctionKey, CallPath>;
  /** Every function these ones end up calling, with the shortest path. */
  reachedFrom(start: Iterable<FunctionKey>): Map<FunctionKey, CallPath>;
}

/** Where a reach question ends. */
export interface ReachTarget {
  /** The target functions. They are left out of the answer themselves. */
  functions: ReadonlyArray<FunctionKey>;
  /** The package exports they provide, which a caller can be bound to. */
  keys: ReadonlyArray<string>;
  /** Functions that touch the target directly, when it is a boundary. */
  at?: ReadonlyArray<FunctionKey>;
}

export interface CallEdge {
  from: FunctionKey;
  to: FunctionKey;
  /** The call as the caller's source writes it, which a printed chain shows. */
  callee: string;
}

export interface DirectCall {
  caller: FunctionKey;
  /** The call as the caller's source writes it, or the export's label when only the binding records the call. */
  callee: string;
}

export function readCallFacts(
  summaries: ReadonlyArray<BehavioralSummary>,
): CallFacts {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const chain = wrapperIndex(summaries);
  const units = new Map<FunctionKey, BehavioralSummary[]>();
  const invocation: Array<[FunctionKey, FunctionKey, string]> = [];
  const wraps: Array<[FunctionKey, FunctionKey, string]> = [];
  const boundTo: Array<[FunctionKey, string, string]> = [];
  const provides: Array<[FunctionKey, string]> = [];
  const passes: Array<[FunctionKey, FunctionKey, number, FunctionKey]> = [];
  const callsParameter: Array<[FunctionKey, number, string]> = [];

  for (const summary of summaries) {
    const fn = functionOf(summary);
    units.set(fn, [...(units.get(fn) ?? []), summary]);
    for (const reference of wrapperChain(summary)) {
      const wrapper = wrapperFor(chain, reference);
      if (wrapper !== undefined) {
        wraps.push([fn, functionOf(wrapper), reference.name]);
      }
    }
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

  // Each question adds its own facts before evaluating, so each one gets
  // a fresh database loaded with the same base facts.
  const database = (): Database => {
    const db = new Database();
    for (const fact of invocation) {
      db.add("invocation", fact);
    }
    for (const fact of wraps) {
      db.add("wraps", fact);
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
    edges: () => callEdges(database()),
    callersOf: (target) => directCallers(database(), target),
    reaching: (target) => reachingFunctions(database(), target),
    reachedFrom: (start) => reachedFunctions(database(), start),
  };
}

/** A function's key is its location, since every summary of one function shares it. */
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
  // Nothing in F's body calls G. The framework runs G on the way into
  // F, so a request through F does what G does before F starts.
  rule(
    "calls",
    [F, G, L, constant("wraps")],
    [lit("wraps", F, G, L)],
    "calls-wraps",
  ),
  // F passes G to B at position I, and B calls its parameter I. This join
  // makes a callback reachable through the function it was passed to. L
  // is the description B's summary recorded for that call.
  rule(
    "calls",
    [F, G, L, constant("passed")],
    [lit("passes", F, B, I, G), lit("callsParameter", B, I, L)],
    "calls-passed",
  ),
  rule("provided", [K], [lit("provides", G, K)], "provided"),
];

// When a summary provides the export, the calls-bound rule already links
// the caller to that provider. The reaches-bound rule covers an export no
// summary provides, so a chain can still end at it.
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

/** The `CallRecord` for a `calls` fact's kind slot. Unknown kinds fall back to "written". */
const CALL_RECORD_OF: Record<string, CallRecord> = {
  written: "written",
  bound: "bound",
  passed: "passed",
  wraps: "wraps",
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

/** The hop recorded by the `boundTo` fact at `index`. No summary provides its export, so it has no function. */
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
  "calls-wraps": () => [],
  provided: () => [],
  "reaches-at": () => [],
  "reaches-into": (body) => [callAt(body, 1)],
  "reaches-bound": (body) => [bindingAt(body, 1)],
  "reaches-through": (body, tags) => [callAt(body, 1), ...tags[0]],
  "reached-from": (body) => [callAt(body, 1)],
  "reached-onward": (body, tags) => [...tags[0], callAt(body, 1)],
};

/** Keeps the shortest path. Between two of the same length, it keeps the one whose callees sort first. */
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

/** Every derived call, once per caller, target function and call spelling. */
function callEdges(db: Database): CallEdge[] {
  evaluate(db, CALLS);
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const tuple of db.facts("calls")) {
    const edge = {
      from: String(tuple[0]),
      to: String(tuple[1]),
      callee: String(tuple[2]),
    };
    const key = `${edge.from} ${edge.to} ${edge.callee}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push(edge);
  }
  return edges;
}

/**
 * One entry per caller function and call spelling. A caller already found
 * through an invocation effect is not listed again from its binding,
 * since the binding records the same call a second way.
 */
function directCallers(db: Database, target: ReachTarget): DirectCall[] {
  const own = new Set(target.functions);
  const calls: DirectCall[] = [];
  const seen = new Set<string>();
  // Bound callers come from the boundTo facts below, which record the
  // callee as the export's label. A wrapped unit does not call its
  // wrapper, so wraps facts are skipped too.
  evaluate(db, CALLS);
  for (const fn of target.functions) {
    for (const tuple of db.lookup("calls", 1, fn)) {
      if (tuple[3] === "bound" || tuple[3] === "wraps") {
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
      /** The subject's label in the answer. */
      label: string;
    }
  | { found: false; headline: string };

/**
 * The functions a spelling matches, and the exports they provide. A
 * boundary spelling matches the export itself, so a caller bound to it
 * counts even when no summary provides it. A bare name that matches
 * several functions is rejected, and the headline lists them.
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
 * Where a reach question ends. A function reaches a boundary by touching
 * it or by calling into the unit that serves it, and reaches a unit by
 * calling it. A caller bound to a function-call boundary is linked by
 * that binding. Any other unit that touches the boundary counts as at it.
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
 * The summary an answer prints for a function. That is the provider
 * summary when there is one, because callers refer to the function by
 * that id, and otherwise the first summary the run wrote.
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
