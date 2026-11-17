/**
 * Whether a branch condition always comes out the same way, read with
 * the sound evaluator and Python's rule for what counts as true.
 */

import { settledTest } from "@suss/values";

import { children, field } from "../ast.js";
import { soundValueOf } from "../values/evaluator.js";
import { pythonTruthiness } from "../values/truthiness.js";

import type { Database } from "@suss/datalog";
import type { SettledCondition } from "@suss/extractor";
import type { PyNode } from "../parser.js";

/** What the condition at `expression` comes to on every run, or null when some run could differ. */
export function settledConditionOf(
  expression: PyNode,
  facts: Database | undefined,
): SettledCondition | null {
  return settledTest(
    soundValueOf(expression, facts),
    () => soundValueOf(withoutNegations(expression), facts),
    pythonTruthiness,
  );
}

/** `not x` and `(x)` both test the truth of `x`. */
function withoutNegations(expression: PyNode): PyNode {
  if (expression.type === "parenthesized_expression") {
    const inner = children(expression)[0];
    return inner === undefined ? expression : withoutNegations(inner);
  }
  if (expression.type === "not_operator") {
    const operand = field(expression, "argument");
    return operand === null ? expression : withoutNegations(operand);
  }
  return expression;
}
