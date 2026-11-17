/**
 * Whether a branch condition always comes out the same way, read with
 * the sound evaluator and JavaScript's rule for what counts as true.
 */

import { Node, SyntaxKind } from "ts-morph";

import { settledTest } from "@suss/values";

import { soundValueOf } from "./values/evaluator.js";
import { javascriptTruthiness } from "./values/truthiness.js";
import { peelSyntax } from "./walk/unwrap.js";

import type { SettledCondition } from "@suss/extractor";
import type { ResolutionStore } from "./facts/store.js";

/** What the condition at `expression` comes to on every run, or null when some run could differ. */
export function settledConditionOf(
  expression: Node,
  resolution: ResolutionStore | undefined,
): SettledCondition | null {
  return settledTest(
    soundValueOf(expression, resolution),
    () => soundValueOf(withoutNegations(expression), resolution),
    javascriptTruthiness,
  );
}

/** `!x`, `!!x` and `(x)` all test the truth of `x`. */
function withoutNegations(expression: Node): Node {
  const peeled = peelSyntax(expression);
  if (
    Node.isPrefixUnaryExpression(peeled) &&
    peeled.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    return withoutNegations(peeled.getOperand());
  }
  return peeled;
}
