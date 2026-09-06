/**
 * One branch per place a function body ends, with the conditions that
 * gate it. The shared path engine does the enumeration; this lowers
 * Python into the form it takes and turns each result back into a
 * `RawBranch`. What a terminal means is the caller's to say, because a
 * return in a route responds while a return in a dependency hands the
 * request on to the handler.
 */

import { enumerateOrDegrade, guardsHoldOn } from "@suss/extractor";

import { NodeSet } from "../ast.js";
import { lowerPythonBody } from "./lowering.js";
import { predicateOf } from "./predicates.js";

import type {
  ConditionInfo,
  RawBranch,
  RawCondition,
  RawEffect,
  RawTerminal,
} from "@suss/extractor";
import type { PyNode } from "../parser.js";
import type { RaisedResponse } from "./raisedResponses.js";

export type InvocationEffect = Extract<RawEffect, { type: "invocation" }>;

/** One place a body ends: a return, a raise, or a call that hands the request on to what the function wraps. */
export type BodyTerminal =
  | { type: "return"; statement: PyNode }
  | { type: "raise"; statement: PyNode; terminal: RawTerminal }
  | { type: "continuation"; statement: PyNode };

/** Everything about a branch except the conditions and the effects on the path that reaches it. */
export type TerminalBranch = Pick<RawBranch, "terminal" | "location"> &
  Partial<Pick<RawBranch, "statusCodeReading" | "bodyShapeReading">>;

/**
 * Every `return` written in this function's own body. A nested function's
 * returns belong to that function, so the walk stops at one.
 */
export function returnStatements(
  node: PyNode | null,
  found: PyNode[] = [],
): PyNode[] {
  for (const child of node?.namedChildren ?? []) {
    if (child === null) {
      continue;
    }
    if (child.type === "function_definition" || child.type === "lambda") {
      continue;
    }
    if (child.type === "return_statement") {
      found.push(child);
    }
    returnStatements(child, found);
  }
  return found;
}

/** Every terminal the body writes, in the order they are written. */
export function bodyTerminals(
  body: PyNode | null,
  raised: readonly RaisedResponse[],
  continuations: readonly PyNode[] = [],
): BodyTerminal[] {
  // `return await call_next(request)` is one statement that both hands on
  // and returns; handing on is what it does to the request.
  const handsOn = new NodeSet(continuations);
  const found: BodyTerminal[] = [
    ...returnStatements(body)
      .filter((statement) => !handsOn.has(statement))
      .map((statement): BodyTerminal => ({ type: "return", statement })),
    ...raised.map(
      (response): BodyTerminal => ({
        type: "raise",
        statement: response.statement,
        terminal: response.terminal,
      }),
    ),
    ...continuations.map(
      (statement): BodyTerminal => ({ type: "continuation", statement }),
    ),
  ];
  return found.sort((a, b) => a.statement.startIndex - b.statement.startIndex);
}

/** A call belongs to a path when everything gating the call also gates the path. */
export function effectsReaching(
  effects: readonly InvocationEffect[],
  conditions: readonly RawCondition[],
): RawEffect[] {
  return effects.filter((effect) =>
    guardsHoldOn(effect.preconditions, conditions),
  );
}

export interface EnumerateBodyOptions {
  body: PyNode | null;
  terminals: readonly BodyTerminal[];
  raised: readonly RaisedResponse[];
  effects: readonly InvocationEffect[];
  branchOf: (terminal: BodyTerminal) => TerminalBranch;
  /** What a path that runs off the end of the body does. Unset drops those paths, which is right for a route that then returns None. */
  fallthrough?: TerminalBranch;
}

/** One branch per path to each terminal, and one per path off the end when the caller says what that does. */
export function enumerateBodyBranches(
  options: EnumerateBodyOptions,
): RawBranch[] {
  const statements = options.terminals.map((found) => found.statement);
  // A raise leaves the unit through the statement itself. A declared call
  // and a continuation leave it through a call the lowering would otherwise
  // read as a step in the middle of the body.
  const leavesByCall = new NodeSet([
    ...options.raised
      .filter((response) => response.thrownByCall)
      .map((response) => response.statement),
    ...options.terminals
      .filter((found) => found.type === "continuation")
      .map((found) => found.statement),
  ]);
  const lowered = lowerPythonBody(options.body, statements, leavesByCall);
  const enumerated = enumerateOrDegrade(
    {
      statements: lowered.statements,
      terminalsByStmt: lowered.terminalsByStmt,
    },
    statements,
  );

  const branches: RawBranch[] = [];
  const push = (
    branch: TerminalBranch,
    paths: readonly ConditionInfo<PyNode>[][],
  ): void => {
    for (const path of paths) {
      const conditions: RawCondition[] = path.map((condition) => ({
        sourceText: condition.sourceText,
        structured:
          condition.expression === null
            ? null
            : predicateOf(condition.expression),
        polarity: condition.polarity,
        source: condition.source,
      }));
      branches.push({
        ...branch,
        conditions,
        effects: effectsReaching(options.effects, conditions),
        isDefault: path.length === 0,
      });
    }
  };

  for (const found of options.terminals) {
    const paths = enumerated.byTerminal.get(found.statement);
    if (paths !== undefined) {
      push(options.branchOf(found), paths);
    }
  }
  if (options.fallthrough !== undefined) {
    push(options.fallthrough, enumerated.fallthrough);
  }
  return branches;
}
