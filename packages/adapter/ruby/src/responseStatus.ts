/**
 * What a controller action responds with, one outcome per path through its
 * body.
 *
 * A pack says which receiverless calls send a response and where each one
 * takes its status, so this module contains no library's call names.
 *
 * The shared path engine walks the body once. Every declared response call
 * is a terminal, and the statement it is written in ends its path, because
 * Rails raises on a second render. A path that reaches the end of the body,
 * or that ends in a bare `return`, is the implicit render and does not
 * claim a status of its own.
 */

import {
  absentReading,
  enumerateOrDegrade,
  guardsHoldOn,
  unreadableReading,
  writtenReading,
} from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, OWN_BODY_TYPES, rangeOf, readCallArgs } from "./ast.js";
import { isBareMethodCall, localNamesIn } from "./paths/bareCalls.js";
import { lowerRubyBody } from "./paths/lowering.js";
import {
  type GuardInputs,
  operandsOf,
  predicateOf,
} from "./paths/predicates.js";
import { guardInputs } from "./provenance.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type {
  ConditionInfo,
  RawBranch,
  RawCondition,
  RawEffect,
  RawTerminal,
  Reading,
} from "@suss/extractor";
import type { Range } from "./ast.js";
import type { ControllerActions, RbStatusCall } from "./pack.js";
import type { RbNode } from "./parser.js";

/** The argument giving this call's status, or null when the call writes none. */
function statusArgumentOf(
  call: RbNode,
  declaration: RbStatusCall,
): RbNode | null {
  const args = readCallArgs(field(call, "arguments"));
  const keyword =
    declaration.statusKeyword === undefined
      ? undefined
      : args.keyword[declaration.statusKeyword];
  if (keyword !== undefined) {
    return keyword;
  }
  if (declaration.statusArgument === undefined) {
    return null;
  }
  return args.positional[declaration.statusArgument] ?? null;
}

/** The number a status argument comes down to, written either as a number or as one of the names the library accepts. */
function statusNumberOf(
  node: RbNode,
  names: Record<string, number>,
  facts: Database | undefined,
): number | null {
  const value = evaluatedValue(node, facts);
  const constant = constantOf(value);
  if (typeof constant === "number") {
    return constant;
  }
  const name = literalOf(value);
  return name === null ? null : (names[name] ?? null);
}

function declarationsByName(
  declarations: readonly RbStatusCall[],
): Map<string, RbStatusCall> {
  return new Map(
    declarations.map((declaration) => [declaration.name, declaration]),
  );
}

/**
 * The declaration matching a node, when the node is a call with no
 * receiver, as an action writes a response call. `render` written alone
 * with no arguments parses as an identifier and not as a call, so both
 * forms are matched.
 */
function declarationOf(
  node: RbNode,
  byName: ReadonlyMap<string, RbStatusCall>,
  locals: ReadonlySet<string>,
): RbStatusCall | undefined {
  if (node.type === "identifier") {
    return isBareMethodCall(node, locals) ? byName.get(node.text) : undefined;
  }
  if (node.type !== "call" || field(node, "receiver") !== null) {
    return undefined;
  }
  const name = field(node, "method")?.text;
  return name === undefined ? undefined : byName.get(name);
}

/** What decides whether a call in a body sends the response. */
interface Responders {
  byName: ReadonlyMap<string, RbStatusCall>;
  locals: ReadonlySet<string>;
  helper: ((name: string) => Reading<number> | null) | undefined;
}

/** A call that sends the response: one the pack declares, or a project helper that always responds. */
type Responder =
  | { kind: "declared"; declaration: RbStatusCall }
  | { kind: "helper"; reading: Reading<number> };

function responderOf(
  node: RbNode,
  responders: Responders,
): Responder | undefined {
  const declaration = declarationOf(node, responders.byName, responders.locals);
  if (declaration !== undefined) {
    return { kind: "declared", declaration };
  }
  const name = receiverlessName(node, responders.locals);
  const reading =
    name === null || responders.helper === undefined
      ? null
      : responders.helper(name);
  return reading === null ? undefined : { kind: "helper", reading };
}

