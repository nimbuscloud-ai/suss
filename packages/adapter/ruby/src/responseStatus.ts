/**
 * What a controller action responds with, one outcome per path through its
 * body.
 *
 * A pack says which receiverless calls send a response and where each one
 * takes its status. Nothing a library defines is written here.
 *
 * The shared path engine walks the body once. Every declared response call
 * is a terminal, and the statement it is written in ends its path, because
 * Rails raises on a second render. A path that reaches the end of the body,
 * or that ends in a bare `return`, is the implicit render and claims no
 * status of its own. The package README says more.
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
import { evaluatedValue } from "./values/evaluator.js";

import type {
  RawBranch,
  RawCondition,
  RawEffect,
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
): number | null {
  const value = evaluatedValue(node);
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
 * The declaration matching a node, when the node is a call with no receiver,
 * which is how an action writes one of these. A name written on its own,
 * `render` with no arguments at all, parses as an identifier rather than as
 * a call, so both spellings are matched.
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

/** Every declared response call written in a body, in source order. */
function collectResponseCalls(
  node: RbNode,
  byName: ReadonlyMap<string, RbStatusCall>,
  locals: ReadonlySet<string>,
  found: RbNode[],
): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null || OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    if (declarationOf(child, byName, locals) !== undefined) {
      found.push(child);
      continue;
    }
    collectResponseCalls(child, byName, locals, found);
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
): Reading<number> {
  const argument = statusArgumentOf(call, declaration);
  if (argument === null) {
    return declaration.defaultStatusCode === undefined
      ? absentReading
      : writtenReading(declaration.defaultStatusCode, rangeOf(call));
  }
  const status = statusNumberOf(argument, names);
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

/** The engine's own condition, with no predicate read out of the Ruby expression yet. */
function conditionOf(condition: {
  sourceText: string;
  polarity: "positive" | "negative";
  source: RawCondition["source"];
}): RawCondition {
  return {
    sourceText: condition.sourceText,
    structured: null,
    polarity: condition.polarity,
    source: condition.source,
  };
}

interface Outcome {
  conditions: RawCondition[];
  reading: Reading<number>;
  location: Range;
}

function branchOf(
  outcome: Outcome,
  pattern: ControllerActions,
  effects: readonly RawEffect[],
  extraEffects: RawBranch["extraEffects"],
): RawBranch {
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
): RawBranch[] | null {
  const declarations = pattern.responseStatusCalls ?? [];
  const body = field(method, "body");
  if (declarations.length === 0 || body === null) {
    return null;
  }

  const byName = declarationsByName(declarations);
  const locals = localNamesIn(method);
  const responses = collectResponseCalls(body, byName, locals, []);
  const returns = collectReturns(body, []);
  const lowered = lowerRubyBody(body, returns, responses);

  // A `return` written on its own responds with whatever Rails renders
  // implicitly, so it is an outcome of its own. One written around a
  // response call is that call's outcome and not a second one.
  const bareReturns = returns.filter(
    (node) =>
      lowered.terminalHome.has(node) &&
      collectResponseCalls(node, byName, locals, []).length === 0,
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
  const outcomes: Outcome[] = [];
  for (const terminal of terminals) {
    const declaration = declarationOf(terminal, byName, locals);
    const reading =
      declaration === undefined
        ? absentReading
        : readingOfCall(terminal, declaration, statusNames);
    for (const path of enumerated.byTerminal.get(terminal) ?? []) {
      outcomes.push({
        conditions: path.map(conditionOf),
        reading,
        location: rangeOf(terminal),
      });
    }
  }
  for (const path of enumerated.fallthrough) {
    outcomes.push({
      conditions: path.map(conditionOf),
      reading: absentReading,
      location: rangeOf(method),
    });
  }

  if (outcomes.length === 0) {
    return null;
  }
  return outcomes.map((outcome) =>
    branchOf(outcome, pattern, effects, extraEffects),
  );
}
