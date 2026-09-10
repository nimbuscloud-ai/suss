/**
 * The methods a discovered unit reaches through the calls it makes,
 * each given a `library` summary of its own, so a question about what
 * a graphql-ruby field reaches can be answered from the summaries alone.
 *
 * Seeds are entry facts; each scanned body adds a `calls` fact per
 * callee it could place, and the rules derive what is reachable until
 * the set stops growing. A call that could not be placed is recorded
 * as an unfollowed-call gap on the summary of the body it is in. The
 * package README says how a callee is resolved and where the walk
 * stops.
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

import { bodyStatements, field, rangeOf, spanOf } from "../ast.js";
import { bodyOfMethod } from "../discovery.js";
import { nodeId } from "../facts/values.js";
import {
  bodyCalls,
  calleeText,
  callsReported,
  isArglessReceiverCall,
} from "../paths/effects.js";
import { storageClaims } from "../storage.js";
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
import type { RawCodeStructure, RawParameter } from "@suss/extractor";
import type { BodyReadOptions } from "../discovery.js";
import type { RbNode } from "../parser.js";
import type {
  CalleeSpellings,
  CallSite,
  ReachContext,
  ReachedFunction,
} from "./resolveCallee.js";

export interface ReachOptions extends BodyReadOptions {
  /** Every class the run defines and every method it writes outside one, which is what a call is placed against. */
  readonly context: ReachContext;
  /** How a `location.file`/`declaredAt.file` spells an absolute path, the same way `project.ts` spells a discovered unit's. */
  readonly displayPathOf: (file: string) => string;
}

/** A discovered unit's method, keyed the way its summary's span is. */
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
  /** Where each callee text a scanned body writes was placed, by the scanned method's key. */
  readonly targetsByKey: ReadonlyMap<string, ReadonlyMap<string, DeclaredAt>>;
  /** The calls each scanned body could not follow, by the scanned method's key. */
  readonly stopsByKey: ReadonlyMap<string, UnfollowedCall[]>;
  /** Where each `method(:name)` reference that is itself a project method was declared, by callee text and position, keyed by the scanned method's key. */
  readonly argTargetsByKey: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>
  >;
  /** The calls each scanned body makes through one of its own parameters, by the scanned method's key. */
  readonly parameterCallsByKey: ReadonlyMap<string, readonly ParameterCall[]>;
  /** The callee text of each no-argument call the walk found was a property read, by the scanned method's key, so a summary written before the walk can take it back. */
  readonly propertyReadsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every (method, position) some scanned body passed a named project method into, across the whole run. */
  readonly passedPositions: ReadonlySet<string>;
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
  const ctx = options.context;
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
  // Every (method, position) some scanned body passes a named project
  // method into. An inline block or a variable does not count, so a
  // parameter call missing here is a gap even when a caller supplies one.
  const passedPositions = new Set<string>();

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
    // Every body in this round asks the rules together, so evaluation
    // runs once per round rather than once per body.
    const bodies = frontier.flatMap((key) => {
      scanned.add(key);
      const source = functionByKey.get(key);
      return source === undefined
        ? []
        : [{ key, source, ...bodyOf(source, options) }];
    });
    const spellings = calleeSpellings(
      bodies.flatMap((body) => body.written),
      ctx,
    );

    for (const { key, source, calls, argless, site } of bodies) {
      const scan = scanBody(source, ctx, options, {
        calls,
        argless,
        site,
        spellings,
      });
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
      for (const target of scan.followed) {
        const calleeKey = keyOf(target);
        if (!functionByKey.has(calleeKey)) {
          functionByKey.set(calleeKey, target);
        }
        db.add("calls", [key, calleeKey]);
      }
    }
  }

  const summaries: BehavioralSummary[] = [];
  const summariesByKey = new Map<string, BehavioralSummary[]>();
  for (const [keyAtom] of db.facts("reachable")) {
    const key = String(keyAtom);
    const target = functionByKey.get(key);
    if (seedKeys.has(key) || target === undefined) {
      continue;
    }
    const raw = libraryUnit(target, options);
    dropPropertyReads(raw, propertyReadsByKey.get(key));
    const summary = assembleSummary(raw, { gapHandling: "permissive" });
    summary.confidence = { source: "inferred_static", level: "low" };
    summary.gaps.push(...(stopsByKey.get(key) ?? []).map(unfollowedCallGap));
    placeCalls(summary, targetsByKey.get(key));
    placeArgTargets(summary, argTargetsByKey.get(key));
    placeCalleeParameters(summary, parameterCallsByKey.get(key));
    summariesByKey.set(key, [summary]);
    summaries.push(summary);
  }
  recordParameterGaps(parameterCallsByKey, summariesByKey, passedPositions);

  return {
    summaries,
    targetsByKey,
    stopsByKey,
    argTargetsByKey,
    parameterCallsByKey,
    propertyReadsByKey,
    passedPositions,
  };
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file, target.node);
}

