// subjects.ts — ValueRef resolution from ts-morph Expression nodes (Task 2.2)

import { type Expression, Node } from "ts-morph";

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

    // Parameter declaration → input
    if (Node.isParameterDeclaration(decl)) {
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
