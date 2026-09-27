/**
 * Walks from each discovered unit to the project methods it calls, and
 * gives each method reached a `library` summary of its own. What a
 * graphql-ruby field reaches can then be read from the summaries alone.
 *
 * Seeds become `entry` facts. Each scanned body adds a `calls` fact for
 * every callee it can place, and the rules derive what is reachable until
 * the set stops growing. A call that cannot be placed becomes an
 * unfollowed-call gap on the summary of the body it is in. A file's
 * load-time statements are a seed too, with the program as the node.
 * DESIGN.md describes how a callee is resolved and where the walk stops.
 */

import {
  functionCallBinding,
  placeArgTargets,
  placeCalleeParameters,
  placeCalls,
  recordParameterGaps,
  TargetPlacements,
  unfollowedCallGap,
  worthRecording,
} from "@suss/behavioral-ir";
import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";
import { assembleSummary } from "@suss/extractor";
import {
  type Dependencies,
  type DependencyLedger,
  noDependencies,
} from "@suss/resolution";

import {
  bodyStatements,
  field,
  PROGRAM_TYPE,
  rangeOf,
  spanOf,
} from "../ast.js";
import { bodyOfMethod } from "../discovery.js";
import { nodeId } from "../facts/values.js";
import {
  bodyCalls,
  calleeText,
  callsReported,
  isArglessReceiverCall,
  methodBody,
  moduleScopeBody,
} from "../paths/effects.js";
import { callbacksReached, storageClaims } from "../storage.js";
import { forgetEvaluations } from "../values/evaluator.js";
import {
  calleeSpellings,
  mightReadAsACall,
  readsAsACall,
  resolveCallee,
  resolveMethodReference,
} from "./resolveCallee.js";

import type {
  BehavioralSummary,
  DeclaredAt,
  ParameterCall,
  UnfollowedCall,
} from "@suss/behavioral-ir";
import type {
  ExtractorOptions,
  RawCodeStructure,
  RawParameter,
} from "@suss/extractor";
import type { BodyReadOptions } from "../discovery.js";
import type { RbNode } from "../parser.js";
import type { ReadableBody } from "../paths/effects.js";
import type { WalkReplay } from "../reuse.js";
import type {
  CalleeResolution,
  CalleeSpellings,
  CallSite,
  ReachContext,
  ReachedFunction,
} from "./resolveCallee.js";

export interface ReachOptions extends BodyReadOptions {
  /** Every class the run defines and every method defined outside a class, which calls are resolved against. */
  readonly context: ReachContext;
  /** Turns an absolute path into the `location.file` or `declaredAt.file` to record, the same way discovered units record theirs. */
  readonly displayPathOf: (file: string) => string;
  /** How much of what the walk could not follow goes on a summary. Permissive when absent. */
  readonly gapHandling?: ExtractorOptions["gapHandling"];
  /** What an earlier run's walk found where it is still valid, so those bodies are not scanned again. */
  readonly replay?: WalkReplay;
  /** Set when a cache is recording what each scanned body depended on. */
  readonly ledger?: DependencyLedger;
}

/** A method one scan followed, as a cache stores it. */
export interface StoredTarget {
  readonly key: string;
  readonly file: string;
  readonly name: string;
  readonly exportPath: string[];
  readonly enclosingQualifiedName: string | null;
}

/** What one scan of a body found, in a form JSON keeps. */
export interface StoredScan {
  readonly followed: StoredTarget[];
  readonly stops: UnfollowedCall[];
  readonly targets: [string, DeclaredAt][];
  readonly argTargets: [string, [number, DeclaredAt][]][];
  readonly parameterCalls: ParameterCall[];
  readonly passedPositions: string[];
  readonly propertyReads: string[];
}

/** A discovered unit's method, or a file's program node, keyed the same way as its summary's span. */
export interface Seed {
  readonly key: string;
  readonly file: string;
  readonly node: RbNode;
  /** The class the method is written in, or null for a plain top-level function. */
  readonly enclosingQualifiedName: string | null;
}