/** The method a call with no receiver invokes, written with or without arguments. */
function receiverlessName(
  node: RbNode,
  locals: ReadonlySet<string>,
): string | null {
  if (node.type === "identifier") {
    return isBareMethodCall(node, locals) ? node.text : null;
  }
  if (node.type !== "call" || field(node, "receiver") !== null) {
    return null;
  }
  return field(node, "method")?.text ?? null;
}

function readingOfResponder(
  call: RbNode,
  responder: Responder,
  names: Record<string, number>,
  facts: Database | undefined,
): Reading<number> {
  return responder.kind === "helper"
    ? responder.reading
    : readingOfCall(call, responder.declaration, names, facts);
}

/** Every call written in a body that sends the response, in source order. */
function collectResponseCalls(
  node: RbNode,
  responders: Responders,
  found: RbNode[],
): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null || OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    if (responderOf(child, responders) !== undefined) {
      found.push(child);
      continue;
    }
    collectResponseCalls(child, responders, found);
  }
  return found;
}

/** Every `return` written in a body, in source order. */
function collectReturns(node: RbNode, found: RbNode[]): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null || OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    if (child.type === "return") {
      found.push(child);
      continue;
    }
    collectReturns(child, found);
  }
  return found;
}

/** What one response call claims about the status it sends. */
function readingOfCall(
  call: RbNode,
  declaration: RbStatusCall,
  names: Record<string, number>,
  facts: Database | undefined,
): Reading<number> {
  const argument = statusArgumentOf(call, declaration);
  if (argument === null) {
    return declaration.defaultStatusCode === undefined
      ? absentReading
      : writtenReading(declaration.defaultStatusCode, rangeOf(call));
  }
  const status = statusNumberOf(argument, names, facts);
  if (status === null) {
    return unreadableReading(
      "This response writes a status that does not settle on a number here, so this outcome claims none",
      rangeOf(argument),
    );
  }
  return writtenReading(status, rangeOf(argument));
}

/** A call belongs to a path when everything gating the call also gates the path. */
function effectsReaching(
  effects: readonly RawEffect[],
  conditions: readonly RawCondition[],
): RawEffect[] {
  return effects.filter((effect) =>
    guardsHoldOn(
      effect.type === "invocation" ? effect.preconditions : undefined,
      conditions,
    ),
  );
}

/** A condition as the path engine hands it over. */
interface PathCondition {
  sourceText: string;
  polarity: "positive" | "negative";
  source: RawCondition["source"];
  expression: RbNode | null;
}

/** One of the engine's conditions as a raw condition, with the predicate read out of its Ruby expression when it has one. */
function conditionOf(
  condition: PathCondition,
  inputs: GuardInputs | undefined,
): RawCondition {
  return {
    sourceText: condition.sourceText,
    structured:
      condition.expression === null
        ? null
        : predicateOf(condition.expression, inputs),
    polarity: condition.polarity,
    source: condition.source,
  };
}

/**
 * The input each subject of a method's conditions reads, asked once for
 * every path through it.
 */
function conditionInputs(
  method: RbNode,
  paths: ReadonlyArray<readonly PathCondition[]>,
  facts: Database | undefined,
): GuardInputs | undefined {
  if (facts === undefined) {
    return undefined;
  }
  const operands = paths.flatMap((path) =>
    path.flatMap((condition) =>
      condition.expression === null ? [] : operandsOf(condition.expression),
    ),
  );
  return operands.length === 0
    ? undefined
    : guardInputs(operands, { facts, unit: method });
}

interface Outcome {
  conditions: RawCondition[];
  reading: Reading<number>;
  location: Range;
  /** True for a path that reached no response call of its own. */
  fellThrough?: boolean;
}

