/**
 * Every call one function makes into another, one entry per place the
 * call is written, and the facts and rules that say what each call
 * passes into a boundary and which request it makes.
 *
 * A call counts a parameter when the function uses it for a boundary
 * field or a column it selects rows by, or passes it on to a function
 * that does. Those are one-hop facts, `selects` and `forwards`, and the
 * `counted` rule closes over them, so `enabled?(key)` counts `key`
 * because the `lookup(key)` it calls selects rows by it. A call that
 * leaves a counted parameter out passes its default when the source
 * writes the default as a literal. The README in this folder says how a
 * call is matched to the request it makes.
 */

import {
  bindingIs,
  originalIdOf,
  predicateRefs,
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
import { argumentForParameter } from "../calls/passedArguments.js";
import { containerParametersOf } from "../storage/containerParameters.js";
import { literalOf, spellArgument, spellLiteral } from "./argumentSpelling.js";

import type {
  BehavioralSummary,
  ComparisonOp,
  Effect,
  Predicate,
  ValueRef,
} from "@suss/behavioral-ir";
import type { Rule } from "@suss/datalog";
import type { FunctionKey } from "../calls/callFacts.js";
import type { RecordedArgument } from "../calls/passedArguments.js";
import type { LiteralValue, SpelledArgument } from "./argumentSpelling.js";

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
  /** The value, when the call writes it out as a literal. */
  literal?: LiteralValue;
}

/** A parameter default the source writes as a literal, and the same value as a caller would spell it. */
export interface ParameterDefault {
  literal: LiteralValue;
  spelled: string;
}

/** A request a function makes: one client unit over it, and the conditions it is made under. */
export interface RequestUnit {
  fn: FunctionKey;
  unit: BehavioralSummary;
  conditions: readonly RequestCondition[];
}

export interface RequestCondition {
  /** As the client records it, or null for one the summaries do not read. */
  predicate: Predicate | null;
  /** A parameter and a literal it must equal, or must not, or null when no literal decides the condition. */
  test: LiteralTest | null;
  /**
   * False for a condition every request of the function is made under.
   * It says whether the function makes a request, and not which one.
   */
  chooses: boolean;
}

export interface LiteralTest {
  parameter: string;
  /** The literal as a caller would spell it. */
  value: string;
  equal: boolean;
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
  /** Each function's parameters that have a literal default. */
  defaults: ReadonlyMap<FunctionKey, ReadonlyMap<string, ParameterDefault>>;
  requests: readonly RequestUnit[];
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

  const requests = requestUnits(summaries);
  return {
    calls: [...calls.values()],
    parameters: new Map(
      [...parameters].map(([fn, inputs]) => [
        fn,
        inputs.map((input) => input.name),
      ]),
    ),
    passed,
    selects: selectsFacts(summaries, requests, parameters),
    forwards,
    defaults: defaultsByFunction(parameters),
    requests,
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
  default?: ParameterDefault;
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
      input.type === "parameter" ? [input] : [],
    );
    const fn = writtenFunctionOf(summary);
    if ((found.get(fn)?.length ?? 0) >= inputs.length) {
      continue;
    }
    found.set(
      fn,
      inputs.map((input) => ({
        name: input.name,
        position: input.position,
        sharing: inputs.filter((other) => other.position === input.position)
          .length,
        ...(input.default?.type === "literal"
          ? {
              default: {
                literal: input.default.value,
                spelled: spellLiteral(
                  input.default.value,
                  summary.location.file,
                ),
              },
            }
          : {}),
      })),
    );
  }
  return found;
}

function defaultsByFunction(
  parameters: ReadonlyMap<FunctionKey, readonly Parameter[]>,
): Map<FunctionKey, Map<string, ParameterDefault>> {
  const found = new Map<FunctionKey, Map<string, ParameterDefault>>();
  for (const [fn, inputs] of parameters) {
    const defaulted = new Map<string, ParameterDefault>();
    for (const input of inputs) {
      if (input.default !== undefined) {
        defaulted.set(input.name, input.default);
      }
    }
    if (defaulted.size > 0) {
      found.set(fn, defaulted);
    }
  }
  return found;
}

/**
 * What a call passes for each parameter. A parameter destructured out of
 * an object takes the field of that name. JavaScript fills a parameter
 * the call passes `undefined` for with its default, so that call leaves
 * it out.
 */
