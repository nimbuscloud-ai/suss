/**
 * The functions a discovered unit reaches through the calls it makes,
 * each given a `library` summary of its own, so a question about what a
 * route reaches can be answered from the summaries alone.
 *
 * The walk is the same one the TypeScript adapter runs: seeds are entry
 * facts, each scanned body adds a `calls` fact per callee it could
 * follow, and the rules derive what is reachable until the set stops
 * growing. A call that could not be followed is recorded as an
 * unfollowed-call gap on the summary of the body it is in. DESIGN.md
 * lists how a callee is resolved and where the walk stops.
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
import {
  assembleSummary,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";
import {
  type Dependencies,
  type DependencyLedger,
  noDependencies,
} from "@suss/resolution";

import {
  enclosingFunction,
  field,
  isModule,
  rangeOf,
  runsAtModuleLoad,
  spanOf,
} from "../ast.js";
import {
  bodyContentOf,
  recognizedBodyEffects,
  recognizedCallIds,
  withBodyEffects,
} from "../discovery.js";
import { exitingBranches } from "../exits.js";
import { nodeId, readKey } from "../facts/values.js";
import { argparseFlagReads } from "../flags.js";
import {
  bodyValueNodes,
  calleeText,
  invocationEffects,
} from "../paths/effects.js";
import { askWrittenValues, forgetEvaluations } from "../values/evaluator.js";
import {
  calleeSpellings,
  functionNamed,
  namedOutcomes,
  resolveCallee,
} from "./resolveCallee.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  DeclaredAt,
  ParameterCall,
  UnfollowedCall,
} from "@suss/behavioral-ir";
import type {
  ExtractorOptions,
  RawCodeStructure,
  RawParameter,
} from "@suss/extractor";
import type { CalleeOutcome } from "@suss/resolution";
import type { PyNode } from "../parser.js";
import type { WalkReplay } from "../reuse.js";
import type { BoundPythonFile } from "../routers.js";
import type { Scope } from "../scope.js";
import type { StorageLookup } from "../storage.js";
import type {
  CalleeResolution,
  CalleeSpellings,
  CallSite,
  ReachedFunction,
  ResolveContext,
} from "./resolveCallee.js";

export interface ReachOptions {
  readonly files: readonly BoundPythonFile[];
  readonly roots: string[];
  readonly gapHandling: ExtractorOptions["gapHandling"];
  /** The storage patterns that apply to a file, for recognizing a body's database work. */
  readonly storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
  /** The value facts the rules settle a callee from. */
  readonly facts: Database;
  /** The function each function key was read from. */
  readonly definitions: ReadonlyMap<string, PyNode>;
  /** What an earlier run's walk found where it is still valid, so those bodies are not scanned again. */
  readonly replay?: WalkReplay;
  /** Set when a cache is recording what each scanned body depended on. */
  readonly ledger?: DependencyLedger;
}

/** A function one scan followed, as a cache stores it. */
export interface StoredTarget {
  readonly key: string;
  readonly name: string;
  readonly exportPath: string[];
}

/** What one scan of a body found, in a form JSON keeps. */
export interface StoredScan {
  readonly followed: StoredTarget[];
  readonly stops: UnfollowedCall[];
  readonly targets: [string, DeclaredAt][];
  readonly argTargets: [string, [number, DeclaredAt][]][];
  readonly parameterCalls: ParameterCall[];
  readonly passedPositions: string[];
}

/** A discovered unit's function, keyed the way its summary's span is. */
export interface Seed {
  readonly key: string;
  readonly file: BoundPythonFile;
  readonly node: PyNode;
}

