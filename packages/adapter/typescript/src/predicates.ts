// predicates.ts — Predicate parsing from ts-morph Expression nodes (Task 2.2)

import { type Expression, Node, SyntaxKind } from "ts-morph";

import { resolveSubject } from "./subjects.js";

import type { ComparisonOp, Predicate, ValueRef } from "@suss/behavioral-ir";

// Operators that check for null/undefined equality
const NULL_CHECK_OPS = new Set(["===", "!==", "==", "!="]);

function toComparisonOp(opText: string): ComparisonOp | null {
  switch (opText) {
    case "===":
    case "==":
      return "eq";
    case "!==":
    case "!=":
      return "neq";
    case ">":
      return "gt";
    case ">=":
      return "gte";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    default:
      return null;
  }
}

function isNullOrUndefined(expr: Expression): boolean {
  if (Node.isNullLiteral(expr)) {
    return true;
  }
  if (Node.isIdentifier(expr) && expr.getText() === "undefined") {
    return true;
  }
  return false;
}

function wrapOpaque(
  predicate: Predicate | null,
  sourceText: string,
): Predicate {
  if (predicate !== null) {
    return predicate;
  }
  return { type: "opaque", sourceText, reason: "complexExpression" };
}

/**
 * Parse a ts-morph Expression into a structured Predicate.
 * Returns null when the expression can't be decomposed cleanly.
 * The caller wraps null into { type: "opaque", sourceText, reason: "complexExpression" }.
 */
export function parseConditionExpression(expr: Expression): Predicate | null {
  // ParenthesizedExpression: strip parentheses and recurse
  if (Node.isParenthesizedExpression(expr)) {
    return parseConditionExpression(expr.getExpression());
  }

  // PrefixUnaryExpression: handles `!x` and `!!x`
  if (Node.isPrefixUnaryExpression(expr)) {
    if (expr.getOperatorToken() !== SyntaxKind.ExclamationToken) {
      return null;
    }
    const operand = expr.getOperand();
    const inner = parseConditionExpression(operand);

    if (inner === null) {
      return {
        type: "negation",
        operand: {
          type: "opaque",
          sourceText: operand.getText(),
          reason: "complexExpression",
        },
      };
    }

    // If inner is a truthinessCheck, flip negated
    if (inner.type === "truthinessCheck") {
      return { ...inner, negated: !inner.negated };
    }

    // If inner is a nullCheck, flip negated
    if (inner.type === "nullCheck") {
      return { ...inner, negated: !inner.negated };
    }

    // Otherwise wrap in a negation node
    return { type: "negation", operand: inner };
  }

  // BinaryExpression
  if (Node.isBinaryExpression(expr)) {
    const left = expr.getLeft();
    const right = expr.getRight();
    const opToken = expr.getOperatorToken();
    const opText = opToken.getText();

    // Logical AND
    if (opToken.getKind() === SyntaxKind.AmpersandAmpersandToken) {
      const leftPred = parseConditionExpression(left);
      const rightPred = parseConditionExpression(right);
      return {
        type: "compound",
        op: "and",
        operands: [
          wrapOpaque(leftPred, left.getText()),
          wrapOpaque(rightPred, right.getText()),
        ],
      };
    }

    // Logical OR
    if (opToken.getKind() === SyntaxKind.BarBarToken) {
      const leftPred = parseConditionExpression(left);
      const rightPred = parseConditionExpression(right);
      return {
        type: "compound",
        op: "or",
        operands: [
          wrapOpaque(leftPred, left.getText()),
          wrapOpaque(rightPred, right.getText()),
        ],
      };
    }

    // Comparison / null-check operators
    const op = toComparisonOp(opText);
    if (op !== null) {
      // Null/undefined check detection for ==, !=, ===, !==
      if (NULL_CHECK_OPS.has(opText)) {
        const leftIsNull = isNullOrUndefined(left);
        const rightIsNull = isNullOrUndefined(right);

        if (leftIsNull || rightIsNull) {
          const subject = resolveSubject(leftIsNull ? right : left);
          // negated: true means "is NOT null" (neq)
          const negated = op === "neq";
          return { type: "nullCheck", subject, negated };
        }
      }

      // typeof check: typeof x === "string"
      if (
        Node.isTypeOfExpression(left) &&
        Node.isStringLiteral(right) &&
        (opText === "===" || opText === "==")
      ) {
        const subject = resolveSubject(left.getExpression());
        return {
          type: "typeCheck",
          subject,
          expectedType: right.getLiteralValue(),
        };
      }
      if (
        Node.isTypeOfExpression(right) &&
        Node.isStringLiteral(left) &&
        (opText === "===" || opText === "==")
      ) {
        const subject = resolveSubject(right.getExpression());
        return {
          type: "typeCheck",
          subject,
          expectedType: left.getLiteralValue(),
        };
      }

      // Regular comparison
      const leftRef: ValueRef = resolveSubject(left);
      const rightRef: ValueRef = resolveSubject(right);
      return { type: "comparison", left: leftRef, op, right: rightRef };
    }

    return null;
  }

  // CallExpression: isActive(user)
  if (Node.isCallExpression(expr)) {
    const args: ValueRef[] = expr
      .getArguments()
      .map((arg) => resolveSubject(arg as Expression));
    return {
      type: "call",
      callee: expr.getExpression().getText(),
      args,
    };
  }

  // Identifier → truthinessCheck
  if (Node.isIdentifier(expr)) {
    return {
      type: "truthinessCheck",
      subject: resolveSubject(expr),
      negated: false,
    };
  }

  // PropertyAccessExpression → truthinessCheck
  if (Node.isPropertyAccessExpression(expr)) {
    return {
      type: "truthinessCheck",
      subject: resolveSubject(expr),
      negated: false,
    };
  }

  // ElementAccessExpression → truthinessCheck
  if (Node.isElementAccessExpression(expr)) {
    return {
      type: "truthinessCheck",
      subject: resolveSubject(expr),
      negated: false,
    };
  }

  // TypeOfExpression on its own (not in a binary comparison) — return null
  if (Node.isTypeOfExpression(expr)) {
    return null;
  }

  return null;
}
