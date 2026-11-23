/**
 * Every call one function makes into another, one entry per place the
 * call is written, and the facts and rules that say what each call
 * passes into a boundary.
 *
 * A call counts a parameter when the function uses it for a boundary
 * field or a column it selects rows by, or passes it on to a function
 * that does. Those are one-hop facts, `selects` and `forwards`, and the
 * `counted` rule closes over them, so `enabled?(key)` counts `key`
 * because the `lookup(key)` it calls selects rows by it. A call that leaves
 * a counted parameter out is recorded as leaving it out. The parameter
 * default that would fill it is not read yet.
 */

import {
  originalIdOf,
  readWrapperMetadata,
  settlingSuffix,
  summaryIdentifier,
  unsettledSummaryId,
  wrapperChain,
  wrapperFor,
  wrapperIndex,
} from "@suss/behavioral-ir";
import {
  Database,
  evaluate,
  lit,
  notLit,
  rule,
  variable as v,
} from "@suss/datalog";

import { writtenFunctionOf } from "../calls/callFacts.js";
import { containerParametersOf } from "../storage/containerParameters.js";
import { spellArgument } from "./argumentSpelling.js";

import type { BehavioralSummary, Effect, Predicate } from "@suss/behavioral-ir";
import type { Rule } from "@suss/datalog";
import type { FunctionKey } from "../calls/callFacts.js";
import type { RecordedArgument, SpelledArgument } from "./argumentSpelling.js";

/**
 * How a call reached its target. `written` is a call the run resolved,
 * `possible` a call that may run the target or another function it picks
 * at run time, and `wraps` a wrapper the framework runs around the caller.
 */
export type CallKind = "written" | "possible" | "wraps";

export interface RecordedCall {
  id: string;
  caller: BehavioralSummary;
  /** The caller as written, the same for a copy made for one construction of its receiver. */
  callerFunction: FunctionKey;
  target: FunctionKey;
  /** The call as the caller's source writes it. */
  callee: string;
  /** The line the call is written on, when the summary records one. */
  line: number | undefined;
  /** How many places in one transition the summary folded into this call. */
  count: number;
  args: readonly RecordedArgument[];
  conditions: readonly Predicate[];
  kind: CallKind;
}

/** What one call passes for one parameter of the function it calls. */
export interface PassedValue extends SpelledArgument {
  parameter: string;
}

export interface CallFactsForUse {
  calls: readonly RecordedCall[];
  /** The parameters of each function, in order, from the summary that lists the most. */
  parameters: ReadonlyMap<FunctionKey, readonly string[]>;
  /** What each call passes for each parameter it fills. */
  passed: ReadonlyMap<string, readonly PassedValue[]>;
  /** A function and a parameter it sends to its boundary. */
  selects: ReadonlyArray<[FunctionKey, string]>;
  /** A function, its own parameter, and the function and parameter it passes it on to. */
  forwards: ReadonlyArray<[FunctionKey, string, FunctionKey, string]>;
}

/** Every call between functions in these summaries, once per written call. */
export function readCallsForUse(
  summaries: ReadonlyArray<BehavioralSummary>,
): CallFactsForUse {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const parameters = parametersByFunction(summaries);
  const chain = wrapperIndex(summaries);
  const calls = new Map<string, RecordedCall>();
  const record = (call: Omit<RecordedCall, "id">): void => {
    const id = [
      call.callerFunction,
      call.line ?? "",
      call.callee,
      call.target,
    ].join("\u0000");
    const seen = calls.get(id);
    if (seen !== undefined) {
      seen.count = Math.max(seen.count, call.count);
      return;
    }
    calls.set(id, { ...call, id });
  };

  for (const summary of summaries) {
    const callerFunction = writtenFunctionOf(summary);
    for (const reference of wrapperChain(summary)) {
      const wrapper = wrapperFor(chain, reference);
      if (wrapper !== undefined) {
        record({
          caller: summary,
          callerFunction,
          target: writtenFunctionOf(wrapper),
          callee: reference.name,
          line: summary.location.range.start,
          count: 1,
          args: [],
          conditions: [],
          kind: "wraps",
        });
      }
    }
    for (const transition of summary.transitions) {
      // A path composition added from a wrapper lists the wrapper's own
      // calls, on the wrapper's lines, and the unit makes none of them.
      if (readWrapperMetadata(transition)?.from !== undefined) {
        continue;
      }
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        for (const [target, kind] of targetsOf(effect, byId)) {
          record({
            caller: summary,
            callerFunction,
            target: writtenFunctionOf(target),
            callee: effect.callee,
            line: effect.location?.start,
            count: effect.count ?? 1,
            args: effect.args as RecordedArgument[],
            conditions: effect.preconditions ?? [],
            kind,
          });
        }
      }
    }
  }

  const passed = new Map<string, PassedValue[]>();
  const forwards: Array<[FunctionKey, string, FunctionKey, string]> = [];
  for (const call of calls.values()) {
    const values = valuesPassed(call, parameters.get(call.target) ?? []);
    passed.set(call.id, values);
    const own = new Set(
      (parameters.get(call.callerFunction) ?? []).map((one) => one.name),
    );
    for (const value of values) {
      if (own.has(value.spelled)) {
        forwards.push([
          call.callerFunction,
          value.spelled,
          call.target,
          value.parameter,
        ]);
      }
    }
  }

  return {
    calls: [...calls.values()],
    parameters: new Map(
      [...parameters].map(([fn, inputs]) => [
        fn,
        inputs.map((input) => input.name),
      ]),
    ),
    passed,
    selects: selectsFacts(summaries, parameters),
    forwards,
  };
}

