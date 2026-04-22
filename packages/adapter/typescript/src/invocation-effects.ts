// invocation-effects.ts — Capture call expressions as `invocation`
// RawEffects. Two patterns covered:
//
//   1. Bare expression-statement calls — `setCount(n);`,
//      `onChange(value);`, `emitter.emit("x", y);`. Result is
//      discarded; the call fires for side effect.
//   2. Container-building calls — `return [...checkProviderCoverage(p, c),
//      ...checkConsumerSatisfaction(p, c)]` and similar. The call's
//      return value is composed into an array or object literal;
//      the call still *fires* when the container expression
//      evaluates. Without this, orchestrator functions that
//      compose sub-checks via spread show `effects: []` and the
//      graph has no edges through them.
//
// Scope:
//   * Skip nested function bodies — their calls belong to those
//     functions' summaries.
//   * Don't classify semantics. All captured calls become
//     `invocation` effects with the callee's source text.
//   * Async detection via `Node.isAwaitExpression` on the call.

import { type CallExpression, Node } from "ts-morph";

import type { EffectArg, RawEffect } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

export interface InvocationEffectLocation {
  effect: RawEffect;
  /**
   * Start line of the containing statement (expression statement or
   * the statement enclosing a container-building call). Used by the
   * assembly pass to assign effects to the right branch.
   */
  line: number;
  /**
   * True when the effect is a container-building call (spread or
   * direct element in an array/object literal) rather than an
   * expression-statement call. Container calls are never themselves
   * terminals, so the assembly-level terminal-line dedup must skip
   * them — otherwise single-line orchestrators lose their effects.
   */
  neverTerminal: boolean;
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

    // Case 1: bare expression statement — `foo();`, `await foo();`.
    if (Node.isExpressionStatement(node)) {
      const { call, async } = unwrapCall(node.getExpression());
      if (call !== null) {
        results.push({
          effect: {
            type: "invocation",
            callee: call.getExpression().getText(),
            args: extractArgs(call),
            async,
          },
          line: node.getStartLineNumber(),
          neverTerminal: false,
        });
      }
      return;
    }

    // Case 2: spread-element call in an array/object literal —
    // `[...foo()]`, `{...foo()}`. The spread could be inside a
    // return, a variable declaration, a function argument — in
    // each case the call still fires when the container is built.
    if (Node.isSpreadElement(node)) {
      const parent = node.getParent();
      if (
        parent !== undefined &&
        (Node.isArrayLiteralExpression(parent) ||
          Node.isObjectLiteralExpression(parent))
      ) {
        const { call, async } = unwrapCall(node.getExpression());
        if (call !== null) {
          results.push({
            effect: {
              type: "invocation",
              callee: call.getExpression().getText(),
              args: extractArgs(call),
              async,
            },
            line: enclosingStatementLine(node),
            neverTerminal: true,
          });
        }
      }
      return;
    }

    // Case 3: direct call element in an array literal or property
    // assignment value — `[foo(), bar()]`, `{ key: foo() }`. These
    // also fire when the container evaluates. Skip arguments to
    // other calls (`foo(bar())`) — those are argument positions,
    // not composition positions.
    if (Node.isCallExpression(node)) {
      const parent = node.getParent();
      if (parent === undefined) {
        return;
      }
      const isArrayElement = Node.isArrayLiteralExpression(parent);
      const isPropertyValue =
        Node.isPropertyAssignment(parent) && parent.getInitializer() === node;
      if (isArrayElement || isPropertyValue) {
        results.push({
          effect: {
            type: "invocation",
            callee: node.getExpression().getText(),
            args: extractArgs(node),
            async: false,
          },
          line: enclosingStatementLine(node),
          neverTerminal: true,
        });
      }
    }
  });

  return results;
}

/**
 * Extract structured arguments from a CallExpression. Captures
 * literal values (strings, numbers, booleans) and object literals
 * whose fields resolve to literals. Everything else becomes `null`
 * in the positional slot — the caller retains the argument count
 * but the value is opaque. Recursion is capped at object-of-literals
 * to keep the representation tight.
 */
function extractArgs(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArg(arg, 2));
}

function extractArg(node: Node, depth: number): EffectArg {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "number", value: node.getLiteralValue() };
  }
  if (Node.isTrueLiteral(node)) {
    return { kind: "boolean", value: true };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "boolean", value: false };
  }
  if (depth > 0 && Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      const nameNode = prop.getNameNode();
      if (
        !Node.isIdentifier(nameNode) &&
        !Node.isStringLiteral(nameNode) &&
        !Node.isNoSubstitutionTemplateLiteral(nameNode)
      ) {
        continue;
      }
      const name = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : nameNode.getLiteralValue();
      const initializer = prop.getInitializer();
      if (initializer === undefined) {
        continue;
      }
      const captured = extractArg(initializer, depth - 1);
      if (captured !== null) {
        fields[name] = captured;
      }
    }
    if (Object.keys(fields).length === 0) {
      return null;
    }
    return { kind: "object", fields };
  }
  return null;
}

/**
 * Walk up from a composition-position call to find the enclosing
 * statement line. This is what should be used for branch
 * attribution — the line of the statement that contains the
 * container expression.
 */
function enclosingStatementLine(node: Node): number {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (Node.isStatement(current)) {
      return current.getStartLineNumber();
    }
    current = current.getParent();
  }
  return node.getStartLineNumber();
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
