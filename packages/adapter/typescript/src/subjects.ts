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

/**
 * Resolve a ts-morph Expression node to a structured ValueRef.
 * Uses only expr.getSymbol()?.getDeclarations()[0] for symbol lookup —
 * never findReferencesAsNodes() which is project-wide and quadratic.
 */
export function resolveSubject(expr: Expression): ValueRef {
  const sourceText = expr.getText();

  // Strip parentheses — recurse into inner expression
  if (Node.isParenthesizedExpression(expr)) {
    return resolveSubject(expr.getExpression());
  }

  // Strip await — recurse into inner expression
  if (Node.isAwaitExpression(expr)) {
    return resolveSubject(expr.getExpression());
  }

  // Strip as-expression (type cast) — recurse into inner expression
  if (Node.isAsExpression(expr)) {
    return resolveSubject(expr.getExpression());
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
      from: resolveSubject(expr.getExpression()),
      derivation: { type: "propertyAccess", property: expr.getName() },
    };
  }

  // ElementAccessExpression: obj[key] → derived(resolveSubject(obj), indexAccess(key))
  if (Node.isElementAccessExpression(expr)) {
    return {
      type: "derived",
      from: resolveSubject(expr.getExpression()),
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

      return { type: "unresolved", sourceText };
    }

    return { type: "unresolved", sourceText };
  }

  return { type: "unresolved", sourceText };
}