/** The summaries an effect calls into: the one it resolved to, and the ones it may run instead. */
function targetsOf(
  effect: Extract<Effect, { type: "invocation" }>,
  byId: ReadonlyMap<string, BehavioralSummary>,
): Array<[BehavioralSummary, CallKind]> {
  const found: Array<[BehavioralSummary, CallKind]> = [];
  const resolved =
    effect.summary === undefined ? undefined : byId.get(effect.summary);
  if (resolved !== undefined) {
    found.push([resolved, "written"]);
  }
  for (const id of effect.possibleSummaries ?? []) {
    const maybe = byId.get(id);
    if (maybe !== undefined) {
      found.push([maybe, "possible"]);
    }
  }
  return found;
}

interface Parameter {
  name: string;
  position: number;
  /** How many parameters share the position, which is more than one for a destructured object. */
  sharing: number;
}

/**
 * Each function's parameters, from whichever of its summaries lists the
 * most. A pack's summary of a function can list none while the summary
 * reach built lists every one.
 */
function parametersByFunction(
  summaries: ReadonlyArray<BehavioralSummary>,
): Map<FunctionKey, Parameter[]> {
  const found = new Map<FunctionKey, Parameter[]>();
  for (const summary of summaries) {
    const inputs = summary.inputs.flatMap((input) =>
      input.type === "parameter"
        ? [{ name: input.name, position: input.position }]
        : [],
    );
    const fn = writtenFunctionOf(summary);
    if ((found.get(fn)?.length ?? 0) >= inputs.length) {
      continue;
    }
    found.set(
      fn,
      inputs.map((input) => ({
        ...input,
        sharing: inputs.filter((other) => other.position === input.position)
          .length,
      })),
    );
  }
  return found;
}

/**
 * What a call passes for each parameter. A parameter destructured out of
 * an object takes the field of that name. A parameter after a splat has
 * no position the call can be read at, so it is left out.
 */
function valuesPassed(
  call: RecordedCall,
  parameters: readonly Parameter[],
): PassedValue[] {
  const splat = call.args.findIndex(
    (arg) => arg?.kind === "identifier" && arg.name.startsWith("*"),
  );
  const values: PassedValue[] = [];
  for (const parameter of parameters) {
    if (splat !== -1 && parameter.position >= splat) {
      continue;
    }
    const value = argumentFor(call.args[parameter.position], parameter);
    if (value === undefined) {
      continue;
    }
    values.push({
      parameter: parameter.name,
      ...spellArgument(value, call.caller.location.file),
    });
  }
  return values;
}

function argumentFor(
  arg: RecordedArgument | undefined,
  parameter: Parameter,
): RecordedArgument | undefined {
  if (arg === undefined) {
    return undefined;
  }
  if (arg?.kind === "object" && parameter.name in arg.fields) {
    return arg.fields[parameter.name];
  }
  return parameter.sharing > 1 ? undefined : arg;
}

/**
 * The parameters each function uses for a column it selects rows by or
 * for the container it reaches. A container written as a reference,
 * `{location.table}`, is taken from the parameter the reference starts at.
 */
function selectsFacts(
  summaries: ReadonlyArray<BehavioralSummary>,
  parameters: ReadonlyMap<FunctionKey, readonly Parameter[]>,
): Array<[FunctionKey, string]> {
  const found = new Set<string>();
  const facts: Array<[FunctionKey, string]> = [];
  for (const summary of summaries) {
    const fn = writtenFunctionOf(summary);
    const named = new Set((parameters.get(fn) ?? []).map((one) => one.name));
    for (const name of SELECTOR_READERS.flatMap((read) => read(summary))) {
      const key = `${fn}\u0000${name}`;
      if (named.has(name) && !found.has(key)) {
        found.add(key);
        facts.push([fn, name]);
      }
    }
  }
  return facts;
}

/** Each reader gives the parameters one kind of record says a summary sends to its boundary. */
const SELECTOR_READERS: ReadonlyArray<
  (summary: BehavioralSummary) => string[]
> = [
  (summary) =>
    summary.transitions.flatMap((transition) =>
      (transition.provenance ?? []).flatMap((entry) =>
        entry.at.slot === "selector"
          ? entry.from.flatMap((source) =>
              source.type === "input" ? [source.inputRef] : [],
            )
          : [],
      ),
    ),
  containerParametersOf,
];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const F = v("f");
const G = v("g");
const C = v("c");
const N = v("n");
const M = v("m");
const O = v("o");
const S = v("s");
const V = v("val");

