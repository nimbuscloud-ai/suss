// shared.ts: types shared between every terminal matcher.

import { Node } from "ts-morph";

import { passesValueThrough, peelValue } from "../walk/unwrap.js";

import type { RawCondition, RawTerminal } from "@suss/extractor";

export interface FoundTerminal {
  node: Node;
  terminal: RawTerminal;
  /**
   * The return this terminal came from: a ReturnStatement, or the body
   * of an arrow that returns without writing `return`. Absent when the
   * terminal is not a return at all, as a throw is not.
   *
   * Only the matcher knows this, because `node` is wherever that
   * matcher stopped looking, which differs from matcher to matcher.
   * Anything downstream that tried to guess got it wrong.
   */
  source?: Node;
  /**
   * A test that also has to be true for this terminal to be the one that
   * fires, on top of whatever the path to it required.
   *
   * One call site produces more than one status when the status is
   * written as a choice, and nothing else tells the arms apart: they
   * share a node, so the path engine gives them the same conditions.
   */
  whenAlso?: RawCondition;
}

/**
 * The value inside the wrappers that pass it along unchanged:
 * parentheses, an await, a cast. `await json(payload)` and
 * `json(payload)` produce the same response, so a matcher looking at the
 * call has to see through the await to find it.
 */
export function unwrapValue(node: Node): Node {
  return peelValue(node);
}

/**
 * The return a value leaves the function through, or null when it does
 * not leave. For a concise arrow this is the body, since that is what
 * the arrow returns without writing `return`.
 *
 * The walk passes through everything that hands a value along unchanged:
 * parentheses, casts, an await, either branch of a ternary. It stops at
 * anything else, so a value assigned to a variable or passed to a call
 * is not in return position.
 */
export function returnPositionOf(value: Node): Node | null {
  let current: Node = value;
  while (true) {
    const parent: Node | undefined = current.getParent();
    if (parent === undefined) {
      return null;
    }
    if (Node.isReturnStatement(parent)) {
      return parent;
    }
    if (Node.isArrowFunction(parent)) {
      return parent.getBody() === current ? current : null;
    }
    if (passesValueThrough(parent)) {
      current = parent;
      continue;
    }
    // Only the branches of a ternary are returned; its condition is not.
    if (
      Node.isConditionalExpression(parent) &&
      (parent.getWhenTrue() === current || parent.getWhenFalse() === current)
    ) {
      current = parent;
      continue;
    }
    return null;
  }
}