export interface ReachedUnits {
  /** One `library` summary per reached method, in the order they were reached. */
  readonly summaries: BehavioralSummary[];
  /** Where each callee in a scanned body resolved to, by callee text, keyed by the scanned method's key. */
  readonly targetsByKey: ReadonlyMap<string, ReadonlyMap<string, DeclaredAt>>;
  /** The calls each scanned body could not follow, by the scanned method's key. */
  readonly stopsByKey: ReadonlyMap<string, UnfollowedCall[]>;
  /** Where each `method(:name)` argument that is a project method is declared, by callee text and position, keyed by the scanned method's key. */
  readonly argTargetsByKey: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>
  >;
  /** The calls each scanned body makes through one of its own parameters, by the scanned method's key. */
  readonly parameterCallsByKey: ReadonlyMap<string, readonly ParameterCall[]>;
  /** The callee text of each no-argument call that turned out to be a property read, by the scanned method's key, so a summary built before the walk can drop it. */
  readonly propertyReadsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every (method, position) pair that some scanned body passes a named project method into, across the whole run. */
  readonly passedPositions: ReadonlySet<string>;
  /** The keys of the bodies that reached at least one project method, for a caller that reports a body only when it reaches something. */
  readonly followedKeys: ReadonlySet<string>;
  /** Every body scanned or replayed, as a cache stores it. */
  readonly scans: ReadonlyMap<string, StoredScan>;
  /** What each body scanned in this run depended on. Empty unless recording. */
  readonly charges: ReadonlyMap<string, Dependencies>;
  /** Each reached method's summary before parameter gaps were added, for the cache. Empty unless recording or replaying. */
  readonly beforeGaps: ReadonlyMap<string, BehavioralSummary>;
}

const REACHABLE_RULES = [
  rule("reachable", [v("f")], [lit("entry", v("f"))]),
  rule(
    "reachable",
    [v("g")],
    [lit("reachable", v("f")), lit("calls", v("f"), v("g"))],
  ),
];

