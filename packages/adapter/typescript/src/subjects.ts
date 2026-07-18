// subjects.ts — ValueRef resolution from ts-morph Expression nodes (Task 2.2)

import {
  type CallExpression,
  type Expression,
  Node,
  type ParameterDeclaration,
} from "ts-morph";

import type { ValueRef } from "@suss/behavioral-ir";

/**
 * Unwrap an initializer expression (stripping await) to extract a dependency
 * ValueRef when the initializer is a call expression. Returns null otherwise.
 */
function resolveCallInitializer(init: Expression): ValueRef | null {
  const callExpr = Node.isAwaitExpression(init) ? init.getExpression() : init;
  if (Node.isCallExpression(callExpr)) {
    return {
      type: "dependency",
      name: callExpr.getExpression().getText(),
      accessChain: [],
    };
  }
  return null;
}

const MAX_RESOLVE_DEPTH = 8;

// ---------------------------------------------------------------------------
// Promise `.then` / `.catch` parameter binding
//
// ECMAScript defines what `Promise.prototype.then` resolves to, so this
// binding lives in the adapter (docs/architecture.md, "Adapter vs pack
// ownership"). In `expr.then(cb)` the first parameter of `cb` is the
// resolved value of `expr`; resolving that parameter as a subject
// follows the chain back to the upstream expression's value rather than
// treating it as a unit input.
//
//   fetch(url).then(res => { if (!res.ok) ... })
//     → res resolves to the result of `fetch` (dependency)
//   fetch(url).then(res => res.json()).then(data => use(data))
//     → data resolves to the result of `res.json()` (dependency)
//
// Strict by default: bind only when the receiver is `Promise`-typed per
// the TypeScript checker (proposal open question — start strict, loosen
// if useful cases are missed). `.catch` binds the parameter to the
// rejected value, which is opaque, so it degrades to `unresolved`.
// ---------------------------------------------------------------------------

/**
 * If `call` is `expr.then(...)` / `expr.catch(...)`, return the method
 * and the receiver `expr`. Null for any other call shape.
 */
