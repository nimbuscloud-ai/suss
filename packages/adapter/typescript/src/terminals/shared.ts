// shared.ts — types shared between every terminal matcher.

import { Node } from "ts-morph";

import type { RawTerminal } from "@suss/extractor";

export interface FoundTerminal {
  node: Node;
  terminal: RawTerminal;
  /**
   * The return this terminal came from: a ReturnStatement, or the body
   * of an arrow that returns without writing `return`. Absent when the
   * terminal is not a return at all, as a throw is not.
   *
   * The matcher is the only thing that knows, because `node` is
   * wherever the matcher stopped looking, which differs by matcher.
   * Anything downstream that guessed instead got it wrong.
   */
  source?: Node;
}

/**
 * The value inside the wrappers that carry it along without changing
 * what it is: parentheses, an await, a cast. `await json(payload)` and
 * `json(payload)` produce the same response, so a matcher looking at
 * the call has to see through the await to find it.
 */
export function unwrapValue(node: Node): Node {
  let current: Node = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAwaitExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * The return a value leaves through, or null when the value does not
 * leave the function. A concise arrow answers with its body, since that
 * is what it returns without writing `return`.
 *
 * The walk passes through everything that carries a value along without
 * changing where it goes: parentheses, casts, an await, either branch of
 * a ternary. It stops at anything else, so a value assigned to a
 * variable or passed to a call is not in return position.
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
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAwaitExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isSatisfiesExpression(parent)
    ) {
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