/** `fallthrough` says what a path that writes no response of its own does. A filter hands the request on, and an action responds with the library's default. */
export interface BranchOptions {
  fallthrough?: "respond" | "handOn";
  /** The project's facts, so a status written as a constant another file defines resolves. */
  facts?: Database | undefined;
  /** What a project method sends when every path through it responds, or null when it does not. */
  respondingHelper?: (name: string) => Reading<number> | null;
}

/**
 * What a helper method responds with, read one hop deep: every path
 * through it has to end at a call the pack declares, or it does not
 * count. A status that differs between paths, or is a parameter the
 * caller passes, is reported as unread.
 */
export function helperResponse(
  helper: RbNode,
  pattern: ControllerActions,
  facts: Database | undefined,
): Reading<number> | null {
  const branches = responseBranches(helper, pattern, [], undefined, {
    fallthrough: "handOn",
    facts,
  });
  if (
    branches === null ||
    branches.some((branch) => branch.terminal.kind !== "response")
  ) {
    return null;
  }
  const statuses = new Set(
    branches.map((branch) => {
      const reading = branch.statusCodeReading?.reading;
      if (reading?.kind === "absent") {
        return branch.statusCodeReading?.libraryDefault ?? null;
      }
      return reading?.kind === "written" ? reading.value : null;
    }),
  );
  const [only] = [...statuses];
  return statuses.size === 1 && typeof only === "number"
    ? writtenReading(only, rangeOf(helper))
    : unreadableReading(
        "This response is sent by a helper whose status does not settle on one number here, so this outcome claims none",
        rangeOf(helper),
      );
}

function branchOf(
  outcome: Outcome,
  pattern: ControllerActions,
  effects: readonly RawEffect[],
  extraEffects: RawBranch["extraEffects"],
  options: BranchOptions,
): RawBranch {
  if (outcome.fellThrough === true && options.fallthrough === "handOn") {
    return handsOnBranch(outcome, effects, extraEffects);
  }
  return {
    conditions: outcome.conditions,
    terminal: {
      kind: "response",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: outcome.location,
    },
    statusCodeReading: {
      reading: outcome.reading,
      libraryDefault: pattern.defaultStatusCode,
    },
    effects: effectsReaching(effects, outcome.conditions),
    ...(extraEffects === undefined ? {} : { extraEffects }),
    location: outcome.location,
    isDefault: outcome.conditions.length === 0,
  };
}

/** A path through a filter that wrote no response: the request goes on to whatever the filter wraps. */
function handsOnBranch(
  outcome: Outcome,
  effects: readonly RawEffect[],
  extraEffects: RawBranch["extraEffects"],
): RawBranch {
  return {
    conditions: outcome.conditions,
    terminal: {
      kind: "delegate",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: outcome.location,
    },
    effects: effectsReaching(effects, outcome.conditions),
    ...(extraEffects === undefined ? {} : { extraEffects }),
    location: outcome.location,
    isDefault: outcome.conditions.length === 0,
  };
}

/**
 * One branch per path a method returns on, with the conditions that
 * reach it and no status reading. A client of another service ends
 * every path by returning what it got, so the tests along each path
 * show which statuses it handles.
 */
