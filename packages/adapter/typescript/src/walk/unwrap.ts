// unwrap.ts: language-structural rules for peeling off wrappers that
// pass a value along without changing what it is.
//
// This is ECMAScript knowledge, the same category as descent.ts, so it
// lives in the adapter rather than in any pack. It is under walk/
// rather than beside either caller because the shape passes and the
// resolution passes both need it and already import each other.
//
// The two exported peelers differ on `await`, which is the only axis
// that matters. A pass asking "what type does the checker give this"
// wants to stop at the await, because TypeScript already reports the
// resolved type there and peeling would hand back `Promise<T>` instead
// of `T`. A pass asking "what value flows here" wants to see through it.

import { Node } from "ts-morph";

// Peeling is one layer per pass, so an odd AST could in principle nest
// deeply. The bound is what stops that becoming a hang.
const MAX_LAYERS = 16;

/**
 * The expression inside any type-level wrappers: `as` and
 * angle-bracket assertions, parentheses, non-null `!`, and `satisfies`.
 * The `await` is left in place, so the caller can still ask TypeScript
 * for the awaited type.
 */
export function peelSyntax(node: Node): Node {
  let current = node;
  for (let i = 0; i < MAX_LAYERS; i++) {
    if (
      Node.isAsExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isSatisfiesExpression(current)
    ) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

/** The expression inside any parentheses, and nothing else. */
export function peelParens(node: Node): Node {
  let current = node;
  for (let i = 0; i < MAX_LAYERS; i++) {
    if (!Node.isParenthesizedExpression(current)) {
      break;
    }
    current = current.getExpression();
  }
  return current;
}

/**
 * The expression inside every value-preserving wrapper, `await`
 * included, for a pass asking "what value flows here". A pass reading
 * types off the checker wants `peelSyntax` instead, so the await stays
 * where TypeScript reports the resolved type.
 */
export function peelValue(node: Node): Node {
  let current = node;
  for (let i = 0; i < MAX_LAYERS; i++) {
    const inner = peelSyntax(current);
    if (Node.isAwaitExpression(inner)) {
      current = inner.getExpression();
      continue;
    }
    if (inner === current) {
      break;
    }
    current = inner;
  }
  return current;
}

/**
 * Whether this node passes its inner value through unchanged: the
 * wrapper kinds the peelers see through, for a walk that climbs
 * parents instead of peeling down.
 */
export function passesValueThrough(node: Node): boolean {
  return (
    Node.isParenthesizedExpression(node) ||
    Node.isAwaitExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isNonNullExpression(node) ||
    Node.isSatisfiesExpression(node)
  );
}