function thenLikeCall(
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

function receiverIsPromiseTyped(receiver: Expression): boolean {
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
 * The expression a callback resolves to — its expression body, or the
 * argument of a single trailing `return` in a block body. Null when the
 * callback isn't a resolvable function or its return can't be pinned to
 * one expression.
 */
function callbackReturnExpression(
  node: Expression | undefined,
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
 * The resolved value of a promise-producing expression. A plain call
 * resolves to its result (a dependency); a chained `.then` resolves to
 * its callback's return value, recursively.
 */
function resolvePromiseValue(expr: Expression, depth: number): ValueRef {
  if (depth >= MAX_RESOLVE_DEPTH) {
    return { type: "unresolved", sourceText: expr.getText() };
  }
  const inner = Node.isAwaitExpression(expr)
    ? expr.getExpression()
    : Node.isParenthesizedExpression(expr)
      ? expr.getExpression()
      : expr;

  if (Node.isCallExpression(inner)) {
    const chained = thenLikeCall(inner);
    if (chained !== null && chained.method === "then") {
      const ret = callbackReturnExpression(
        inner.getArguments()[0] as Expression | undefined,
      );
      if (ret !== null) {
        return resolvePromiseValue(ret, depth + 1);
      }
      return { type: "unresolved", sourceText: inner.getText() };
    }
    return {
      type: "dependency",
      name: inner.getExpression().getText(),
      accessChain: [],
    };
  }
  return resolveSubject(inner, depth + 1);
}

/**
 * When `decl` is the first parameter of a `.then` / `.catch` callback
 * whose receiver is `Promise`-typed, resolve it to the upstream resolved
 * value. Null when the parameter isn't such a binding.
 */
function resolveThenParameter(
  decl: ParameterDeclaration,
  depth: number,
): ValueRef | null {
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
  // `.catch(err => ...)` binds to the rejected value — opaque.
  if (chained.method === "catch") {
    return { type: "unresolved", sourceText: decl.getName() };
  }
  return resolvePromiseValue(chained.receiver, depth + 1);
}

/**
 * Resolve a ts-morph Expression node to a structured ValueRef.
 * Uses only expr.getSymbol()?.getDeclarations()[0] for symbol lookup —
 * never findReferencesAsNodes() which is project-wide and quadratic.
 *
 * Follows intermediate variable assignments (const data = result.body)
 * so that property chains through temporaries resolve to their origin.
 * Depth-bounded to prevent infinite recursion on cyclic references.
 */
export function resolveSubject(expr: Expression, depth = 0): ValueRef {
  if (depth >= MAX_RESOLVE_DEPTH) {
    return { type: "unresolved", sourceText: expr.getText() };
  }
  const sourceText = expr.getText();

  // Strip parentheses — recurse into inner expression
  if (Node.isParenthesizedExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  // Strip await — recurse into inner expression
  if (Node.isAwaitExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  // Strip as-expression (type cast) — recurse into inner expression
  if (Node.isAsExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  // Literal: null keyword
  if (Node.isNullLiteral(expr)) {
    return { type: "literal", value: null };
  }

  // Literal: true
  if (Node.isTrueLiteral(expr)) {
    return { type: "literal", value: true };
  }

  // Literal: false
  if (Node.isFalseLiteral(expr)) {
    return { type: "literal", value: false };
  }

  // Literal: numeric
  if (Node.isNumericLiteral(expr)) {
    return { type: "literal", value: Number(expr.getLiteralValue()) };
  }

  // Literal: string
  if (Node.isStringLiteral(expr)) {
    return { type: "literal", value: expr.getLiteralValue() };
  }

  // PropertyAccessExpression: obj.prop → derived(resolveSubject(obj), propertyAccess(prop))
  if (Node.isPropertyAccessExpression(expr)) {
    return {
      type: "derived",
      from: resolveSubject(expr.getExpression(), depth + 1),
      derivation: { type: "propertyAccess", property: expr.getName() },
    };
  }

  // ElementAccessExpression: obj[key] → derived(resolveSubject(obj), indexAccess(key))
  if (Node.isElementAccessExpression(expr)) {
    return {
      type: "derived",
      from: resolveSubject(expr.getExpression(), depth + 1),
      derivation: {
        type: "indexAccess",
        index: expr.getArgumentExpression()?.getText() ?? "?",
      },
    };
  }

  // Identifier — the core case with symbol resolution
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();

    // Treat `undefined` identifier as null-ish literal
    if (name === "undefined") {
      return { type: "literal", value: null };
    }

    const symbol = expr.getSymbol();
    if (symbol === undefined) {
      return { type: "unresolved", sourceText };
    }

    const decl = symbol.getDeclarations()[0];
    if (decl === undefined) {
      return { type: "unresolved", sourceText };
    }

    // Parameter declaration → input, unless it's the resolved-value
    // parameter of a Promise `.then` / `.catch` callback, in which case
    // it binds to the upstream expression's value.
    if (Node.isParameterDeclaration(decl)) {
      const thenBinding = resolveThenParameter(decl, depth);
      if (thenBinding !== null) {
        return thenBinding;
      }
      return { type: "input", inputRef: decl.getName(), path: [] };
    }

    // BindingElement: `const { user } = expr` — the declaration IS the binding element.
    // Navigate to the parent VariableDeclaration's initializer for the RHS.
    if (Node.isBindingElement(decl)) {
      const bindingName = decl.getName();
      const objectPattern = decl.getParent();
      if (Node.isObjectBindingPattern(objectPattern)) {
        const varDecl = objectPattern.getParent();
        if (Node.isVariableDeclaration(varDecl)) {
          const init = varDecl.getInitializer();
          if (init !== undefined) {
            const dep = resolveCallInitializer(init);
            if (dep !== null) {
              return {
                type: "derived",
                from: dep,
                derivation: { type: "destructured", field: bindingName },
              };
            }
            // Follow through non-call initializers for binding elements too
            if (Node.isExpression(init)) {
              const resolved = resolveSubject(init, depth + 1);
              if (resolved.type !== "unresolved") {
                return {
                  type: "derived",
                  from: resolved,
                  derivation: { type: "destructured", field: bindingName },
                };
              }
            }
          }
        }
      }
      return { type: "unresolved", sourceText };
    }

    // Variable declaration (handles VariableDeclaration from const/let/var)
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init === undefined) {
        return { type: "unresolved", sourceText };
      }

      const dep = resolveCallInitializer(init);
      if (dep !== null) {
        return dep;
      }

      // Follow through intermediate assignments:
      //   const data = result.body  → resolveSubject(result.body)
      //   const x = y               → resolveSubject(y)
      //   const d = await promise    → resolveSubject(promise)
      if (Node.isExpression(init)) {
        const resolved = resolveSubject(init, depth + 1);
        if (resolved.type !== "unresolved") {
          return resolved;
        }
      }

      return { type: "unresolved", sourceText };
    }

    return { type: "unresolved", sourceText };
  }

  return { type: "unresolved", sourceText };
}
