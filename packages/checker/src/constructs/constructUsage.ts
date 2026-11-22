/**
 * How a construct is used: the calls into it, grouped by what each one
 * passes into the boundary, the callers grouped by class or module, the
 * entry points that reach each caller, and what suss could not follow
 * around it.
 *
 * A construct is one function or every method of one class. A function
 * can have several summaries over the same lines, such as the client a
 * pack recognized and the library summary reach built. Its callers are
 * the union of theirs, and its outcomes come from the pack's summary
 * ahead of the one reach built. Reach is ask's reach, with its possible
 * marks. The README in this folder says what is left out and why.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";

import { functionOf, writtenFunctionOf } from "../calls/callFacts.js";
import { ownBoundariesOf } from "../reach/ownBoundaries.js";
import { shortestFirst } from "../reach/unitReach.js";
import {
  callKeys,
  constructMembers,
  readCallsForUse,
  symbolOf,
} from "./constructCalls.js";
import { constructOutcomes, effectClassesOf } from "./constructOutcomes.js";

import type { BehavioralSummary, Predicate } from "@suss/behavioral-ir";
import type { CallFacts, FunctionKey } from "../calls/callFacts.js";
import type { TargetTouch } from "../reach/touches.js";
import type {
  CallFactsForUse,
  CallKeys,
  CallKind,
  RecordedCall,
} from "./constructCalls.js";
import type { EffectClass, UsageOutcome } from "./constructOutcomes.js";

export type { EffectClass, UsageOutcome } from "./constructOutcomes.js";

export interface UsageMember {
  unit: string;
  name: string;
  file: string;
  line: number;
  /** Set on a function of the same class that callers go through to reach the subject. */
  through?: true;
}

/** One value a call passes for a parameter that reaches the boundary. */
export interface UsageValue {
  parameter: string;
  /** As the source writes it, or null when the call leaves the parameter out. */
  spelled: string | null;
}

export interface UsageCall {
  caller: string;
  file: string;
  line: number;
  /** The call as the caller's source writes it. */
  callee: string;
  /** The member the call goes into, or the relation for a boundary's touch. */
  through: string;
  count: number;
  values: UsageValue[];
  /** The group the call is in, the same string for every call in it. */
  group: string;
  conditions: Predicate[];
  kind: CallKind | "touches";
}

export interface UsageGroup {
  key: string;
  through: string;
  calls: number;
  /** One entry per counted parameter, with computed parts as `_`. Null means the calls leave it out. */
  values: Array<{ parameter: string; blanked: string | null }>;
  /** Each way the calls spell those values, most common first. */
  spellings: Array<{ spelled: string; calls: number }>;
}

export interface UsageEntryPoint {
  boundary: string;
  unit: string;
  /** The calls from the entry point to the caller, empty when the caller is the entry point. */
  through: string[];
  possible?: true;
}

export interface UsageCaller {
  /** The class or module the callers are in, or their file when they are in none. */
  owner: string;
  units: string[];
  files: string[];
  calls: number;
  /** Certain entry points first, then possible ones. */
  reachedBy: UsageEntryPoint[];
}

/** The unit a gap is in: its id, the name a report prints, and where it starts. */
interface GapPlace {
  unit: string;
  name: string;
  file: string;
  line: number;
}

/**
 * `inside` is a call the construct makes that suss did not follow.
 * `unreached` is a caller no entry point reaches. `unfollowed` is a call
 * suss did not follow elsewhere that uses the name of one of the
 * construct's functions, with the entry points that reach the unit
 * making it.
 */
export type UsageGap =
  | ({ kind: "inside"; callee: string } & GapPlace)
  | ({ kind: "unreached" } & GapPlace)
  | ({
      kind: "unfollowed";
      callee: string;
      reachedBy: UsageEntryPoint[];
    } & GapPlace);

function gapPlace(unit: BehavioralSummary): GapPlace {
  return {
    unit: summaryIdentifier(unit),
    name: symbolOf(unit),
    file: unit.location.file,
    line: unit.location.range.start,
  };
}