/**
 * Takes the property reads back off a unit read before the walk ran. A
 * body's effect list is written as the body is read, when nothing yet
 * says whether `config.host` runs a method, so every no-argument call
 * goes on it and the ones that reached nothing come off here.
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
 * A branch that says nothing: a pack wrote it for what the body does,
 * and the body turned out to do none of it. A unit left with no
 * branches says instead that its body went unread, which is what a
 * resolver whose one statement was a property read should say.
 */
function saysNothing(branch: RawCodeStructure["branches"][number]): boolean {
  return (
    branch.terminal.kind === "void" &&
    branch.conditions.length === 0 &&
    branch.effects.length === 0 &&
    (branch.extraEffects ?? []).length === 0
  );
}

/**
 * What one pass over a body found: methods to walk into, stops, where
 * each callee was placed, where a `method(:name)` reference that is
 * itself a project method was placed (by callee text and position),
 * calls made through one of this body's own parameters, and the
 * (method, position) pairs this body passes a method into.
 */
interface Scan {
  readonly followed: ReachedFunction[];
  readonly stops: UnfollowedCall[];
  readonly targets: ReadonlyMap<string, DeclaredAt>;
  readonly argTargets: ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>;
  readonly parameterCalls: readonly ParameterCall[];
  readonly passedPositions: ReadonlySet<string>;
  /** The no-argument calls this body writes that reached no project method, by the text they were written as. */
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
 * A bare `method(:name)`, or one wrapped as an `&`-prefixed block
 * argument, is a project method passed by name: the symbol node that
 * spells it, if the shape matches, else null.
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

/** A body's calls, read before the round asks the rules about all of them at once. */
interface BodyCalls {
  readonly calls: RbNode[];
  /** Every call this body writes with no arguments, which is what the summary already has an effect for. */
  readonly argless: RbNode[];
  readonly site: CallSite;
  readonly written: { call: RbNode; site: CallSite }[];
}

/**
 * The calls this round asks the rules about. A call written with no
 * arguments is among them when the run says anything about its
 * receiver, since whether it is a call at all is what the rules then
 * settle; one with nothing behind its receiver is a property read
 * already.
 */
function bodyOf(source: ReachedFunction, options: ReachOptions): BodyCalls {
  const site: CallSite = {
    file: source.file,
    method: source.node,
    owner: keyOf(source),
    enclosingQualifiedName: source.enclosingQualifiedName,
  };
  const written =
    field(source.node, "body") === null
      ? []
      : bodyCalls(source.node, options.inheritedMethods);
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
 * The calls this body makes, out of the ones the round asked about. A
 * no-argument call whose receiver the rules settled on something in the
 * run is one of them, and it is resolved like any other. One they
 * settled on anything else is a property read: no invocation, no gap.
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
  if (field(source.node, "body") === null) {
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

  // A `method(:name)` reference joins a `passes` fact to whichever
  // parameter of the followed callee it calls through.
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

  for (const call of calls) {
    const callee = calleeText(call);
    const outcome = resolveCallee(call, site, ctx, read.spellings);
    // A stop is placed at its own call, where no summary can be, so the
    // link step neither links it nor guesses by name.
    const placed =
      outcome.kind === "followed"
        ? {
            file: displayPathOf(outcome.target.file),
            span: spanOf(outcome.target.node),
          }
        : outcome.reason === "noDeclaration"
          ? null
          : { file: displayPathOf(source.file), span: spanOf(call) };
    placements.place(callee, placed);
    recordPassedArgs(
      call,
      callee,
      outcome.kind === "followed" ? keyOf(outcome.target) : null,
    );

    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.reason}:${callee}`;
      // A call the storage recognizer records is already in the summary as
      // database work, so it is not a gap in what this walk reached.
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
 * The no-argument calls that reached no project method, by the text
 * they were written as. A text another call in this body kept is not
 * one of them, since dropping it would take that call off the list too.
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