export async function reachedFunctions(
  seeds: readonly Seed[],
  options: ReachOptions,
): Promise<ReachedUnits> {
  const db = new Database();
  const functionByKey = new Map<string, ReachedFunction>();
  const seedKeys = new Set<string>();
  const scanned = new Set<string>();
  const targetsByKey = new Map<string, ReadonlyMap<string, DeclaredAt>>();
  const stopsByKey = new Map<string, UnfollowedCall[]>();
  const argTargetsByKey = new Map<
    string,
    ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>
  >();
  const parameterCallsByKey = new Map<string, readonly ParameterCall[]>();
  const propertyReadsByKey = new Map<string, ReadonlySet<string>>();
  // Only a named project method counts, not an inline block or a variable,
  // so a parameter call missing from this set is a gap even when some
  // caller supplies a value.
  const passedPositions = new Set<string>();
  const followedKeys = new Set<string>();

  const { replay, ledger } = options;
  const scans = new Map<string, StoredScan>();
  const charges = new Map<string, Dependencies>();
  const beforeGaps = new Map<string, BehavioralSummary>();
  const functionFor = (target: StoredTarget): ReachedFunction => {
    const node = replay?.nodeOf(target.key) ?? null;
    if (node === null) {
      throw new ReplayFailed(target.key);
    }
    return { ...target, node };
  };

  for (const seed of seeds) {
    seedKeys.add(seed.key);
    functionByKey.set(seed.key, {
      file: seed.file,
      node: seed.node,
      name: field(seed.node, "name")?.text ?? "<anon>",
      exportPath: [],
      enclosingQualifiedName: seed.enclosingQualifiedName,
    });
    db.add("entry", [seed.key]);
  }

  for (;;) {
    evaluate(db, REACHABLE_RULES);
    const frontier = db
      .facts("reachable")
      .map(([key]) => String(key))
      .filter((key) => !scanned.has(key));
    if (frontier.length === 0) {
      break;
    }
    const round = frontier.flatMap((key): RoundEntry[] => {
      scanned.add(key);
      const stored = replay?.scanOf(key);
      if (stored !== undefined) {
        return [{ key, stored }];
      }
      const source = functionByKey.get(key);
      return source === undefined ? [] : [{ key, source }];
    });
    // Without a cache recording, every body in the round asks the rules
    // together, so evaluation runs once per round instead of once per body.
    const batched =
      ledger === undefined
        ? batchedReads(round, options)
        : new Map<string, BodyCalls & { spellings: CalleeSpellings }>();

    for (const entry of round) {
      const key = entry.key;
      let scan: Scan;
      if ("stored" in entry) {
        scan = scanFromStored(entry.stored, functionFor);
        scans.set(key, entry.stored);
      } else {
        scan = scanOnce(entry.source, key, options, batched.get(key), charges);
        scans.set(key, storedScan(scan));
      }
      if (scan.stops.length > 0) {
        stopsByKey.set(key, scan.stops);
      }
      targetsByKey.set(key, scan.targets);
      argTargetsByKey.set(key, scan.argTargets);
      if (scan.propertyReads.size > 0) {
        propertyReadsByKey.set(key, scan.propertyReads);
      }
      if (scan.parameterCalls.length > 0) {
        parameterCallsByKey.set(key, scan.parameterCalls);
      }
      for (const position of scan.passedPositions) {
        passedPositions.add(position);
      }
      if (scan.followed.length > 0) {
        followedKeys.add(key);
      }

      for (const target of scan.followed) {
        const calleeKey = keyOf(target);
        if (!functionByKey.has(calleeKey)) {
          functionByKey.set(calleeKey, target);
        }
        db.add("calls", [key, calleeKey]);
      }
    }
  }

  const gapHandling = options.gapHandling ?? "permissive";
  const summaries: BehavioralSummary[] = [];
  const summariesByKey = new Map<string, BehavioralSummary[]>();
  for (const [keyAtom] of db.facts("reachable")) {
    const key = String(keyAtom);
    const target = functionByKey.get(key);
    if (seedKeys.has(key) || target === undefined) {
      continue;
    }
    const kept = replay?.summaryOf(key);
    if (kept !== undefined) {
      beforeGaps.set(key, kept);
      const summary = structuredClone(kept);
      summariesByKey.set(key, [summary]);
      summaries.push(summary);
      continue;
    }
    const build = (): BehavioralSummary => {
      const raw = libraryUnit(target, options);
      dropPropertyReads(raw, propertyReadsByKey.get(key));
      const summary = assembleSummary(raw, { gapHandling });
      summary.confidence = { source: "inferred_static", level: "low" };
      if (gapHandling !== "silent") {
        summary.gaps.push(
          ...(stopsByKey.get(key) ?? []).map(unfollowedCallGap),
        );
      }
      placeCalls(summary, targetsByKey.get(key));
      placeArgTargets(summary, argTargetsByKey.get(key));
      placeCalleeParameters(summary, parameterCallsByKey.get(key));
      return summary;
    };
    const summary =
      ledger === undefined
        ? build()
        : ledger.charging(chargeOf(charges, key), () => {
            forgetEvaluations(options.context.facts);
            ledger.readFile(target.file);
            return build();
          });
    if (ledger !== undefined) {
      beforeGaps.set(key, structuredClone(summary));
    }
    summariesByKey.set(key, [summary]);
    summaries.push(summary);
  }
  if (gapHandling !== "silent") {
    recordParameterGaps(parameterCallsByKey, summariesByKey, passedPositions);
  }

  return {
    summaries,
    targetsByKey,
    stopsByKey,
    argTargetsByKey,
    parameterCallsByKey,
    propertyReadsByKey,
    passedPositions,
    followedKeys,
    scans,
    charges,
    beforeGaps,
  };
}

/** A stored target whose node is no longer where the stored key says, which an earlier check should have caught. */
export class ReplayFailed extends Error {
  constructor(readonly key: string) {
    super(`The cache stored a method at ${key}, and nothing is there now.`);
  }
}