function valuesPassed(
  call: RecordedCall,
  parameters: readonly Parameter[],
): PassedValue[] {
  const values: PassedValue[] = [];
  for (const parameter of parameters) {
    const value = argumentFor(
      argumentForParameter(call.args, parameter, parameters),
      parameter,
    );
    if (value === undefined || value?.kind === "undefined") {
      continue;
    }
    const literal = literalOf(value);
    values.push({
      parameter: parameter.name,
      ...spellArgument(value, call.caller.location.file),
      ...(literal === undefined ? {} : { literal }),
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
 * The parameters each function uses for a column it selects rows by, for
 * the container it reaches, or for the request it makes. A container
 * written as a reference, `{location.table}`, is taken from the parameter
 * the reference starts at.
 */
function selectsFacts(
  summaries: ReadonlyArray<BehavioralSummary>,
  requests: readonly RequestUnit[],
  parameters: ReadonlyMap<FunctionKey, readonly Parameter[]>,
): Array<[FunctionKey, string]> {
  const read = summaries.flatMap((summary) =>
    SELECTOR_READERS.flatMap((reader) => reader(summary)).map(
      (name): [FunctionKey, string] => [writtenFunctionOf(summary), name],
    ),
  );
  const found = new Set<string>();
  const facts: Array<[FunctionKey, string]> = [];
  for (const [fn, name] of [...read, ...choosingParameters(requests)]) {
    const key = `${fn}\u0000${name}`;
    const named = (parameters.get(fn) ?? []).some((one) => one.name === name);
    if (named && !found.has(key)) {
      found.add(key);
      facts.push([fn, name]);
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
  bindingFromParameters,
];

/**
 * The parameters a client takes its method and host from. A host read
 * out of a URL counts the URL's parameter.
 */
function bindingFromParameters(summary: BehavioralSummary): string[] {
  const from = summary.bindingFrom;
  return [...(from?.method ?? []), ...(from?.host ?? [])].flatMap(rootInputOf);
}

function rootInputOf(ref: ValueRef): string[] {
  if (ref.type === "derived") {
    return rootInputOf(ref.from);
  }
  return ref.type === "input" ? [ref.inputRef] : [];
}

/**
 * Every client unit, with the conditions its request is made under. A
 * condition every request of the function shares, such as a timeout
 * around all of them, chooses none of them. When a function has several
 * requests and one of them has no condition of its own, the function
 * picks it by something the summaries do not read, so that request gets
 * one choosing condition no literal decides.
 */
function requestUnits(
  summaries: ReadonlyArray<BehavioralSummary>,
): RequestUnit[] {
  const byFunction = new Map<FunctionKey, BehavioralSummary[]>();
  for (const summary of summaries) {
    if (
      summary.kind === "client" &&
      summary.receiverConstruction === undefined
    ) {
      const fn = writtenFunctionOf(summary);
      byFunction.set(fn, [...(byFunction.get(fn) ?? []), summary]);
    }
  }
  return [...byFunction].flatMap(([fn, units]) => {
    const shared = sharedConditions(units);
    return units.map((unit) => {
      const conditions = (unit.bindingFrom?.when ?? []).map((one) => ({
        predicate: one,
        test: literalTest(one, unit.location.file),
        chooses: !shared.has(JSON.stringify(one)),
      }));
      const unread = units.length > 1 && !conditions.some((one) => one.chooses);
      return {
        fn,
        unit,
        conditions: unread
          ? [...conditions, { predicate: null, test: null, chooses: true }]
          : conditions,
      };
    });
  });
}

/** The conditions every one of the units lists, each as its JSON. */
function sharedConditions(units: readonly BehavioralSummary[]): Set<string> {
  const [first, ...rest] = units.map(
    (unit) =>
      new Set((unit.bindingFrom?.when ?? []).map((one) => JSON.stringify(one))),
  );
  return new Set(
    [...(first ?? [])].filter((key) => rest.every((keys) => keys.has(key))),
  );
}

/** The parameters each function's choosing conditions test, which decide the request a call makes. */
function choosingParameters(
  requests: readonly RequestUnit[],
): Array<[FunctionKey, string]> {
  return requests.flatMap((request) =>
    request.conditions.flatMap((condition) =>
      condition.chooses && condition.predicate !== null
        ? predicateRefs(condition.predicate)
            .flatMap(rootInputOf)
            .map((name): [FunctionKey, string] => [request.fn, name])
        : [],
    ),
  );
}

/** A condition read as a parameter it compares with a literal, or null when it is not one. */
function literalTest(predicate: Predicate, file: string): LiteralTest | null {
  if (predicate.type === "negation") {
    const inner = literalTest(predicate.operand, file);
    return inner === null ? null : { ...inner, equal: !inner.equal };
  }
  if (predicate.type !== "comparison") {
    return null;
  }
  const equal = EQUALITY[predicate.op];
  const sides =
    parameterAndLiteral(predicate.left, predicate.right) ??
    parameterAndLiteral(predicate.right, predicate.left);
  if (equal === undefined || sides === null) {
    return null;
  }
  return {
    parameter: sides.parameter,
    value: spellLiteral(sides.literal, file),
    equal,
  };
}

const EQUALITY: Partial<Record<ComparisonOp, boolean>> = {
  eq: true,
  neq: false,
};

function parameterAndLiteral(
  subject: ValueRef,
  other: ValueRef,
): { parameter: string; literal: LiteralValue } | null {
  if (
    subject.type !== "input" ||
    subject.path.length > 0 ||
    other.type !== "literal"
  ) {
    return null;
  }
  return { parameter: subject.inputRef, literal: other.value };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const F = v("f");
const G = v("g");
const C = v("c");
const K = v("k");
const N = v("n");
const M = v("m");
const O = v("o");
const S = v("s");
const U = v("u");
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

/**
 * A call gives a parameter what it passes, or the default when it passes
 * nothing and the default is a literal, and is keyed by what it gives
 * the counted ones. `settled` says the value is a literal, which is what
 * lets a condition on it be decided.
 */
const COUNTED: Rule[] = [
  rule("counted", [F, N], [lit("selects", F, N)], "counted-selects"),
  rule(
    "counted",
    [F, N],
    [lit("forwards", F, N, G, M), lit("counted", G, M)],
    "counted-forwards",
  ),
  rule("passed", [S, N], [lit("passes", S, F, N, V)], "passed"),
  rule("defaulted", [F, N], [lit("default", F, N, V)], "defaulted"),
  rule("given", [S, N, V], [lit("passes", S, F, N, V)], "given"),
  rule(
    "given",
    [S, N, V],
    [lit("site", S, F), notLit("passed", S, N), lit("default", F, N, V)],
    "given-default",
  ),
  rule(
    "keyed",
    [S, N, V],
    [lit("site", S, F), lit("counted", F, N), lit("given", S, N, V)],
    "keyed",
  ),
  rule(
    "leftOut",
    [S, N],
    [
      lit("site", S, F),
      lit("counted", F, N),
      notLit("passed", S, N),
      notLit("defaulted", F, N),
    ],
    "left-out",
  ),
  rule("settled", [S, N], [lit("passesLiteral", S, N)], "settled-literal"),
  rule(
    "settled",
    [S, N],
    [lit("site", S, F), notLit("passed", S, N), lit("defaulted", F, N)],
    "settled-default",
  ),
];

/**
 * A call makes request `u` when no condition `u` is made under is false
 * of what it passes, and every condition that chooses `u` is true of it.
 * It may make `u` when a choosing condition is open: it tests a value
 * the call does not settle, or no literal decides it.
 */
const REQUESTS: Rule[] = [
  rule(
    "isTrue",
    [S, K],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("condition", U, K),
      lit("requires", K, N, V),
      lit("settled", S, N),
      lit("given", S, N, V),
    ],
    "true-requires",
  ),
  rule(
    "isTrue",
    [S, K],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("condition", U, K),
      lit("excludes", K, N, V),
      lit("settled", S, N),
      notLit("given", S, N, V),
    ],
    "true-excludes",
  ),
  rule(
    "isFalse",
    [S, K],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("condition", U, K),
      lit("requires", K, N, V),
      lit("settled", S, N),
      notLit("given", S, N, V),
    ],
    "false-requires",
  ),
  rule(
    "isFalse",
    [S, K],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("condition", U, K),
      lit("excludes", K, N, V),
      lit("settled", S, N),
      lit("given", S, N, V),
    ],
    "false-excludes",
  ),
  rule(
    "ruledOut",
    [S, U],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("condition", U, K),
      lit("isFalse", S, K),
    ],
    "ruled-out",
  ),
  rule(
    "open",
    [S, U],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("chooses", U, K),
      notLit("isTrue", S, K),
    ],
    "open",
  ),
  rule(
    "sends",
    [S, U],
    [
      lit("site", S, F),
      lit("request", F, U),
      notLit("ruledOut", S, U),
      notLit("open", S, U),
    ],
    "sends",
  ),
  rule(
    "maySend",
    [S, U],
    [
      lit("site", S, F),
      lit("request", F, U),
      lit("open", S, U),
      notLit("ruledOut", S, U),
    ],
    "may-send",
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

/**
 * What each call passes for the parameters that reach a boundary, the
 * ones it leaves out that have no default, and the requests it makes.
 */
export interface CallKeys {
  /** The counted parameters of each function, in parameter order. */
  counted: ReadonlyMap<FunctionKey, readonly string[]>;
  keyed: ReadonlyMap<string, ReadonlyMap<string, string>>;
  leftOut: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each call's requests by unit id, true when it makes the request and false when it may. */
  sends: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
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
  for (const [fn, defaulted] of facts.defaults) {
    for (const [name, value] of defaulted) {
      db.add("default", [fn, name, value.spelled]);
    }
  }
  addRequestFacts(db, facts.requests);
  for (const call of calls) {
    db.add("site", [call.id, call.target]);
    for (const value of facts.passed.get(call.id) ?? []) {
      db.add("passes", [call.id, call.target, value.parameter, value.blanked]);
      if (value.literal !== undefined) {
        db.add("passesLiteral", [call.id, value.parameter]);
      }
    }
  }
  evaluate(db, [...COUNTED, ...REQUESTS]);

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
    sends: requestsBySite(db),
  };
}

function addRequestFacts(db: Database, requests: readonly RequestUnit[]): void {
  for (const request of requests) {
    const unit = summaryIdentifier(request.unit);
    db.add("request", [request.fn, unit]);
    request.conditions.forEach(({ test, chooses }, at) => {
      const condition = `${unit}\u0000${at}`;
      db.add("condition", [unit, condition]);
      if (chooses) {
        db.add("chooses", [unit, condition]);
      }
      if (test !== null) {
        db.add(test.equal ? "requires" : "excludes", [
          condition,
          test.parameter,
          test.value,
        ]);
      }
    });
  }
}

function requestsBySite(db: Database): Map<string, Map<string, boolean>> {
  const found = new Map<string, Map<string, boolean>>();
  const add = (site: string, unit: string, certain: boolean): void => {
    const units = found.get(site) ?? new Map<string, boolean>();
    units.set(unit, certain);
    found.set(site, units);
  };
  for (const [site, unit] of db.facts("sends")) {
    add(String(site), String(unit), true);
  }
  for (const [site, unit] of db.facts("maySend")) {
    add(String(site), String(unit), false);
  }
  return found;
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
 * The HTTP method a request sends for one call. A client that takes its
 * method from a parameter sends what the call passes for it, or the
 * default, upper-cased. Null when that value is not a literal string,
 * or when the client records no method.
 */
export function requestMethod(
  unit: BehavioralSummary,
  passed: readonly PassedValue[],
  defaults: ReadonlyMap<string, ParameterDefault> | undefined,
): string | null {
  const from = unit.bindingFrom?.method;
  if (from === undefined) {
    return bindingIs(unit.identity.boundaryBinding, "rest")
      ? unit.identity.boundaryBinding.semantics.method
      : null;
  }
  const parameters = new Set(
    from.map((ref) =>
      ref.type === "input" && ref.path.length === 0 ? ref.inputRef : null,
    ),
  );
  const [parameter] = [...parameters];
  if (parameters.size !== 1 || parameter === null || parameter === undefined) {
    return null;
  }
  const given = passed.find((value) => value.parameter === parameter);
  const literal =
    given === undefined ? defaults?.get(parameter)?.literal : given.literal;
  return typeof literal === "string" ? literal.toUpperCase() : null;
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