export function returnPathBranches(
  method: RbNode,
  effects: readonly RawEffect[],
  exits: readonly EndingCall[] = [],
  facts?: Database,
): RawBranch[] | null {
  const body = field(method, "body");
  if (body === null) {
    return null;
  }
  const returns = collectReturns(body, []);
  const exitCalls = exits.map((exit) => exit.call);
  const lowered = lowerRubyBody(body, [...returns, ...exitCalls], exitCalls);
  const enumerated = enumerateOrDegrade(
    {
      statements: lowered.statements,
      terminalsByStmt: lowered.terminalsByStmt,
    },
    [...returns, ...exitCalls],
  );

  const inputs = conditionInputs(
    method,
    [...enumerated.byTerminal.values(), enumerated.fallthrough].flat(),
    facts,
  );
  const branches: RawBranch[] = [];
  const push = (
    paths: readonly ConditionInfo<RbNode>[][],
    terminal: RawTerminal,
  ): void => {
    for (const path of paths) {
      const conditions = path.map((condition) =>
        conditionOf(condition, inputs),
      );
      branches.push({
        conditions,
        terminal,
        effects: effectsReaching(effects, conditions),
        location: terminal.location,
        isDefault: conditions.length === 0,
      });
    }
  };

  for (const statement of returns) {
    push(
      enumerated.byTerminal.get(statement) ?? [],
      returnTerminal(rangeOf(statement)),
    );
  }
  for (const exit of exits) {
    push(enumerated.byTerminal.get(exit.call) ?? [], exit.terminal);
  }
  push(enumerated.fallthrough, returnTerminal(rangeOf(method)));
  return branches.length === 0 ? null : branches;
}

/** A call that ends the method's run, with the terminal it ends on. */
export interface EndingCall {
  call: RbNode;
  terminal: RawTerminal;
}

function returnTerminal(location: Range): RawTerminal {
  return {
    kind: "return",
    statusCode: null,
    body: null,
    exceptionType: null,
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location,
  };
}

/**
 * One branch per path a body can respond on. Null when the pack declares no
 * response calls, or when the method has no body, and then the caller keeps
 * its own single branch.
 */
export function responseBranches(
  method: RbNode,
  pattern: ControllerActions,
  effects: readonly RawEffect[],
  extraEffects: RawBranch["extraEffects"],
  options: BranchOptions = {},
): RawBranch[] | null {
  const declarations = pattern.responseStatusCalls ?? [];
  const body = field(method, "body");
  if (declarations.length === 0 || body === null) {
    return null;
  }

  const responders: Responders = {
    byName: declarationsByName(declarations),
    locals: localNamesIn(method),
    helper: options.respondingHelper,
  };
  const responses = collectResponseCalls(body, responders, []);
  const returns = collectReturns(body, []);
  const lowered = lowerRubyBody(body, returns, responses);

  // A `return` written on its own responds with whatever Rails renders
  // implicitly, so it is an outcome of its own. One written around a
  // response call is that call's outcome and not a second one.
  const bareReturns = returns.filter(
    (node) =>
      lowered.terminalHome.has(node) &&
      collectResponseCalls(node, responders, []).length === 0,
  );
  const terminals = [...responses, ...bareReturns];
  const enumerated = enumerateOrDegrade(
    {
      statements: lowered.statements,
      terminalsByStmt: lowered.terminalsByStmt,
    },
    terminals,
  );

  const statusNames = pattern.statusCodeNames ?? {};
  const inputs = conditionInputs(
    method,
    [...enumerated.byTerminal.values(), enumerated.fallthrough].flat(),
    options.facts,
  );
  const conditionsOf = (path: readonly PathCondition[]): RawCondition[] =>
    path.map((condition) => conditionOf(condition, inputs));
  const outcomes: Outcome[] = [];
  for (const terminal of terminals) {
    const responder = responderOf(terminal, responders);
    const reading =
      responder === undefined
        ? absentReading
        : readingOfResponder(terminal, responder, statusNames, options.facts);
    for (const path of enumerated.byTerminal.get(terminal) ?? []) {
      outcomes.push({
        conditions: conditionsOf(path),
        reading,
        location: rangeOf(terminal),
        // A bare `return` wrote no response, so a filter that takes it
        // hands the request on the same as one that reaches its end.
        ...(responder === undefined ? { fellThrough: true } : {}),
      });
    }
  }
  for (const path of enumerated.fallthrough) {
    outcomes.push({
      conditions: conditionsOf(path),
      reading: absentReading,
      location: rangeOf(method),
      fellThrough: true,
    });
  }

  if (outcomes.length === 0) {
    return null;
  }
  return outcomes.map((outcome) =>
    branchOf(outcome, pattern, effects, extraEffects, options),
  );
}