/**
 * A member is a function of the construct. A function of the same class
 * that calls a member, and serves no boundary of its own, is one too,
 * since a caller outside goes through it to reach the member.
 */
const MEMBERS: Rule[] = [
  rule("member", [F], [lit("seed", F)], "member-seed"),
  rule(
    "member",
    [C],
    [
      lit("member", F),
      lit("callsInto", C, F),
      lit("classOf", F, O),
      lit("classOf", C, O),
      notLit("entry", C),
    ],
    "member-through",
  ),
];

const COUNTED: Rule[] = [
  rule("counted", [F, N], [lit("selects", F, N)], "counted-selects"),
  rule(
    "counted",
    [F, N],
    [lit("forwards", F, N, G, M), lit("counted", G, M)],
    "counted-forwards",
  ),
  rule("passed", [S, N], [lit("passes", S, F, N, V)], "passed"),
  rule(
    "keyed",
    [S, N, V],
    [lit("site", S, F), lit("counted", F, N), lit("passes", S, F, N, V)],
    "keyed",
  ),
  rule(
    "leftOut",
    [S, N],
    [lit("site", S, F), lit("counted", F, N), notLit("passed", S, N)],
    "left-out",
  ),
];

/** The construct's functions, given the ones the subject names. */
export function constructMembers(
  facts: CallFactsForUse,
  seeds: Iterable<FunctionKey>,
  placement: {
    classOf: (fn: FunctionKey) => string | undefined;
    isEntry: (fn: FunctionKey) => boolean;
  },
): Set<FunctionKey> {
  const db = new Database();
  const placed = new Set<FunctionKey>();
  const place = (fn: FunctionKey): void => {
    if (placed.has(fn)) {
      return;
    }
    placed.add(fn);
    const owner = placement.classOf(fn);
    if (owner !== undefined) {
      db.add("classOf", [fn, owner]);
    }
    if (placement.isEntry(fn)) {
      db.add("entry", [fn]);
    }
  };
  for (const fn of seeds) {
    db.add("seed", [fn]);
    place(fn);
  }
  for (const call of facts.calls) {
    if (call.kind !== "written") {
      continue;
    }
    db.add("callsInto", [call.callerFunction, call.target]);
    place(call.callerFunction);
    place(call.target);
  }
  evaluate(db, MEMBERS);
  return new Set([...db.facts("member")].map((tuple) => String(tuple[0])));
}

/** What each call passes for the parameters that reach a boundary, and the ones it leaves out. */
export interface CallKeys {
  /** The counted parameters of each function, in parameter order. */
  counted: ReadonlyMap<FunctionKey, readonly string[]>;
  keyed: ReadonlyMap<string, ReadonlyMap<string, string>>;
  leftOut: ReadonlyMap<string, ReadonlySet<string>>;
}

export function callKeys(
  facts: CallFactsForUse,
  calls: readonly RecordedCall[],
): CallKeys {
  const db = new Database();
  for (const fact of facts.selects) {
    db.add("selects", fact);
  }
  for (const fact of facts.forwards) {
    db.add("forwards", fact);
  }
  for (const call of calls) {
    db.add("site", [call.id, call.target]);
    for (const value of facts.passed.get(call.id) ?? []) {
      db.add("passes", [call.id, call.target, value.parameter, value.blanked]);
    }
  }
  evaluate(db, COUNTED);

  const countedSet = new Map<FunctionKey, Set<string>>();
  for (const [fn, name] of db.facts("counted")) {
    const names = countedSet.get(String(fn)) ?? new Set<string>();
    names.add(String(name));
    countedSet.set(String(fn), names);
  }
  const counted = new Map<FunctionKey, string[]>();
  for (const [fn, names] of countedSet) {
    counted.set(
      fn,
      (facts.parameters.get(fn) ?? []).filter((name) => names.has(name)),
    );
  }
  return {
    counted,
    keyed: groupedBySite(db.facts("keyed"), (tuple) => [
      String(tuple[1]),
      String(tuple[2]),
    ]),
    leftOut: new Map(
      [
        ...groupedBySite(db.facts("leftOut"), (tuple) => [
          String(tuple[1]),
          "",
        ]),
      ].map(([site, names]) => [site, new Set(names.keys())]),
    ),
  };
}

function groupedBySite(
  tuples: Iterable<readonly (string | number)[]>,
  entry: (tuple: readonly (string | number)[]) => [string, string],
): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  for (const tuple of tuples) {
    const site = String(tuple[0]);
    const values = found.get(site) ?? new Map<string, string>();
    const [name, value] = entry(tuple);
    values.set(name, value);
    found.set(site, values);
  }
  return found;
}

/**
 * The name a report prints for a function's summary, without the file.
 * A summary settled on one boundary has that boundary after its name,
 * which can contain dots, so the name is read from the id without it.
 */
export function symbolOf(summary: BehavioralSummary): string {
  const id =
    settlingSuffix(summary) === ""
      ? originalIdOf(summary)
      : unsettledSummaryId(summary);
  return id.slice(id.lastIndexOf("::") + 2);
}
