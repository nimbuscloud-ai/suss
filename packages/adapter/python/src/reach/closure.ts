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
import { resolveCallee } from "./resolveCallee.js";

import type {
  BehavioralSummary,
  DeclaredAt,
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
    summaries.push(summary);
  }

  return { summaries, targetsByKey, stopsByKey };
}

/** Say on each invocation effect where its callee is declared, so the link step can find the summary there. */
export function placeCalls(
  summary: BehavioralSummary,
  targets: ReadonlyMap<string, DeclaredAt> | undefined,
): void {
  if (targets === undefined) {
    return;
  }
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation") {
        continue;
      }
      const target = targets.get(effect.callee);
      if (target !== undefined) {
        effect.declaredAt = target;
      }
    }
  }
}

function keyOf(target: ReachedFunction): string {
  return nodeId(target.file.file, target.node);
}

/** What one pass over a body found: functions to walk into, stops, and where each callee was placed. */
interface Scan {
  readonly followed: ReachedFunction[];
  readonly stops: UnfollowedCall[];
  readonly targets: ReadonlyMap<string, DeclaredAt>;
}

interface Where {
  readonly scope: Scope;
  readonly rebound: ReadonlySet<string>;
}

function scanBody(source: ReachedFunction, ctx: ResolveContext): Scan {
  const followed: ReachedFunction[] = [];
  const stops: UnfollowedCall[] = [];
  const targets = new Map<string, DeclaredAt | null>();
  const seen = new Set<string>();
  const { file, node } = source;

  const body = field(node, "body");
  if (body === null) {
    return { followed, stops, targets: new Map() };
  }

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

    // One record per callee, however many times the body calls it.
    if (outcome.kind === "stopped") {
      const stopKey = `${outcome.reason}:${callee}`;
      if (!seen.has(stopKey) && worthRecording(outcome.reason)) {
        seen.add(stopKey);
        stops.push({ callee, reason: outcome.reason });
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
  return { followed, stops, targets: settled };
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