export interface ReachedUnits {
  /** One `library` summary per reached function, in the order they were reached. */
  readonly summaries: BehavioralSummary[];
  /** Where each callee text a scanned body writes was placed, by the scanned function's key. */
  readonly targetsByKey: ReadonlyMap<string, ReadonlyMap<string, DeclaredAt>>;
  /** The calls each scanned body could not follow, by the scanned function's key. */
  readonly stopsByKey: ReadonlyMap<string, UnfollowedCall[]>;
  /** Where each identifier argument that is itself a project function was declared, by callee text and position, keyed by the scanned function's key. */
  readonly argTargetsByKey: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>
  >;
  /** The calls each scanned body makes through one of its own parameters, by the scanned function's key. */
  readonly parameterCallsByKey: ReadonlyMap<string, readonly ParameterCall[]>;
  /** The project functions each scanned body could step into, by the scanned function's key. */
  readonly callsByKey: ReadonlyMap<string, readonly string[]>;
  /** Every (function, position) some scanned body passed a named project function into, across the whole run. */
  readonly passedPositions: ReadonlySet<string>;
  /** Every body scanned or replayed, as a cache stores it. */
  readonly scans: ReadonlyMap<string, StoredScan>;
  /** What each body scanned in this run depended on. Empty unless recording. */
  readonly charges: ReadonlyMap<string, Dependencies>;
  /** Each reached function's summary before parameter gaps were added, for the cache. Empty unless recording or replaying. */
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

export function reachedFunctions(
  seeds: readonly Seed[],
  options: ReachOptions,
): ReachedUnits {
  const ctx: ResolveContext = {
    filesByPath: new Map(options.files.map((file) => [file.file, file])),
    roots: options.roots,
    facts: options.facts,
    definitions: options.definitions,
  };
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
  const callsByKey = new Map<string, string[]>();
  // Every (function, position) some scanned body passes a named project
  // function into. An inline lambda or a variable does not count, so a
  // parameter call missing here is a gap even when a caller supplies one.
  const passedPositions = new Set<string>();
  const { replay, ledger } = options;
  const scans = new Map<string, StoredScan>();
  const charges = new Map<string, Dependencies>();
  const beforeGaps = new Map<string, BehavioralSummary>();
  const functionFor = (target: StoredTarget): ReachedFunction => {
    const found = replay?.functionOf(target) ?? null;
    if (found === null) {
      throw new ReplayFailed(target.key);
    }
    return found;
  };

  for (const seed of seeds) {
    seedKeys.add(seed.key);
    functionByKey.set(seed.key, {
      file: seed.file,
      node: seed.node,
      name: field(seed.node, "name")?.text ?? "<anon>",
      exportPath: [],
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
    // Without a cache recording, every body in this round asks the rules
    // together, so evaluation runs once per round rather than once per body.
    const batched = ledger === undefined ? batchedReads(round, ctx) : new Map();

    for (const entry of round) {
      const key = entry.key;
      let scan: Scan;
      if ("stored" in entry) {
        scan = scanFromStored(entry.stored, functionFor);
        scans.set(key, entry.stored);
      } else {
        scan = scanOnce(
          entry.source,
          key,
          ctx,
          options,
          batched.get(key),
          charges,
        );
        scans.set(key, storedScan(scan));
      }
      if (scan.stops.length > 0) {
        stopsByKey.set(key, scan.stops);
      }
      targetsByKey.set(key, scan.targets);
      argTargetsByKey.set(key, scan.argTargets);
      if (scan.parameterCalls.length > 0) {
        parameterCallsByKey.set(key, scan.parameterCalls);
      }
      for (const position of scan.passedPositions) {
        passedPositions.add(position);
      }
      const called: string[] = [];
      for (const target of scan.followed) {
        const calleeKey = keyOf(target);
        if (!functionByKey.has(calleeKey)) {
          functionByKey.set(calleeKey, target);
        }
        db.add("calls", [key, calleeKey]);
        called.push(calleeKey);
      }
      if (called.length > 0) {
        callsByKey.set(key, called);
      }
    }
  }

  const reached = db
    .facts("reachable")
    .map(([keyAtom]) => String(keyAtom))
    .filter((key) => !seedKeys.has(key));
  // A recording run settles each function's values in its own charge,
  // right before its summary is built.
  if (ledger === undefined) {
    settleBodyValues(reached, functionByKey, options.facts);
  }

  const summaries: BehavioralSummary[] = [];
  const summariesByKey = new Map<string, BehavioralSummary[]>();
  for (const key of reached) {
    const target = functionByKey.get(key);
    if (target === undefined) {
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
      const summary = assembleSummary(libraryUnit(target, options), {
        gapHandling: options.gapHandling,
      });
      summary.confidence = { source: "inferred_static", level: "low" };
      if (options.gapHandling !== "silent") {
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
            forgetEvaluations(options.facts);
            ledger.readFile(target.file.file);
            askWrittenValues(bodyValueNodes(target.node), options.facts);
            return build();
          });
    if (ledger !== undefined) {
      beforeGaps.set(key, structuredClone(summary));
    }
    summariesByKey.set(key, [summary]);
    summaries.push(summary);
  }
  if (options.gapHandling !== "silent") {
    recordParameterGaps(parameterCallsByKey, summariesByKey, passedPositions);
  }

  return {
    summaries,
    targetsByKey,
    stopsByKey,
    argTargetsByKey,
    parameterCallsByKey,
    callsByKey,
    passedPositions,
    scans,
    charges,
    beforeGaps,
  };
}

/** A stored target whose node is no longer where the stored key says, which an earlier check should have caught. */
export class ReplayFailed extends Error {
  constructor(readonly key: string) {
    super(`The cache stored a function at ${key}, and nothing is there now.`);
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

/** What one body's scan reads before it walks the calls. */
type BodyReads = BodyCalls & {
  spellings: CalleeSpellings;
  passed: ReadonlyMap<string, CalleeOutcome>;
};

/** One round's calls read and asked about together, which is how a run without a cache asks them. */
function batchedReads(
  round: readonly RoundEntry[],
  ctx: ResolveContext,
): Map<string, BodyReads> {
  const bodies = round.flatMap((entry) =>
    "source" in entry
      ? [{ key: entry.key, source: entry.source, ...bodyOf(entry.source) }]
      : [],
  );
  const spellings = calleeSpellings(
    bodies.flatMap((body) => body.written),
    ctx,
  );
  const passed = namedOutcomes(
    bodies.flatMap(({ source, written }) =>
      written.flatMap(({ call }) => passedNameKeys(source.file, call)),
    ),
    ctx,
  );
  return new Map(
    bodies.map((body) => [
      body.key,
      { body: body.body, written: body.written, spellings, passed },
    ]),
  );
}

/**
 * Scans one body. With a cache recording, the body's own reads are asked
 * about on their own and charged to it, with its file, since the
 * evaluator may read what the file declares around the body. The
 * functions it reaches are charged by key, since their spans go on its
 * summary.
 */
function scanOnce(
  source: ReachedFunction,
  key: string,
  ctx: ResolveContext,
  options: ReachOptions,
  read: BodyReads | undefined,
  charges: Map<string, Dependencies>,
): Scan {
  const scan = (reads: BodyReads): Scan =>
    scanBody(
      source,
      ctx,
      recognizedCallIds(
        reads.written.map(({ call }) => call),
        options.storageFor(source.file),
      ),
      reads,
    );
  const ledger = options.ledger;
  if (ledger === undefined) {
    return scan(read ?? ownReads(source, ctx));
  }
  return ledger.charging(chargeOf(charges, key), () => {
    // Nothing an earlier body evaluated may be served to this one uncharged.
    forgetEvaluations(options.facts);
    ledger.readFile(source.file.file);
    const found = scan(ownReads(source, ctx));
    for (const target of found.followed) {
      ledger.touchKey(keyOf(target));
    }
    return found;
  });
}

/** One body's calls, asked about on their own. */
function ownReads(source: ReachedFunction, ctx: ResolveContext): BodyReads {
  const body = bodyOf(source);
  return {
    ...body,
    spellings: calleeSpellings(body.written, ctx),
    passed: namedOutcomes(
      body.written.flatMap(({ call }) => passedNameKeys(source.file, call)),
      ctx,
    ),
  };
}

function storedScan(scan: Scan): StoredScan {
  return {
    followed: scan.followed.map((target) => ({
      key: keyOf(target),
      name: target.name,
      exportPath: target.exportPath,
    })),
    stops: scan.stops,
    targets: [...scan.targets],
    argTargets: [...scan.argTargets].map(([callee, byPosition]) => [
      callee,
      [...byPosition],
    ]),
    parameterCalls: [...scan.parameterCalls],
    passedPositions: [...scan.passedPositions],
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
  };
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file.file, target.node);
}

/**
 * Where the link step looks for a call's summary. A stop is placed at its
 * own call, where no summary can be, so nothing links it. A bare name
 * nothing declares is left unplaced, and the link step then matches it
 * by name in its own file. A method nothing declares is placed at its
 * call too, since a function of the same name in the caller's file is
 * never what `receiver.method()` runs.
 */
function placeCallee(
  placements: TargetPlacements,
  callee: string,
  outcome: CalleeResolution,
  call: PyNode,
  file: BoundPythonFile,
): void {
  if (outcome.kind === "followed") {
    placements.place(callee, {
      file: outcome.target.file.displayPath,
      span: spanOf(outcome.target.node),
    });
    return;
  }

  if (outcome.reason === "noDeclaration" && !isMethodCall(call)) {
    return;
  }

  placements.placeStop(callee, { file: file.displayPath, span: spanOf(call) });
}

function isMethodCall(call: PyNode): boolean {
  return field(call, "function")?.type === "attribute";
}

/**
 * What one pass over a body found: functions to walk into, stops,
 * where each callee was placed, where an identifier argument that is
 * itself a project function was placed (by callee text and position),
 * calls made through one of this body's own parameters, and the
 * (function, position) pairs this body passes a function into.
 */
interface Scan {
  readonly followed: ReachedFunction[];
  readonly stops: UnfollowedCall[];
  readonly targets: ReadonlyMap<string, DeclaredAt>;
  readonly argTargets: ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>;
  readonly parameterCalls: readonly ParameterCall[];
  readonly passedPositions: ReadonlySet<string>;
}

const EMPTY_SCAN: Scan = {
  followed: [],
  stops: [],
  targets: new Map(),
  argTargets: new Map(),
  parameterCalls: [],
  passedPositions: new Set(),
};

/** A body's calls, read before the round asks the rules about all of them at once. */
interface BodyCalls {
  readonly body: PyNode | null;
  readonly written: { call: PyNode; site: CallSite }[];
}

function bodyOf(source: ReachedFunction): BodyCalls {
  const { file, node } = source;
  // A module has no body field, so its own statements are the body.
  const body = isModule(node) ? node : field(node, "body");
  // The grammar writes a body on every def.
  /* v8 ignore start */
  if (body === null) {
    return { body, written: [] };
  }
  /* v8 ignore stop */
  return {
    body,
    written: callsWritten(file, body, scopeAt(file, node), keyOf(source), {
      descendsInto: isModule(node) ? runsAtModuleLoad : outsideNestedDef,
    }),
  };
}

function outsideNestedDef(node: PyNode): boolean {
  return node.type !== "function_definition";
}

/**
 * Settles the values every reached body reads, one file at a time. Each
 * round of the rules runs over the whole project's facts, so batching a
 * file costs about the same as asking about one value, where asking per
 * summary would cost a round per argument. Batching the whole run into
 * one round derives far more on a large project than the per-file rounds
 * add up to.
 */
function settleBodyValues(
  reached: readonly string[],
  functionByKey: ReadonlyMap<string, ReachedFunction>,
  facts: Database | undefined,
): void {
  const byFile = new Map<string, PyNode[]>();
  for (const key of reached) {
    const target = functionByKey.get(key);
    if (target === undefined) {
      continue;
    }
    const listed = byFile.get(target.file.file) ?? [];
    for (const node of bodyValueNodes(target.node)) {
      listed.push(node);
    }
    byFile.set(target.file.file, listed);
  }
  for (const nodes of byFile.values()) {
    askWrittenValues(nodes, facts);
  }
}

/** The key an identifier argument joins on, or null when the argument is not a bare name. */
function passedNameKeyOf(
  file: BoundPythonFile,
  arg: PyNode | null,
): string | null {
  if (arg === null || arg.type !== "identifier") {
    return null;
  }
  return readKey(file.file, arg, enclosingFunction(arg));
}

/** Every bare name one call passes as an argument, since a project function is passed by its name. */
function passedNameKeys(file: BoundPythonFile, call: PyNode): string[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  return args.namedChildren.flatMap((arg) => {
    const key = passedNameKeyOf(file, arg);
    return key === null ? [] : [key];
  });
}

function scanBody(
  source: ReachedFunction,
  ctx: ResolveContext,
  recognized: ReadonlySet<number>,
  read: BodyCalls & {
    spellings: CalleeSpellings;
    passed: ReadonlyMap<string, CalleeOutcome>;
  },
): Scan {
  const followed: ReachedFunction[] = [];
  const stops: UnfollowedCall[] = [];
  const placements = new TargetPlacements();
  const parameterCalls: ParameterCall[] = [];
  const passedPositions = new Set<string>();
  const seen = new Set<string>();
  const parameterCallsSeen = new Set<string>();
  const { file, node } = source;
  const { written, spellings } = read;

  /* v8 ignore start */
  if (read.body === null) {
    return EMPTY_SCAN;
  }
  /* v8 ignore stop */

  const ownParameters = callParameterNames(node, source.exportPath.length > 1);

  // An identifier argument that is a project function joins a `passes`
  // fact to whichever parameter of the followed callee it calls through.
  const recordPassedArgs = (
    call: PyNode,
    callee: string,
    calleeKey: string | null,
  ): void => {
    const args = field(call, "arguments");
    if (args === null) {
      return;
    }
    args.namedChildren.forEach((arg, position) => {
      const nameKey = passedNameKeyOf(file, arg);
      if (nameKey === null) {
        return;
      }
      const resolved = functionNamed(nameKey, ctx, read.passed);
      if (resolved === null) {
        return;
      }
      const key = keyOf(resolved);
      if (!seen.has(key)) {
        seen.add(key);
        followed.push(resolved);
      }
      placements.placeArg(callee, position, {
        file: resolved.file.displayPath,
        span: spanOf(resolved.node),
      });
      if (calleeKey !== null) {
        passedPositions.add(`${calleeKey}#${position}`);
      }
    });
  };

  const record = (call: PyNode, site: CallSite): void => {
    const callee = calleeText(call);
    const outcome = resolveCallee(call, site, ctx, spellings);
    placeCallee(placements, callee, outcome, call, file);
    recordPassedArgs(
      call,
      callee,
      outcome.kind === "followed" ? keyOf(outcome.target) : null,
    );

    // One record per callee, however many times the body calls it. A call
    // that storage recognition already read is not reported as a stop.
    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.reason}:${callee}`;
      if (
        !seen.has(stopKey) &&
        !recognized.has(call.id) &&
        worthRecording(outcome.reason)
      ) {
        seen.add(stopKey);
        stops.push({ callee, reason: outcome.reason });
      }
      if (
        outcome.reason === "callerSupplied" &&
        !parameterCallsSeen.has(callee)
      ) {
        const parameterIndex = ownParameters.indexOf(callee);
        if (parameterIndex !== -1) {
          parameterCallsSeen.add(callee);
          parameterCalls.push({ callee, parameterIndex });
        }
      }
      return;
    }
    const key = keyOf(outcome.target);
    if (!seen.has(key)) {
      seen.add(key);
      followed.push(outcome.target);
    }
  };

  for (const { call, site } of written) {
    record(call, site);
  }

  return {
    followed,
    stops,
    targets: placements.targets,
    argTargets: placements.argTargets,
    parameterCalls,
    passedPositions,
  };
}

/** Every call written in a body, with the scope it is written in. `descendsInto` says where the body ends: at a nested def for a function, at anything that runs later for a module. */
function callsWritten(
  file: BoundPythonFile,
  body: PyNode,
  outer: Scope,
  owner: string,
  limit: { descendsInto: (node: PyNode) => boolean },
): { call: PyNode; site: CallSite }[] {
  const found: { call: PyNode; site: CallSite }[] = [];
  walkDescendants<PyNode, Scope>(body, outer, {
    at: (child, scope) => {
      if (child.type === "call") {
        found.push({ call: child, site: { file, scope, owner } });
      }
    },
    into: (child, scope) =>
      limit.descendsInto(child)
        ? (file.module.scopeFor.get(child.id) ?? scope)
        : SKIP_CHILDREN,
  });
  return found;
}

/** The binder's scope for a function, or the nearest one above a def it did not bind. */
function scopeAt(file: BoundPythonFile, node: PyNode): Scope {
  let current: PyNode | null = node;
  while (current !== null) {
    const scope = file.module.scopeFor.get(current.id);
    if (scope !== undefined) {
      return scope;
    }
    current = current.parent;
  }
  return file.module.moduleScope;
}

function identifiersUnder(node: PyNode, found: string[] = []): string[] {
  if (node.type === "identifier") {
    found.push(node.text);
    return found;
  }
  for (const child of node.namedChildren) {
    if (
      child !== null &&
      child.type !== "attribute" &&
      child.type !== "subscript"
    ) {
      identifiersUnder(child, found);
    }
  }
  return found;
}

/**
 * A reached function's unit. A module export is built the same way, with
 * the binding that keys it by its module, so the two cannot drift apart.
 */
export function libraryUnit(
  target: ReachedFunction,
  options: Pick<ReachOptions, "storageFor" | "facts">,
  binding: BoundaryBinding = functionCallBinding({
    transport: "in-process",
    recognition: "reachable",
  }),
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = field(node, "body");
  const extra = recognizedBodyEffects(
    node,
    file.module,
    options.storageFor(file),
    options.facts,
  );
  const range = rangeOf(node);
  const parameters = positionalParameters(node, exportPath.length > 1);
  const flags = argparseFlagReads(
    node,
    file.module,
    parameters.map((parameter) => parameter.name),
  );
  const effects = invocationEffects(node, options.facts);
  const branches = exitingBranches(
    node,
    file.module,
    effects,
    options.facts,
  ) ?? [
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
      effects,
      location: range,
      isDefault: true,
    },
  ];
  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "library",
      file: file.displayPath,
      range,
      span: spanOf(node),
      exportName: exportPath[0] ?? name,
      exportPath,
    },
    boundaryBinding: binding,
    parameters,
    branches: branches.map((branch) => withBodyEffects(branch, extra)),
    ...(flags.length === 0 ? {} : { extraInputReads: flags }),
    bodyContent: body === null ? "absent" : bodyContentOf(body),
    dependencyCalls: [],
    declaredContract: null,
  };
}

/** Every parameter by position, with its own name for a role, as the TypeScript walk writes a reached function's. */
function positionalParameters(node: PyNode, isMethod: boolean): RawParameter[] {
  const parameters = field(node, "parameters");
  if (parameters === null) {
    return [];
  }
  const out: RawParameter[] = [];
  let position = 0;
  for (const param of parameters.namedChildren) {
    if (param === null) {
      continue;
    }
    const name = parameterName(param);
    if (name === null) {
      continue;
    }
    if (isMethod && position === 0 && (name === "self" || name === "cls")) {
      position += 1;
      continue;
    }
    out.push({ name, position, role: name, typeText: null });
    position += 1;
  }
  return out;
}

/**
 * A function's own parameters in call order, with a method's leading
 * `self` or `cls` left out, since a caller never passes it. A
 * `callerSupplied` call through a parameter joins a caller's argument by
 * this index. `positionalParameters` skips the receiver as well, but
 * still counts its position.
 */
function callParameterNames(node: PyNode, isMethod: boolean): string[] {
  const parameters = field(node, "parameters");
  if (parameters === null) {
    return [];
  }
  const names: string[] = [];
  for (const param of parameters.namedChildren) {
    if (param === null) {
      continue;
    }
    const name = parameterName(param);
    if (name === null) {
      continue;
    }
    if (isMethod && names.length === 0 && (name === "self" || name === "cls")) {
      continue;
    }
    names.push(name);
  }
  return names;
}

function parameterName(param: PyNode): string | null {
  if (param.type === "identifier") {
    return param.text;
  }
  const named = field(param, "name");
  if (named !== null && named.type === "identifier") {
    return named.text;
  }
  return identifiersUnder(param)[0] ?? null;
}