export interface ConstructUsage {
  members: UsageMember[];
  touches: EffectClass[];
  outcomes: UsageOutcome[];
  calls: UsageCall[];
  groups: UsageGroup[];
  callers: UsageCaller[];
  /** Every entry point that reaches a caller, certain first. */
  entryPoints: UsageEntryPoint[];
  gaps: UsageGap[];
}

/** What the question is about: some functions, or a boundary's touches. */
export type ConstructSubject =
  | { kind: "units"; units: readonly BehavioralSummary[] }
  | { kind: "boundary"; touches: readonly TargetTouch[] };

/** One call into the construct, before it is grouped. */
interface ConstructCall {
  caller: BehavioralSummary;
  through: string;
  callee: string;
  line: number;
  count: number;
  values: UsageValue[];
  blanked: Array<string | null>;
  conditions: Predicate[];
  kind: CallKind | "touches";
}

export function constructUsage(
  summaries: ReadonlyArray<BehavioralSummary>,
  facts: CallFacts,
  subject: ConstructSubject,
): ConstructUsage {
  const read = USAGE_READERS[subject.kind](summaries, facts, subject as never);
  const reach = new EntryPointReach(facts);
  const callers = callerGroups(read.calls, reach);
  return {
    members: read.members,
    touches: effectClassesOf(read.units, facts),
    outcomes: constructOutcomes(read.units),
    calls: read.calls.map((call) => ({
      caller: summaryIdentifier(call.caller),
      file: call.caller.location.file,
      line: call.line,
      callee: call.callee,
      through: call.through,
      count: call.count,
      values: call.values,
      group: groupKey(call),
      conditions: call.conditions,
      kind: call.kind,
    })),
    groups: callGroups(read.calls),
    callers,
    entryPoints: certainFirst(callers.flatMap((caller) => caller.reachedBy)),
    gaps: [
      ...insideGaps(read.units),
      ...unreachedCallers(read.calls, reach),
      ...unfollowedNamedLike(summaries, read, reach),
    ],
  };
}

interface UsageRead {
  members: UsageMember[];
  /** The summaries of the functions the subject names. */
  units: BehavioralSummary[];
  /** The functions of the construct, including the ones callers go through. */
  inside: Set<FunctionKey>;
  /** The names an unfollowed call would have to use to be a call into the construct. */
  names: Set<string>;
  calls: ConstructCall[];
}

const USAGE_READERS: {
  [K in ConstructSubject["kind"]]: (
    summaries: ReadonlyArray<BehavioralSummary>,
    facts: CallFacts,
    subject: Extract<ConstructSubject, { kind: K }>,
  ) => UsageRead;
} = {
  units: readUnitUsage,
  boundary: readBoundaryUsage,
};

/** The construct's own functions, and every call into them from a function outside it. */
function readUnitUsage(
  summaries: ReadonlyArray<BehavioralSummary>,
  facts: CallFacts,
  subject: { units: readonly BehavioralSummary[] },
): UsageRead {
  const forUse = readCallsForUse(summaries);
  const unitsOf = summariesByWrittenFunction(summaries);
  const seeds = new Set(subject.units.map(writtenFunctionOf));
  const members = constructMembers(forUse, seeds, {
    classOf: (fn) => classOf(unitsOf.get(fn) ?? []),
    isEntry: (fn) =>
      (unitsOf.get(fn) ?? []).some(
        (unit) => ownBoundariesOf(facts, functionOf(unit)).length > 0,
      ),
  });
  const into = forUse.calls.filter(
    (call) => members.has(call.target) && !members.has(call.callerFunction),
  );
  const keys = callKeys(forUse, into);
  const memberUnits = [...members].flatMap((fn) => unitsOf.get(fn) ?? []);
  return {
    members: [...members].map((fn) => {
      const unit = representativeOf(unitsOf.get(fn) ?? []);
      return {
        unit: summaryIdentifier(unit),
        name: symbolOf(unit),
        file: unit.location.file,
        line: unit.location.range.start,
        ...(seeds.has(fn) ? {} : { through: true as const }),
      };
    }),
    units: memberUnits.filter((unit) => seeds.has(writtenFunctionOf(unit))),
    inside: members,
    names: new Set(memberUnits.map((unit) => methodName(unit.identity.name))),
    calls: into.map((call) =>
      constructCall(call, forUse, keys, unitsOf.get(call.target) ?? []),
    ),
  };
}

