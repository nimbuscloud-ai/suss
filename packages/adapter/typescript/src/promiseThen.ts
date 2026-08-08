// promiseThen.ts: the `derivedFrom` link for Promise `.then` / `.catch`
// callback parameters.
//
// ECMAScript defines what `Promise.prototype.then` resolves to, so this
// binding lives in the adapter (docs/architecture.md, "Adapter vs pack
// ownership"). In `expr.then(cb)` the first parameter of `cb` is the
// resolved value of `expr`. The proposal
// (docs/internal/proposals/adapter-ecmascript-spec.md) describes a
// `derivedFrom: { kind: "promise.then", upstream }` annotation that
// multiple consumers follow. This module materializes that link once so
// both consumers read the same structural facts:
//
//   - the condition-subject resolver (`resolveSubject` in subjects.ts),
//     which resolves a parameter's value to the upstream expression;
//   - the client field-access collector (`collectClientFieldAccesses` in
//     shapes/fieldAccesses.ts), which follows the parsed body's shape
//     through a `.then(res => res.json()).then(data => use(data))` chain.
//
// Strict by default (proposal D5): bind only when the receiver is
// `Promise`-typed per the TypeScript checker. A custom thenable declines.

import {
  type CallExpression,
  type Expression,
  Node,
  type ParameterDeclaration,
} from "ts-morph";

/**
 * The link from a `.then` / `.catch` callback parameter to the value
 * it stands in for: the resolved value of `upstream`. `method` selects
 * `.then` (resolved value) versus `.catch` (rejected value, opaque).
 */
export interface ThenParameterLink {
  kind: "promise.then";
  method: "then" | "catch";
  /** The receiver whose resolved value this parameter binds to. */
  upstream: Expression;
}

/**
 * If `call` is `expr.then(...)` / `expr.catch(...)`, return the method
 * and the receiver `expr`. Null for any other call shape.
 */
export function thenLikeCall(
  call: CallExpression,
): { method: "then" | "catch"; receiver: Expression } | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const name = callee.getName();
  if (name !== "then" && name !== "catch") {
    return null;
  }
  return { method: name, receiver: callee.getExpression() };
}

/**
 * Whether `receiver` is `Promise`-typed per the TypeScript checker. This
 * is the strict gate (proposal D5): a custom thenable with a `then`
 * method that is not a `Promise<T>` returns false, and the parameter
 * resolves as an ordinary input rather than a bound resolved value.
 */
export function receiverIsPromiseTyped(receiver: Expression): boolean {
  let type: ReturnType<Expression["getType"]>;
  try {
    type = receiver.getType();
  } catch {
    return false;
  }
  const symbolName = (type.getSymbol() ?? type.getAliasSymbol())?.getName();
  if (symbolName === "Promise") {
    return true;
  }
  const text = type.getText();
  return text === "Promise" || text.startsWith("Promise<");
}

/**
 * The expression a callback resolves to: its expression body, or the
 * argument of a single trailing `return` in a block body. Null when the
 * callback isn't a resolvable function or its return can't be pinned to
 * one expression.
 */
export function callbackReturnExpression(
  node: Node | undefined,
): Expression | null {
  if (
    node === undefined ||
    !(Node.isArrowFunction(node) || Node.isFunctionExpression(node))
  ) {
    return null;
  }
  const body = node.getBody();
  if (body === undefined) {
    return null;
  }
  if (!Node.isBlock(body)) {
    // Expression-body arrow: the body IS the resolved value.
    return body as Expression;
  }
  const returns = body.getStatements().filter(Node.isReturnStatement);
  if (returns.length !== 1) {
    return null;
  }
  return returns[0].getExpression() ?? null;
}

/**
 * The `derivedFrom` link for `decl` when it is the first parameter of a
 * `.then` / `.catch` callback whose receiver is `Promise`-typed. Null
 * when `decl` isn't such a binding: the parameter is then an ordinary
 * unit input.
 */
export function thenParameterLink(
  decl: ParameterDeclaration,
): ThenParameterLink | null {
  const fn = decl.getParent();
  if (
    fn === undefined ||
    !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))
  ) {
    return null;
  }
  if (fn.getParameters()[0] !== decl) {
    return null;
  }
  const call = fn.getParent();
  if (call === undefined || !Node.isCallExpression(call)) {
    return null;
  }
  if (call.getArguments()[0] !== fn) {
    return null;
  }
  const chained = thenLikeCall(call);
  if (chained === null || !receiverIsPromiseTyped(chained.receiver)) {
    return null;
  }
  return {
    kind: "promise.then",
    method: chained.method,
    upstream: chained.receiver,
  };
}