function chargeOf(
  charges: Map<string, Dependencies>,
  key: string,
): Dependencies {
  let charge = charges.get(key);
  if (charge === undefined) {
    charge = noDependencies();
    charges.set(key, charge);
  }
  return charge;
}

/** A body the round reaches: one to scan, or one an earlier run scanned. */
type RoundEntry =
  | { readonly key: string; readonly stored: StoredScan }
  | { readonly key: string; readonly source: ReachedFunction };

/** One round's calls read and asked about together, which is how a run without a cache asks them. */
function batchedReads(
  round: readonly RoundEntry[],
  options: ReachOptions,
): Map<string, BodyCalls & { spellings: CalleeSpellings }> {
  const bodies = round.flatMap((entry) =>
    "source" in entry
      ? [{ key: entry.key, ...bodyOf(entry.source, options) }]
      : [],
  );
  const spellings = calleeSpellings(
    bodies.flatMap((body) => body.written),
    options.context,
  );
  return new Map(bodies.map((body) => [body.key, { ...body, spellings }]));
}

/**
 * Scans one body. With a cache recording, the body's own reads are asked
 * about on their own and charged to it, with its file, since the
 * evaluator may read what the file declares around the body. The methods
 * it reaches are charged by key, since their spans go on its summary.
 */
function scanOnce(
  source: ReachedFunction,
  key: string,
  options: ReachOptions,
  read: (BodyCalls & { spellings: CalleeSpellings }) | undefined,
  charges: Map<string, Dependencies>,
): Scan {
  const ledger = options.ledger;
  if (ledger === undefined) {
    const body = read ?? {
      ...bodyOf(source, options),
      spellings: { spellingOf: new Map(), outcomes: new Map() },
    };
    return scanBody(source, options.context, options, body);
  }
  return ledger.charging(chargeOf(charges, key), () => {
    // Nothing an earlier body evaluated may be served to this one uncharged.
    forgetEvaluations(options.context.facts);
    ledger.readFile(source.file);
    const body = bodyOf(source, options);
    const spellings = calleeSpellings(body.written, options.context);
    const scan = scanBody(source, options.context, options, {
      ...body,
      spellings,
    });
    for (const target of scan.followed) {
      ledger.touchKey(keyOf(target));
    }
    return scan;
  });
}

function storedScan(scan: Scan): StoredScan {
  return {
    followed: scan.followed.map((target) => ({
      key: keyOf(target),
      file: target.file,
      name: target.name,
      exportPath: target.exportPath,
      enclosingQualifiedName: target.enclosingQualifiedName,
    })),
    stops: scan.stops,
    targets: [...scan.targets],
    argTargets: [...scan.argTargets].map(([callee, byPosition]) => [
      callee,
      [...byPosition],
    ]),
    parameterCalls: [...scan.parameterCalls],
    passedPositions: [...scan.passedPositions],
    propertyReads: [...scan.propertyReads],
  };
}

function scanFromStored(
  stored: StoredScan,
  functionFor: (target: StoredTarget) => ReachedFunction,
): Scan {
  return {
    followed: stored.followed.map(functionFor),
    stops: stored.stops,
    targets: new Map(stored.targets),
    argTargets: new Map(
      stored.argTargets.map(([callee, byPosition]) => [
        callee,
        new Map(byPosition),
      ]),
    ),
    parameterCalls: stored.parameterCalls,
    passedPositions: new Set(stored.passedPositions),
    propertyReads: new Set(stored.propertyReads),
  };
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file, target.node);
}

/**
 * Removes property reads from a unit built before the walk ran. The
 * effect list is written while the body is read, before anything decides
 * whether `config.host` runs a method, so every no-argument call goes on
 * it and the ones that reached nothing are removed here.
 */