function constructCall(
  call: RecordedCall,
  forUse: CallFactsForUse,
  keys: CallKeys,
  targetUnits: readonly BehavioralSummary[],
): ConstructCall {
  const counted = keys.counted.get(call.target) ?? [];
  const keyed = keys.keyed.get(call.id);
  const leftOut = keys.leftOut.get(call.id);
  const spelled = new Map(
    (forUse.passed.get(call.id) ?? []).map((value) => [
      value.parameter,
      value.spelled,
    ]),
  );
  return {
    caller: call.caller,
    through: methodName(representativeOf(targetUnits).identity.name),
    callee: call.callee,
    line: call.line ?? call.caller.location.range.start,
    count: call.count,
    values: counted.map((parameter) => ({
      parameter,
      spelled: leftOut?.has(parameter)
        ? null
        : (spelled.get(parameter) ?? null),
    })),
    blanked: counted.map((parameter) =>
      leftOut?.has(parameter) ? null : (keyed?.get(parameter) ?? null),
    ),
    conditions: [...call.conditions],
    kind: call.kind,
  };
}

/**
 * Every place a unit touches the boundary, one call each. The columns an
 * access selects by are what it passes into the boundary.
 */
function readBoundaryUsage(
  _summaries: ReadonlyArray<BehavioralSummary>,
  _facts: CallFacts,
  subject: { touches: readonly TargetTouch[] },
): UsageRead {
  const seen = new Set<string>();
  const calls: ConstructCall[] = [];
  for (const { summary, touched } of subject.touches) {
    if (touched.relation === "provides") {
      continue;
    }
    const line = touched.line ?? summary.location.range.start;
    const id = [
      writtenFunctionOf(summary),
      line,
      touched.callee ?? "",
      touched.relation,
    ].join("\u0000");
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const by = touched.access?.by ?? [];
    const selected = by.length === 0 ? null : by.join(", ");
    calls.push({
      caller: summary,
      through: touched.relation,
      callee: touched.callee ?? touched.label,
      line,
      count: 1,
      values: [{ parameter: "by", spelled: selected }],
      blanked: [selected],
      conditions: [],
      kind: "touches",
    });
  }
  return {
    members: [],
    units: [],
    inside: new Set(),
    names: new Set(),
    calls,
  };
}

function summariesByWrittenFunction(
  summaries: ReadonlyArray<BehavioralSummary>,
): Map<FunctionKey, BehavioralSummary[]> {
  const found = new Map<FunctionKey, BehavioralSummary[]>();
  for (const summary of summaries) {
    if (summary.receiverConstruction !== undefined) {
      continue;
    }
    const fn = writtenFunctionOf(summary);
    found.set(fn, [...(found.get(fn) ?? []), summary]);
  }
  return found;
}

/** The summary a member is printed as. The one reach built says the class, so it comes first. */
function representativeOf(
  units: readonly BehavioralSummary[],
): BehavioralSummary {
  const named = units.find((unit) => symbolOf(unit).includes("."));
  const chosen = named ?? units[0];
  if (chosen === undefined) {
    throw new Error("a construct member has no summary");
  }
  return chosen;
}

/** The class a function is a method of, or undefined for a function in no class. */
function classOf(units: readonly BehavioralSummary[]): string | undefined {
  for (const unit of units) {
    const owner = classNameOf(unit);
    if (owner !== undefined) {
      return `${unit.location.file}::${owner}`;
    }
  }
  return undefined;
}

/** The class or module a caller is grouped under, or its file. */
function ownerOf(unit: BehavioralSummary): string {
  return classNameOf(unit) ?? unit.location.file;
}

/**
 * The class in a method's name, `Outbound` in `Outbound.fetch`. A file's own
 * top-level code is named after the file, and its dot is the extension.
 */
export function classNameOf(unit: BehavioralSummary): string | undefined {
  if (unit.kind === "module-init") {
    return undefined;
  }
  const symbol = symbolOf(unit);
  const dot = symbol.lastIndexOf(".");
  return dot > 0 ? symbol.slice(0, dot) : undefined;
}

/** The method a name ends in, which is what an unfollowed call would spell. */
function methodName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

