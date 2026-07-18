// descent.ts — language-structural rules for the unit-body walkers.
//
// A code unit's body is walked by several passes (recognizer dispatch,
// invocation-effect capture, terminal discovery). Each pass runs a
// ts-morph `forEachDescendant` from the unit root and has to answer the
// same question at every nested function it reaches: descend into it, or
// treat it as a hard stop?
//
// This is ECMAScript knowledge, not runtime or framework knowledge, so
// it lives in the adapter (see docs/architecture.md, "Adapter vs pack
// ownership"). A nested `FunctionExpression` / `ArrowFunction` is
// lexical scope — a Promise executor, a `.then` callback, an
// `array.forEach` body, an IIFE. The behavior inside it (calls, config
// reads, response writes) is behavior of the enclosing unit, so the
// walker descends and recognizers fire there as if the code were inline.
// A nested `FunctionDeclaration` / `MethodDeclaration` is a named unit of
// record reached through discovery or the reachable-closure pass; the
// walker stops so its behavior isn't attributed twice.
//
// The single opt-out is a pack-declared sub-unit boundary. When a pack's
// `subUnits` hook claims a nested function (a React event handler, a
// `useEffect` body, a scheduled callback), that function gets its own
// summary and identity; the walker stops at it so its effects belong to
// the sub-unit, not the parent. Those function nodes are passed in as
// `barriers`.

import { Node } from "ts-morph";

/**
 * Nested function nodes a pack claimed as sub-units. The unit-body
 * walkers stop at these so the sub-unit's behavior isn't double-counted
 * on the parent.
 */
export type DescentBarriers = ReadonlySet<Node>;

export const NO_BARRIERS: DescentBarriers = new Set<Node>();

/**
 * Should a body walker treat `node` as a hard stop (skip its subtree)
 * rather than descend through it?
 *
 * `func` (the unit root) is never a stop — its own body is always
 * walked. For any other node:
 *   - `FunctionDeclaration` / `MethodDeclaration` → stop (named units of
 *     record, summarized elsewhere).
 *   - `FunctionExpression` / `ArrowFunction` → descend, unless the node
 *     is a declared sub-unit boundary, in which case stop.
 *   - anything else → not a function boundary, never a stop.
 */
export function isDescentStop(
  node: Node,
  func: Node,
  barriers: DescentBarriers = NO_BARRIERS,
): boolean {
  if (node === func) {
    return false;
  }
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return true;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return barriers.has(node);
  }
  return false;
}

/**
 * Does reaching `node` from `func` cross (or land on) a nested
 * function-expression / arrow scope?
 *
 * Terminal discovery uses this to keep return-valued terminals (a
 * `return`, a returned object shape, a JSX render) scoped to their own
 * function: a `return` inside a `.then` callback yields the callback's
 * value, not the enclosing unit's. Terminals that write through a
 * parent-owned channel (a `res.json(...)` on the unit's own parameter)
 * stay observable regardless of nesting and are matched anyway.
 */
export function crossesNestedFunctionScope(node: Node, func: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined && current !== func) {
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}