export function dropPropertyReads(
  raw: RawCodeStructure,
  callees: ReadonlySet<string> | undefined,
): void {
  if (callees === undefined) {
    return;
  }
  for (const branch of raw.branches) {
    branch.effects = branch.effects.filter(
      (effect) => effect.type !== "invocation" || !callees.has(effect.callee),
    );
  }
  raw.branches = raw.branches.filter((branch) => !saysNothing(branch));
}

/**
 * A branch with no terminal, conditions or effects. Such a branch is
 * removed. A unit left with no branches reports that its body went
 * unread, which is correct for a resolver whose only statement was a
 * property read.
 */
function saysNothing(branch: RawCodeStructure["branches"][number]): boolean {
  return (
    branch.terminal.kind === "void" &&
    branch.conditions.length === 0 &&
    branch.effects.length === 0 &&
    (branch.extraEffects ?? []).length === 0
  );
}

/** What one pass over a body found. The fields match the per-key maps on `ReachedUnits`. */
interface Scan {
  readonly followed: ReachedFunction[];
  readonly stops: UnfollowedCall[];
  readonly targets: ReadonlyMap<string, DeclaredAt>;
  readonly argTargets: ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>;
  readonly parameterCalls: readonly ParameterCall[];
  readonly passedPositions: ReadonlySet<string>;
  /** The no-argument calls in this body that reached no project method, by callee text. */
  readonly propertyReads: ReadonlySet<string>;
}

const EMPTY_SCAN: Scan = {
  followed: [],
  stops: [],
  targets: new Map(),
  argTargets: new Map(),
  parameterCalls: [],
  passedPositions: new Set(),
  propertyReads: new Set(),
};

/**
 * The `:name` symbol of a bare `method(:name)` argument, also when passed
 * as an `&` block argument, or null for any other argument.
 */
function methodReferenceSymbol(node: RbNode): RbNode | null {
  const target =
    node.type === "block_argument" ? bodyStatements(node)[0] : node;
  if (
    target === undefined ||
    target.type !== "call" ||
    field(target, "receiver") !== null ||
    field(target, "method")?.text !== "method"
  ) {
    return null;
  }
  const args = field(target, "arguments");
  const argChildren = args === null ? [] : bodyStatements(args);
  return argChildren.length === 1 && argChildren[0]?.type === "simple_symbol"
    ? (argChildren[0] as RbNode)
    : null;
}

/** A body's calls, collected before the round asks the rules about all of them at once. */
interface BodyCalls {
  readonly calls: RbNode[];
  /** Every call in this body with no arguments. The summary already has an effect for each. */
  readonly argless: RbNode[];
  readonly site: CallSite;
  readonly written: { call: RbNode; site: CallSite }[];
}

/**
 * The calls in this body to ask the rules about. A call with no arguments
 * is included when the facts say something about its receiver, because
 * the rules then decide whether it is a call. When they say nothing, it
 * is already a property read.
 */
function bodyOf(source: ReachedFunction, options: ReachOptions): BodyCalls {
  const site = siteOf(source);
  const read = readableBodyOf(source.node);
  const written =
    read === null ? [] : bodyCalls(read, options.inheritedMethods);
  const calls = callsReported(written, (call) =>
    mightReadAsACall(call, site, options.context),
  );
  return {
    calls,
    argless: written.filter(isArglessReceiverCall),
    site,
    written: calls.map((call) => ({ call, site })),
  };
}

/**
 * The statements this source runs. For a program node they are the file's
 * load-time statements, and for a method, its body.
 */
function readableBodyOf(node: RbNode): ReadableBody | null {
  return node.type === PROGRAM_TYPE ? moduleScopeBody(node) : methodBody(node);
}

/**
 * Where this source's calls are written. At module scope, names are keyed
 * on the file instead of a method, matching how the value facts key them.
 */
function siteOf(source: ReachedFunction): CallSite {
  return {
    file: source.file,
    method: source.node.type === PROGRAM_TYPE ? null : source.node,
    owner: keyOf(source),
    enclosingQualifiedName: source.enclosingQualifiedName,
  };
}