function groupKey(call: ConstructCall): string {
  return [call.through, ...call.blanked.map((value) => value ?? "")].join(
    "\u0000",
  );
}

/** The calls grouped by the member they go into and what they pass. */
function callGroups(calls: readonly ConstructCall[]): UsageGroup[] {
  const groups = new Map<
    string,
    { group: UsageGroup; bySpelling: Map<string, number> }
  >();
  for (const call of calls) {
    const key = groupKey(call);
    const found = groups.get(key) ?? {
      group: {
        key,
        through: call.through,
        calls: 0,
        values: call.values.map((value, at) => ({
          parameter: value.parameter,
          blanked: call.blanked[at] ?? null,
        })),
        spellings: [],
      },
      bySpelling: new Map<string, number>(),
    };
    found.group.calls += call.count;
    const spelled = call.values.map((value) => value.spelled ?? "").join(", ");
    found.bySpelling.set(
      spelled,
      (found.bySpelling.get(spelled) ?? 0) + call.count,
    );
    groups.set(key, found);
  }
  return [...groups.values()]
    .map(({ group, bySpelling }) => ({
      ...group,
      spellings: [...bySpelling]
        .map(([spelled, count]) => ({ spelled, calls: count }))
        .sort(
          (a, b) => b.calls - a.calls || a.spelled.localeCompare(b.spelled),
        ),
    }))
    .sort(
      (a, b) =>
        a.through.localeCompare(b.through) ||
        b.calls - a.calls ||
        a.key.localeCompare(b.key),
    );
}

/** The callers grouped by class or module, largest first. */
function callerGroups(
  calls: readonly ConstructCall[],
  reach: EntryPointReach,
): UsageCaller[] {
  const groups = new Map<
    string,
    {
      units: Set<string>;
      files: Set<string>;
      calls: number;
      kinds: Map<FunctionKey, Set<ConstructCall["kind"]>>;
    }
  >();
  for (const call of calls) {
    const owner = ownerOf(call.caller);
    const group = groups.get(owner) ?? {
      units: new Set<string>(),
      files: new Set<string>(),
      calls: 0,
      kinds: new Map<FunctionKey, Set<ConstructCall["kind"]>>(),
    };
    group.units.add(summaryIdentifier(call.caller));
    group.files.add(call.caller.location.file);
    group.calls += call.count;
    const fn = functionOf(call.caller);
    group.kinds.set(fn, new Set([...(group.kinds.get(fn) ?? []), call.kind]));
    groups.set(owner, group);
  }
  return [...groups]
    .map(([owner, group]) => ({
      owner,
      units: [...group.units].sort(),
      files: [...group.files].sort(),
      calls: group.calls,
      reachedBy: certainFirst(
        [...group.kinds].flatMap(([fn, kinds]) =>
          callerEntryPoints(fn, kinds, reach),
        ),
      ),
    }))
    .sort((a, b) => b.calls - a.calls || a.owner.localeCompare(b.owner));
}

/**
 * The entry points that reach a caller's calls. A wrapper runs when a
 * request enters the unit it wraps, and not when other code calls that
 * unit as a function, so a caller that only wraps gives its own entry
 * point and nothing that reaches it. A caller whose every call may run
 * another function makes each of its entry points possible.
 */
function callerEntryPoints(
  fn: FunctionKey,
  kinds: ReadonlySet<ConstructCall["kind"]>,
  reach: EntryPointReach,
): UsageEntryPoint[] {
  if (kinds.size === 1 && kinds.has("wraps")) {
    return reach.own(fn);
  }
  if (kinds.size === 1 && kinds.has("possible")) {
    return reach.of(fn).map((entry) => ({ ...entry, possible: true }));
  }
  return reach.of(fn);
}

