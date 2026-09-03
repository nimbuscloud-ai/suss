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

import {
  bodyStatements,
  field,
  OWN_BODY_TYPES,
  rangeOf,
  spanOf,
} from "../ast.js";
import { bodyOfMethod } from "../discovery.js";
import { nodeId } from "../facts/values.js";
import { bodyCalls, calleeText, withoutChainLinks } from "../paths/effects.js";
import { walkDefinitions } from "../scope.js";
import { resolveCallee, resolveMethodReference } from "./resolveCallee.js";

import type {
  BehavioralSummary,
  DeclaredAt,
  ParameterCall,
  UnfollowedCall,
} from "@suss/behavioral-ir";
import type { RawCodeStructure, RawParameter } from "@suss/extractor";
import type { AncestorLookup, ReachedBody } from "../ancestry.js";
import type { RbNode } from "../parser.js";
import type { RbStorageOptions } from "../storage.js";
import type {
  CallSite,
  ReachContext,
  ReachedFunction,
} from "./resolveCallee.js";

export interface ReachOptions {
  /** Every file this run parsed, so a call anywhere in the project can be placed against a class defined in any of them. */
  readonly files: readonly { file: string; root: RbNode }[];
  readonly storage?: RbStorageOptions | undefined;
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
  const ctx = buildReachContext(options.files);
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
    for (const key of frontier) {
      scanned.add(key);
      const source = functionByKey.get(key);
      if (source === undefined) {
        continue;
      }
      const scan = await scanBody(source, ctx, options.displayPathOf);
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
      gapHandling: "permissive",
    });
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
    passedPositions,
  };
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file, target.node);
}

/** Every class the run defines, and every method written outside one, so a call anywhere can be placed without re-reading a file per call. */
function buildReachContext(
  files: readonly { file: string; root: RbNode }[],
): ReachContext {
  const blocksByQualifiedName = new Map<string, ReachedBody[]>();
  const classes: { file: string; info: ReachedBody["info"] }[] = [];
  for (const { file, root } of files) {
    walkDefinitions(root, (info) => classes.push({ file, info }));
  }
  const knownClasses = new Set(classes.map(({ info }) => info.qualifiedName));
  for (const { file, info } of classes) {
    const list = blocksByQualifiedName.get(info.qualifiedName) ?? [];
    list.push({ info, knownClasses, file });
    blocksByQualifiedName.set(info.qualifiedName, list);
  }

  const topLevelMethods = new Map<string, ReachedFunction[]>();
  for (const { file, root } of files) {
    for (const method of topLevelMethodNodes(root)) {
      const name = field(method, "name")?.text;
      if (name === undefined) {
        continue;
      }
      const list = topLevelMethods.get(name) ?? [];
      list.push({
        file,
        node: method,
        name,
        exportPath: [name],
        enclosingQualifiedName: null,
      });
      topLevelMethods.set(name, list);
    }
  }

  const lookup: AncestorLookup = {
    root: "",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: [],
    // Every class the run defines is already in `blocksByQualifiedName`
    // above, so a name that misses there is outside the run and this
    // never has a file on disk to read.
    parsedFile: async () => null,
    localDefinition: (name) => blocksByQualifiedName.get(name) ?? null,
  };

  return { lookup, knownClasses, topLevelMethods };
}

/** A `def` written outside any class, module, or other method, which Ruby calls a private method on every object. */
function topLevelMethodNodes(root: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of bodyStatements(root)) {
    if (child.type === "method") {
      found.push(child);
      continue;
    }
    if (OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    topLevelMethodNodes(child, found);
  }
  return found;
}

/** The nesting a body written in `qualifiedName` runs a bare constant against, most specific first. */
function nestingOf(qualifiedName: string): string[] {
  const parts = qualifiedName.split("::");
  const out: string[] = [];
  for (let depth = parts.length; depth >= 1; depth--) {
    out.push(parts.slice(0, depth).join("::"));
  }
  return out;
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
}

const EMPTY_SCAN: Scan = {
  followed: [],
  stops: [],
  targets: new Map(),
  argTargets: new Map(),
  parameterCalls: [],
  passedPositions: new Set(),
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

async function scanBody(
  source: ReachedFunction,
  ctx: ReachContext,
  displayPathOf: (file: string) => string,
): Promise<Scan> {
  const body = field(source.node, "body");
  if (body === null) {
    return EMPTY_SCAN;
  }

  const calls = withoutChainLinks(bodyCalls(body));
  const ownParameters = positionalParameters(source.node).map((p) => p.name);
  const site: CallSite = {
    enclosingQualifiedName: source.enclosingQualifiedName,
    nesting:
      source.enclosingQualifiedName === null
        ? []
        : nestingOf(source.enclosingQualifiedName),
    ownParameters,
  };

  const followed: ReachedFunction[] = [];
  const stops: UnfollowedCall[] = [];
  const placements = new TargetPlacements();
  const parameterCalls: ParameterCall[] = [];
  const passedPositions = new Set<string>();
  const seen = new Set<string>();
  const parameterCallsSeen = new Set<string>();

  // A `method(:name)` reference joins a `passes` fact to whichever
  // parameter of the followed callee it calls through.
  const recordPassedArgs = async (
    call: RbNode,
    callee: string,
    calleeKey: string | null,
  ): Promise<void> => {
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
      const resolved = await resolveMethodReference(
        symbol.text.slice(1),
        site,
        ctx,
      );
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
    const outcome = await resolveCallee(call, site, ctx);
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
    await recordPassedArgs(
      call,
      callee,
      outcome.kind === "followed" ? keyOf(outcome.target) : null,
    );

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
  };
}

function libraryUnit(
  target: ReachedFunction,
  options: ReachOptions,
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = bodyOfMethod(node, options.storage);
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
