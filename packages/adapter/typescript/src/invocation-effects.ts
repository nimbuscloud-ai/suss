// invocation-effects.ts — Capture bare call-expression statements as
// `invocation` RawEffects. Phase 1.5b: handler / useEffect-body /
// callback summaries were shipping with `effects: []` because the
// existing `extractDependencyCalls` pass only picks up calls whose
// result is assigned to a variable. That misses the bulk of effect
// calls in callback bodies — `setCount(n);`, `onChange(value);`,
// `document.title = x;`, `emitter.emit("x", y);` — which fire for
// side effect and discard the result.
//
// Scope for v0:
//   * Collect every `CallExpression` whose parent is an
//     `ExpressionStatement` inside the function body.
//   * Skip nested function bodies — their calls belong to those
//     functions' summaries.
//   * Don't try to classify semantics. All captured calls become
//     `invocation` effects with the callee's source text. Follow-up:
//     recognise `setState` from `useState(...)` destructuring as
//     `stateChange`, callback-prop invocations as `emission`, etc.
//   * Async detection via `Node.isAwaitExpression` on the call's
//     parent.

import { type CallExpression, Node } from "ts-morph";

import type { RawEffect } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

export interface InvocationEffectLocation {
  effect: RawEffect;
  /**
   * Start line of the containing `ExpressionStatement`. Used by the
   * assembly pass to assign effects to the right branch.
   */
  line: number;
}

export function extractInvocationEffects(
  func: FunctionRoot,
): InvocationEffectLocation[] {
  const results: InvocationEffectLocation[] = [];

  func.forEachDescendant((node, traversal) => {
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }
    if (!Node.isExpressionStatement(node)) {
      return;
    }
    const expr = node.getExpression();
    const { call, async } = unwrapCall(expr);
    if (call === null) {
      return;
    }
    results.push({
      effect: {
        type: "invocation",
        callee: call.getExpression().getText(),
        async,
      },
      line: node.getStartLineNumber(),
    });
  });

  return results;
}

/**
 * If the expression is a `CallExpression` (possibly awaited / `void`'d /
 * parenthesised), return the call and whether it's `await`-wrapped.
 * Handles the two common forms of top-level side-effecting calls:
 *
 *   setCount(n);
 *   await fetchUser(id);
 */
function unwrapCall(node: Node): {
  call: CallExpression | null;
  async: boolean;
} {
  if (Node.isAwaitExpression(node)) {
    const inner = node.getExpression();
    if (Node.isCallExpression(inner)) {
      return { call: inner, async: true };
    }
    return { call: null, async: false };
  }
  if (Node.isParenthesizedExpression(node)) {
    return unwrapCall(node.getExpression());
  }
  if (Node.isCallExpression(node)) {
    return { call: node, async: false };
  }
  return { call: null, async: false };
}
