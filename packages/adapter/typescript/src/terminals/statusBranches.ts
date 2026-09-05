/**
 * A status written as a choice.
 *
 * `res.status(created ? 202 : 200)` sends one of two statuses, and
 * reading it as a single unresolved value loses both. A ternary wrapped
 * around the whole call already comes out as two transitions, because
 * the terminal walk follows a conditional's branches, so a ternary
 * inside the status argument is treated the same way: one branch per
 * arm, each with the condition that picks it.
 *
 * The choice is followed through a binding, so
 * `const code = created ? 202 : 200; res.status(code)` means the same as
 * the inline form. Treating them differently would only reflect where
 * somebody happened to put a variable.
 */

import { Node } from "ts-morph";

import { constantOf } from "@suss/values";

import { writesToBinding } from "../facts/assignments.js";
import { evaluatedValue } from "../values/evaluator.js";

import type { Expression, Node as TsNode } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/** One arm of a status written as a choice. */
export interface StatusChoice {
  status: number;
  /** The test that picks this arm, as written. */
  conditionText: string;
  /** The test itself, so a reader gets the predicate and not only text. */
  condition: Expression;
  /** Whether this arm is the one taken when the test is true. */
  whenTrue: boolean;
}

/**
 * The arms of a status argument written as a choice, or null when the
 * argument is anything else.
 *
 * Null covers everything this does not read, including a choice whose
 * arms are not both numbers. A partial result would put one status on a
 * boundary that has two.
 */
export function statusChoicesOf(
  argument: TsNode,
  resolution: ResolutionStore | undefined,
): StatusChoice[] | null {
  const chosen = asConditional(argument);
  if (chosen === null) {
    return null;
  }
  const whenTrue = numberOf(chosen.getWhenTrue(), resolution);
  const whenFalse = numberOf(chosen.getWhenFalse(), resolution);
  if (whenTrue === null || whenFalse === null) {
    return null;
  }
  const condition = chosen.getCondition();
  const conditionText = condition.getText();
  return [
    { status: whenTrue, condition, conditionText, whenTrue: true },
    { status: whenFalse, condition, conditionText, whenTrue: false },
  ];
}

/**
 * The conditional an expression is, or the one it was assigned. A name
 * written once and never assigned again means whatever it was assigned;
 * a name written more than once means nothing this can read.
 */
function asConditional(node: TsNode): ReturnType<typeof toConditional> {
  const direct = toConditional(node);
  if (direct !== null) {
    return direct;
  }
  if (!Node.isIdentifier(node)) {
    return null;
  }
  const declaration = node
    .getSymbol()
    ?.getDeclarations()
    .find(Node.isVariableDeclaration);
  if (declaration === undefined) {
    return null;
  }
  const written = writesToBinding(declaration);
  if (!written.inOrder || written.values.length !== 1) {
    return null;
  }
  const only = written.values[0];
  return only === undefined ? null : toConditional(only);
}

const toConditional = (node: TsNode) =>
  Node.isConditionalExpression(node) ? node : null;

/** The one number an arm settles to, through whatever names it was given. */
function numberOf(
  node: TsNode,
  resolution: ResolutionStore | undefined,
): number | null {
  const value = constantOf(evaluatedValue(node, resolution));
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
