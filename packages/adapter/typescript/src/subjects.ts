// subjects.ts: ValueRef resolution from ts-morph Expression nodes (Task 2.2)

import { type Expression, Node, type ParameterDeclaration } from "ts-morph";

import {
  callbackReturnExpression,
  thenLikeCall,
  thenParameterLink,
} from "./promiseThen.js";

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
// The structural `derivedFrom` link (which parameter binds to which
// upstream expression) lives in `promiseThen.ts` and is shared with the
// client field-access collector. This module owns the value side:
// turning the upstream expression into a resolved `ValueRef`. `.catch`
// binds the parameter to the rejected value, which is opaque, so it
// degrades to `unresolved`.
// ---------------------------------------------------------------------------

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
 * When `decl` has a `.then` / `.catch` `derivedFrom` link, resolve it
 * to the upstream resolved value. Null when the parameter isn't such a
 * binding: the caller then treats it as an ordinary unit input.
 */
function resolveThenParameter(
  decl: ParameterDeclaration,
  depth: number,
): ValueRef | null {
  const link = thenParameterLink(decl);
  if (link === null) {
    return null;
  }
  // `.catch(err => ...)` binds to the rejected value: opaque.
  if (link.method === "catch") {
    return { type: "unresolved", sourceText: decl.getName() };
  }
  return resolvePromiseValue(link.upstream, depth + 1);
}

/**
 * Resolve a ts-morph Expression node to a structured ValueRef.
 * Uses only expr.getSymbol()?.getDeclarations()[0] for symbol lookup ,
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

  if (Node.isParenthesizedExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  if (Node.isAwaitExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  if (Node.isAsExpression(expr)) {
    return resolveSubject(expr.getExpression(), depth + 1);
  }

  if (Node.isNullLiteral(expr)) {
    return { type: "literal", value: null };
  }

  if (Node.isTrueLiteral(expr)) {
    return { type: "literal", value: true };
  }

  if (Node.isFalseLiteral(expr)) {
    return { type: "literal", value: false };
  }

  if (Node.isNumericLiteral(expr)) {
    return { type: "literal", value: Number(expr.getLiteralValue()) };
  }

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
  // The index must be a *value*, not source text: `obj["role"]` and
  // `obj[roleVar]` would otherwise both encode as the same string and a
  // dynamic access would masquerade as a static property read: a
  // fabricated condition (extraction-algorithm.md, correctness
  // principle #2). Resolve the index expression; concretize only when
  // it lands on a string/number literal (directly or through a const
  // chain), and mark the whole access unresolved otherwise.
  if (Node.isElementAccessExpression(expr)) {
    const argExpr = expr.getArgumentExpression();
    const indexRef =
      argExpr !== undefined ? resolveSubject(argExpr, depth + 1) : null;
    if (
      indexRef !== null &&
      indexRef.type === "literal" &&
      (typeof indexRef.value === "string" || typeof indexRef.value === "number")
    ) {
      return {
        type: "derived",
        from: resolveSubject(expr.getExpression(), depth + 1),
        derivation: { type: "indexAccess", index: indexRef.value },
      };
    }
    return { type: "unresolved", sourceText };
  }

  // Identifier: the core case with symbol resolution
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

    // BindingElement: `const { user } = expr`: the declaration IS the binding element.
    // Navigate to the parent VariableDeclaration's initializer for the RHS.
    if (Node.isBindingElement(decl)) {
      const bindingName = decl.getName();
      const objectPattern = decl.getParent();
      if (Node.isObjectBindingPattern(objectPattern)) {
        // Destructured *parameter* (`function C({ user }: Props)`): the
        // binding is an input, same as a plain parameter. Input mappings
        // that destructure (React componentProps, react-router
        // singleObjectParam) emit one Input per destructured name, so
        // `input(name)` is the encoding that lines up with the summary's
        // inputs table; `unresolved` here made every prop-gated condition
        // opaque to downstream consumers.
        const patternParent = objectPattern.getParent();
        if (Node.isParameterDeclaration(patternParent)) {
          return { type: "input", inputRef: bindingName, path: [] };
        }
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