/**
 * The calls this body makes, out of the ones the round asked about. A
 * no-argument call whose receiver the rules settled on something in the
 * run is kept and resolved like any other call. Otherwise it is a
 * property read, with no invocation and no gap.
 */
function callsMade(
  asked: readonly RbNode[],
  site: CallSite,
  ctx: ReachContext,
  spellings: CalleeSpellings,
): RbNode[] {
  return asked.filter(
    (call) =>
      !isArglessReceiverCall(call) || readsAsACall(call, site, ctx, spellings),
  );
}

function scanBody(
  source: ReachedFunction,
  ctx: ReachContext,
  options: ReachOptions,
  read: {
    calls: RbNode[];
    argless: RbNode[];
    site: CallSite;
    spellings: CalleeSpellings;
  },
): Scan {
  const displayPathOf = options.displayPathOf;
  if (readableBodyOf(source.node) === null) {
    return EMPTY_SCAN;
  }

  const site = read.site;
  const calls = callsMade(read.calls, site, ctx, read.spellings);
  const ownParameters = positionalParameters(source.node).map((p) => p.name);

  const followed: ReachedFunction[] = [];
  const stops: UnfollowedCall[] = [];
  const placements = new TargetPlacements();
  const parameterCalls: ParameterCall[] = [];
  const passedPositions = new Set<string>();
  const seen = new Set<string>();
  const parameterCallsSeen = new Set<string>();
  const followedArgless = new Set<number>();

  // Records each `method(:name)` argument as passed into that position of
  // the callee, so it can be joined to the parameter the callee calls.
  const recordPassedArgs = (
    call: RbNode,
    callee: string,
    calleeKey: string | null,
  ): void => {
    const args = field(call, "arguments");
    if (args === null) {
      return;
    }
    const argNodes = bodyStatements(args);
    for (let position = 0; position < argNodes.length; position += 1) {
      const symbol = methodReferenceSymbol(argNodes[position] as RbNode);
      if (symbol === null) {
        continue;
      }
      const resolved = resolveMethodReference(symbol.text.slice(1), site, ctx);
      if (resolved === null) {
        continue;
      }
      const key = keyOf(resolved);
      if (!seen.has(key)) {
        seen.add(key);
        followed.push(resolved);
      }
      placements.placeArg(callee, position, {
        file: displayPathOf(resolved.file),
        span: spanOf(resolved.node),
      });
      if (calleeKey !== null) {
        passedPositions.add(`${calleeKey}#${position}`);
      }
    }
  };

  // A write through a model runs the callbacks its class registered. The
  // body never calls them by name, so the storage recognizer supplies them.
  const followCallback = (name: string, key: string): void => {
    const target = ctx.definitions.get(key);
    if (target === undefined) {
      return;
    }
    const targetKey = keyOf(target);
    if (!seen.has(targetKey)) {
      seen.add(targetKey);
      followed.push(target);
    }
    placements.place(name, {
      file: displayPathOf(target.file),
      span: spanOf(target.node),
    });
  };

  for (const call of calls) {
    const callee = calleeText(call);
    const outcome = resolveCallee(call, site, ctx, read.spellings);
    if (options.storage !== undefined) {
      for (const callback of callbacksReached(
        call,
        source.file,
        options.storage,
        site.method,
      )) {
        followCallback(callback.name, callback.key);
      }
    }
    placeCallee(placements, outcome, call, {
      callerFile: source.file,
      displayPathOf,
    });
    recordPassedArgs(
      call,
      callee,
      outcome.kind === "followed" ? keyOf(outcome.target) : null,
    );

    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.reason}:${callee}`;
      // A call the storage recognizer records is already in the summary as
      // database work, so it is not reported as a gap.
      const claimed =
        options.storage !== undefined &&
        storageClaims(call, source.file, options.storage, site.method);
      if (!seen.has(stopKey) && !claimed && worthRecording(outcome.reason)) {
        seen.add(stopKey);
        stops.push({ callee, reason: outcome.reason });
      }
      if (
        outcome.reason === "callerSupplied" &&
        !parameterCallsSeen.has(callee)
      ) {
        const receiverName = field(call, "receiver")?.text;
        const parameterIndex =
          receiverName === undefined ? -1 : ownParameters.indexOf(receiverName);
        if (parameterIndex !== -1) {
          parameterCallsSeen.add(callee);
          parameterCalls.push({ callee, parameterIndex });
        }
      }
      continue;
    }
    if (isArglessReceiverCall(call)) {
      followedArgless.add(call.id);
    }
    const key = keyOf(outcome.target);
    if (!seen.has(key)) {
      seen.add(key);
      followed.push(outcome.target);
    }
  }

  return {
    followed,
    stops,
    targets: placements.targets,
    argTargets: placements.argTargets,
    parameterCalls,
    passedPositions,
    propertyReads: propertyReadsAmong(read.argless, calls, followedArgless),
  };
}

/**
 * Where the link step looks for a call's summary. A stop is placed at its
 * own call, where no summary can be, so nothing links it. A call on
 * `self` the resolver could not settle is left unplaced, and the link
 * step then matches it by name in its own file. Any other call that
 * nothing declares is placed at its call too, since a method of the same
 * name elsewhere in the caller's file is never what `rows.delete(x)` runs.
 */
function placeCallee(
  placements: TargetPlacements,
  outcome: CalleeResolution,
  call: RbNode,
  where: { callerFile: string; displayPathOf: (file: string) => string },
): void {
  const callee = calleeText(call);
  if (outcome.kind === "followed") {
    placements.place(callee, {
      file: where.displayPathOf(outcome.target.file),
      span: spanOf(outcome.target.node),
    });
    return;
  }

  if (outcome.matchByName === true) {
    return;
  }

  placements.placeStop(callee, {
    file: where.displayPathOf(where.callerFile),
    span: spanOf(call),
  });
}

/**
 * The no-argument calls that reached no project method, by callee text.
 * A text that another call in this body kept is left out, since effects
 * are dropped by text and that call would be dropped too.
 */
function propertyReadsAmong(
  argless: readonly RbNode[],
  made: readonly RbNode[],
  followed: ReadonlySet<number>,
): ReadonlySet<string> {
  const kept = new Set(
    made
      .filter((call) => !isArglessReceiverCall(call) || followed.has(call.id))
      .map(calleeText),
  );
  const reads = new Set<string>();
  for (const call of argless) {
    const text = calleeText(call);
    if (!kept.has(text)) {
      reads.add(text);
    }
  }
  return reads;
}

function libraryUnit(
  target: ReachedFunction,
  options: ReachOptions,
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = bodyOfMethod(node, file, options);
  const range = rangeOf(node);
  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "library",
      file: options.displayPathOf(file),
      range,
      span: spanOf(node),
      exportName: exportPath[0] ?? name,
      exportPath,
    },
    boundaryBinding: functionCallBinding({
      transport: "in-process",
      recognition: "reachable",
    }),
    parameters: positionalParameters(node),
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "return",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: range,
        },
        effects: body.effects ?? [],
        ...(body.extraEffects === undefined
          ? {}
          : { extraEffects: body.extraEffects }),
        location: range,
        isDefault: true,
      },
    ],
    bodyContent: body.bodyContent ?? "absent",
    dependencyCalls: [],
    declaredContract: null,
  };
}

function positionalParameters(node: RbNode): RawParameter[] {
  const parameters = field(node, "parameters");
  if (parameters === null) {
    return [];
  }
  const out: RawParameter[] = [];
  let position = 0;
  for (const param of bodyStatements(parameters)) {
    const name = parameterName(param);
    if (name === null) {
      continue;
    }
    out.push({ name, position, role: name, typeText: null });
    position += 1;
  }
  return out;
}

function parameterName(param: RbNode): string | null {
  if (param.type === "identifier") {
    return param.text;
  }
  const named = field(param, "name");
  return named !== null && named.type === "identifier" ? named.text : null;
}
