/**
 * Whether a branch condition always comes out the same way, read with
 * the sound evaluator and Ruby's rule for what counts as true.
 */

import { settledTest } from "@suss/values";

import { children, field } from "../ast.js";
import { soundValueOf } from "../values/evaluator.js";
import { rubyTruthiness } from "../values/truthiness.js";

import type { Database } from "@suss/datalog";
import type { SettledCondition } from "@suss/extractor";
import type { RbNode } from "../parser.js";

/** What the condition at `expression` comes to on every run, or null when some run could differ. */
export function settledConditionOf(
  expression: RbNode,
  facts: Database | undefined,
): SettledCondition | null {
  return settledTest(
    soundValueOf(expression, facts),
    () => soundValueOf(withoutNegations(expression), facts),
    rubyTruthiness,
  );
}

/** `!x`, `not x` and `(x)` all test the truth of `x`. */
function withoutNegations(expression: RbNode): RbNode {
  if (expression.type === "parenthesized_statements") {
    const inner = children(expression);
    const only = inner[0];
    return inner.length === 1 && only !== undefined
      ? withoutNegations(only)
      : expression;
  }
  const operator = field(expression, "operator")?.text;
  const operand = field(expression, "operand");
  if (
    expression.type === "unary" &&
    (operator === "!" || operator === "not") &&
    operand !== null
  ) {
    return withoutNegations(operand);
  }
  return expression;
}
