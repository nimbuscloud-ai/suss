// A status written as a choice.
//
// `res.status(created ? 202 : 200)` answers with one of two statuses,
// and reading it as one unresolved value loses both. A ternary wrapped
// around the whole call already comes out as two transitions, because
// the terminal walk follows a conditional's branches, so a ternary
// inside the status argument answers the same way: one branch per arm,
// each carrying the condition that picks it.
//
// The choice is read through the binding it was given, so
// `const code = created ? 202 : 200; res.status(code)` says what the
// inline form says. Anything else about them would be an accident of
// where somebody put a variable.

import { Node } from "ts-morph";

import { writesToBinding } from "../facts/assignments.js";

import type { Expression, Node as TsNode } from "ts-morph";

/** One arm of a status written as a choice. */
export interface StatusChoice {
  status: number;
  /** The test that picks this arm, as written. */
  conditionText: string;
  /** The test itself, so a reader gets the predicate and not only text. */
  condition: Expression;
  /** Whether this arm is the one taken when the test holds. */
  whenTrue: boolean;
}

/**
 * The arms of a status argument written as a choice, or null when the
 * argument is anything else.
 *
 * Null covers every shape this does not read, including a choice whose
 * arms are not both numbers. A partial answer would put one status on a
 * boundary that has two.
 */
export function statusChoicesOf(argument: TsNode): StatusChoice[] | null {
  const chosen = asConditional(argument);
  if (chosen === null) {
    return null;
  }
  const whenTrue = numberOf(chosen.getWhenTrue());
  const whenFalse = numberOf(chosen.getWhenFalse());
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
 * The conditional an expression is, or the one it was given. A name
 * written once and never assigned again stands for what it was given;
 * a name written more than once stands for nothing this can read.
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

/** The number a node is, reading through a parenthesis or an `as`. */
function numberOf(node: TsNode): number | null {
  const inner = unwrap(node);
  if (!Node.isNumericLiteral(inner)) {
    return null;
  }
  const value = Number(inner.getText());
  return Number.isFinite(value) ? value : null;
}

function unwrap(node: TsNode): TsNode {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}
