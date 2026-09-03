/**
 * The functions a discovered unit reaches through the calls it makes,
 * each given a `library` summary of its own, so a question about what a
 * route reaches can be answered from the summaries alone.
 *
 * The walk is the same one the TypeScript adapter runs: seeds are entry
 * facts, each scanned body adds a `calls` fact per callee it could
 * follow, and the rules derive what is reachable until the set stops
 * growing. A call that could not be followed is recorded as an
 * unfollowed-call gap on the summary of the body it is in. The package
 * README says how a callee is resolved and where the walk stops.
 */

import {
  functionCallBinding,
  placeArgTargets,
  placeCalleeParameters,
  placeCalls,
  recordParameterGaps,
  unfollowedCallGap,
  worthRecording,
} from "@suss/behavioral-ir";
import { Database, evaluate, lit, rule, variable as v } from "@suss/datalog";
import {
  assembleSummary,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";

import { field, rangeOf, spanOf } from "../ast.js";
import { bodyContentOf, recognizedBodyEffects } from "../discovery.js";
import { nodeId } from "../facts/values.js";
import { calleeText, invocationEffects } from "../paths/effects.js";
import {
  resolveCallee,
  resolveNamedFunctionArgument,
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
import type { PyNode } from "../parser.js";
import type { BoundPythonFile } from "../routers.js";
import type { Scope } from "../scope.js";
import type { StorageLookup } from "../storage.js";
import type { ReachedFunction, ResolveContext } from "./resolveCallee.js";

export interface ReachOptions {
  readonly files: readonly BoundPythonFile[];
  readonly roots: string[];
  readonly gapHandling: ExtractorOptions["gapHandling"];
  /** What a pack needs to say a body in this file talks to the database. */
  readonly storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
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
  /** Every (function, position) some scanned body passed a named project function into, across the whole run. */
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

export function reachedFunctions(
  seeds: readonly Seed[],
  options: ReachOptions,
): ReachedUnits {
  const ctx: ResolveContext = {
    filesByPath: new Map(options.files.map((file) => [file.file, file])),
    roots: options.roots,
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
  // Every (function, position) some scanned body passes a named project
  // function into. An inline lambda or a variable does not count, so a
  // parameter call missing here is a gap even when a caller supplies one.
  const passedPositions = new Set<string>();

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
    for (const key of frontier) {
      scanned.add(key);
      const source = functionByKey.get(key);
      if (source === undefined) {
        continue;
      }
      const scan = scanBody(source, ctx);
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
    const summary = assembleSummary(libraryUnit(target, options), {
      gapHandling: options.gapHandling,
    });
    summary.confidence = { source: "inferred_static", level: "low" };
    if (options.gapHandling !== "silent") {
      summary.gaps.push(...(stopsByKey.get(key) ?? []).map(unfollowedCallGap));
    }
    placeCalls(summary, targetsByKey.get(key));
    placeArgTargets(summary, argTargetsByKey.get(key));
    placeCalleeParameters(summary, parameterCallsByKey.get(key));
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
    passedPositions,
  };
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file.file, target.node);
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

interface Where {
  readonly scope: Scope;
  readonly rebound: ReadonlySet<string>;
}

const EMPTY_SCAN: Scan = {
  followed: [],
  stops: [],
  targets: new Map(),
  argTargets: new Map(),
  parameterCalls: [],
  passedPositions: new Set(),
};

function scanBody(source: ReachedFunction, ctx: ResolveContext): Scan {
  const followed: ReachedFunction[] = [];
  const stops: UnfollowedCall[] = [];
  const targets = new Map<string, DeclaredAt | null>();
  const argTargets = new Map<string, Map<number, DeclaredAt | null>>();
  const parameterCalls: ParameterCall[] = [];
  const passedPositions = new Set<string>();
  const seen = new Set<string>();
  const parameterCallsSeen = new Set<string>();
  const { file, node } = source;

  const body = field(node, "body");
  if (body === null) {
    return EMPTY_SCAN;
  }

  const ownParameters = callParameterNames(node, source.exportPath.length > 1);

  // An identifier argument that is a project function joins a `passes`
  // fact to whichever parameter of the followed callee it calls through.
  const recordPassedArgs = (
    call: PyNode,
    callee: string,
    calleeKey: string | null,
    where: Where,
  ): void => {
    const args = field(call, "arguments");
    if (args === null) {
      return;
    }
    args.namedChildren.forEach((arg, position) => {
      if (arg === null || arg.type !== "identifier") {
        return;
      }
      const resolved = resolveNamedFunctionArgument(
        arg.text,
        { file, scope: where.scope, rebound: where.rebound },
        ctx,
      );
      if (resolved === null) {
        return;
      }
      const key = keyOf(resolved);
      if (!seen.has(key)) {
        seen.add(key);
        followed.push(resolved);
      }
      rememberArgTarget(argTargets, callee, position, {
        file: resolved.file.displayPath,
        span: spanOf(resolved.node),
      });
      if (calleeKey !== null) {
        passedPositions.add(`${calleeKey}#${position}`);
      }
    });
  };

  const record = (call: PyNode, where: Where): void => {
    const callee = calleeText(call);
    const outcome = resolveCallee(
      call,
      { file, scope: where.scope, rebound: where.rebound },
      ctx,
    );
    // A stop is placed at its own call, where no summary can be, so the
    // link step neither links it nor guesses by name.
    const placed =
      outcome.kind === "followed"
        ? {
            file: outcome.target.file.displayPath,
            span: spanOf(outcome.target.node),
          }
        : outcome.reason === "noDeclaration"
          ? null
          : { file: file.displayPath, span: spanOf(call) };
    rememberTarget(targets, callee, placed);
    recordPassedArgs(
      call,
      callee,
      outcome.kind === "followed" ? keyOf(outcome.target) : null,
      where,
    );

    // One record per callee, however many times the body calls it.
    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.reason}:${callee}`;
      if (!seen.has(stopKey) && worthRecording(outcome.reason)) {
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

  walkDescendants<PyNode, Where>(
    body,
    { scope: scopeAt(file, node), rebound: reboundNames(body) },
    {
      at: (child, where) => {
        if (child.type === "call") {
          record(child, where);
        }
      },
      into: (child, where) => {
        // A nested def is a function of its own, reached when something calls it.
        if (child.type === "function_definition") {
          return SKIP_CHILDREN;
        }
        if (child.type === "lambda") {
          return {
            scope: where.scope,
            rebound: new Set([...where.rebound, ...lambdaParameters(child)]),
          };
        }
        return {
          scope: file.module.scopeFor.get(child.id) ?? where.scope,
          rebound: where.rebound,
        };
      },
    },
  );

  const settled = new Map<string, DeclaredAt>();
  for (const [callee, target] of targets) {
    if (target !== null) {
      settled.set(callee, target);
    }
  }
  const settledArgs = new Map<string, ReadonlyMap<number, DeclaredAt>>();
  for (const [callee, byPosition] of argTargets) {
    const positions = new Map<number, DeclaredAt>();
    for (const [position, target] of byPosition) {
      if (target !== null) {
        positions.set(position, target);
      }
    }
    if (positions.size > 0) {
      settledArgs.set(callee, positions);
    }
  }
  return {
    followed,
    stops,
    targets: settled,
    argTargets: settledArgs,
    parameterCalls,
    passedPositions,
  };
}

/** The same callee text placed two ways, a shadowed name say, has to say so rather than pick one. */
function rememberTarget(
  targets: Map<string, DeclaredAt | null>,
  callee: string,
  placed: DeclaredAt | null,
): void {
  if (placed === null) {
    return;
  }
  const known = targets.get(callee);
  if (known === undefined) {
    targets.set(callee, placed);
    return;
  }
  if (
    known !== null &&
    (known.file !== placed.file ||
      known.span.start !== placed.span.start ||
      known.span.end !== placed.span.end)
  ) {
    targets.set(callee, null);
  }
}

// Same shadow handling as `rememberTarget`, one level down: the
// argument at this position in calls written as `callee`.
function rememberArgTarget(
  argTargets: Map<string, Map<number, DeclaredAt | null>>,
  callee: string,
  position: number,
  placed: DeclaredAt,
): void {
  const byPosition = argTargets.get(callee) ?? new Map();
  argTargets.set(callee, byPosition);
  const known = byPosition.get(position);
  if (known === undefined) {
    byPosition.set(position, placed);
    return;
  }
  if (
    known !== null &&
    (known.file !== placed.file ||
      known.span.start !== placed.span.start ||
      known.span.end !== placed.span.end)
  ) {
    byPosition.set(position, null);
  }
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

/** Where a statement puts a name the binder does not track, so a call on that name is not followed to an outer definition. */
const REBINDING_FIELDS: Record<string, string> = {
  assignment: "left",
  augmented_assignment: "left",
  named_expression: "name",
  for_statement: "left",
  for_in_clause: "left",
  as_pattern: "alias",
};

function reboundNames(body: PyNode): Set<string> {
  const names = new Set<string>();
  walkDescendants<PyNode, null>(body, null, {
    at: (node) => {
      const target = REBINDING_FIELDS[node.type];
      if (target === undefined || boundByBinder(node, body)) {
        return;
      }
      const written = field(node, target);
      if (written !== null) {
        for (const name of identifiersUnder(written)) {
          names.add(name);
        }
      }
    },
    into: (node) =>
      node.type === "function_definition" ? SKIP_CHILDREN : null,
  });
  return names;
}

/** `name = value` written straight in the body is the binder's, and it knows what the value was. */
function boundByBinder(node: PyNode, body: PyNode): boolean {
  if (node.type !== "assignment") {
    return false;
  }
  const statement = node.parent;
  return (
    field(node, "left")?.type === "identifier" &&
    statement?.type === "expression_statement" &&
    statement.parent?.id === body.id
  );
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

function lambdaParameters(lambda: PyNode): string[] {
  const parameters = field(lambda, "parameters");
  return parameters === null ? [] : identifiersUnder(parameters);
}

function libraryUnit(
  target: ReachedFunction,
  options: ReachOptions,
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = field(node, "body");
  const extra = recognizedBodyEffects(
    node,
    file.module,
    options.storageFor(file),
  );
  const range = rangeOf(node);
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
    boundaryBinding: functionCallBinding({
      transport: "in-process",
      recognition: "reachable",
    }),
    parameters: positionalParameters(node, exportPath.length > 1),
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
        effects: invocationEffects(node),
        ...(extra.length === 0 ? {} : { extraEffects: extra }),
        location: range,
        isDefault: true,
      },
    ],
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
 * A function's own parameters, in call order, with a method's leading
 * `self`/`cls` left out since a caller never spells it. This is the
 * position a `callerSupplied` call through one of them joins to a
 * caller's argument by, which needs the receiver left out the way
 * `positionalParameters` counts it in for a different purpose.
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