/** One entry per entry point, the certain path kept over a possible one, certain entries first. */
function certainFirst(entries: readonly UsageEntryPoint[]): UsageEntryPoint[] {
  const best = new Map<string, UsageEntryPoint>();
  for (const entry of entries) {
    const seen = best.get(entry.boundary);
    if (seen === undefined || ranksBefore(entry, seen)) {
      best.set(entry.boundary, entry);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      Number(a.possible === true) - Number(b.possible === true) ||
      a.through.length - b.through.length ||
      a.boundary.localeCompare(b.boundary),
  );
}

function ranksBefore(entry: UsageEntryPoint, other: UsageEntryPoint): boolean {
  if ((entry.possible === true) !== (other.possible === true)) {
    return other.possible === true;
  }
  return entry.through.length < other.through.length;
}

/**
 * The entry points that reach a function, through ask's reach: the
 * shortest path back from each one, marked possible when a hop on it
 * picks its function at run time. Each function is asked once.
 */
class EntryPointReach {
  private readonly asked = new Map<FunctionKey, UsageEntryPoint[]>();

  constructor(private readonly facts: CallFacts) {}

  /** The boundaries the function serves itself. */
  own(fn: FunctionKey): UsageEntryPoint[] {
    return ownBoundariesOf(this.facts, fn).map((own) => ({
      boundary: own.touched.label,
      unit: summaryIdentifier(own.summary),
      through: [],
    }));
  }

  of(fn: FunctionKey): UsageEntryPoint[] {
    const known = this.asked.get(fn);
    if (known !== undefined) {
      return known;
    }
    const found = this.own(fn);
    const reaching = this.facts.reaching({ functions: [fn], keys: [] });
    for (const [from, through, possible] of shortestFirst(
      reaching,
      this.facts,
    )) {
      for (const own of ownBoundariesOf(this.facts, from)) {
        found.push({
          boundary: own.touched.label,
          unit: summaryIdentifier(own.summary),
          through,
          ...(possible ? { possible: true as const } : {}),
        });
      }
    }
    const answer = certainFirst(found);
    this.asked.set(fn, answer);
    return answer;
  }
}

/** The calls suss stopped at inside the construct's own summaries. */
function insideGaps(units: readonly BehavioralSummary[]): UsageGap[] {
  const seen = new Set<string>();
  const gaps: UsageGap[] = [];
  for (const unit of units) {
    for (const gap of unit.gaps) {
      if (gap.type !== "unfollowedCall" || gap.callee === undefined) {
        continue;
      }
      const key = `${writtenFunctionOf(unit)}\u0000${gap.callee}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      gaps.push({ kind: "inside", callee: gap.callee, ...gapPlace(unit) });
    }
  }
  return gaps;
}

/** Callers that no entry point here reaches, so whatever runs them is outside what suss read. */
function unreachedCallers(
  calls: readonly ConstructCall[],
  reach: EntryPointReach,
): UsageGap[] {
  const seen = new Set<FunctionKey>();
  const gaps: UsageGap[] = [];
  for (const call of calls) {
    const fn = functionOf(call.caller);
    if (seen.has(fn)) {
      continue;
    }
    seen.add(fn);
    if (reach.of(fn).length === 0) {
      gaps.push({ kind: "unreached", ...gapPlace(call.caller) });
    }
  }
  return gaps;
}

/**
 * Calls suss could not follow that use the name of one of the
 * construct's functions. Each may be a call into the construct, so the
 * entry points that reach it may reach the construct too.
 */
function unfollowedNamedLike(
  summaries: ReadonlyArray<BehavioralSummary>,
  read: UsageRead,
  reach: EntryPointReach,
): UsageGap[] {
  const seen = new Set<string>();
  const gaps: UsageGap[] = [];
  for (const summary of summaries) {
    if (
      summary.receiverConstruction !== undefined ||
      read.inside.has(writtenFunctionOf(summary))
    ) {
      continue;
    }
    for (const gap of summary.gaps) {
      if (
        gap.type !== "unfollowedCall" ||
        gap.callee === undefined ||
        !read.names.has(calledMethod(gap.callee))
      ) {
        continue;
      }
      const key = `${writtenFunctionOf(summary)}\u0000${gap.callee}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      gaps.push({
        kind: "unfollowed",
        callee: gap.callee,
        reachedBy: reach.of(functionOf(summary)),
        ...gapPlace(summary),
      });
    }
  }
  return gaps;
}

/** The method a call as written runs: the last name before its arguments or block. */
function calledMethod(callee: string): string {
  const head = callee.split(/[({\s]/, 1)[0] ?? callee;
  return head.slice(head.lastIndexOf(".") + 1);
}
