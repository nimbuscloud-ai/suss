// predicates.ts — Predicate parsing from ts-morph Expression nodes (Task 2.2)

import { type Expression, Node, SyntaxKind } from "ts-morph";

import { resolveCallableBody } from "./astResolve.js";
import { resolveSubject } from "./subjects.js";

import type { ComparisonOp, Predicate, ValueRef } from "@suss/behavioral-ir";

const MAX_INLINE_DEPTH = 4;

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
 *
 * Call expressions are resolved recursively: if the callee is a local
 * function with a single-expression body, the body is parsed as a
 * predicate and parameter references are substituted with the call-site
 * arguments. This reduces opaqueness for patterns like `if (isActive(user))`.
 */
export function parseConditionExpression(
  expr: Expression,
  depth = 0,
): Predicate | null {
  // ParenthesizedExpression: strip parentheses and recurse
  if (Node.isParenthesizedExpression(expr)) {
    return parseConditionExpression(expr.getExpression(), depth);
  }

  // PrefixUnaryExpression: handles `!x` and `!!x`
  if (Node.isPrefixUnaryExpression(expr)) {
    if (expr.getOperatorToken() !== SyntaxKind.ExclamationToken) {
      return null;
    }
    const operand = expr.getOperand();
    const inner = parseConditionExpression(operand, depth);

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
      const leftPred = parseConditionExpression(left, depth);
      const rightPred = parseConditionExpression(right, depth);
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
      const leftPred = parseConditionExpression(left, depth);
      const rightPred = parseConditionExpression(right, depth);
      return {
        type: "compound",
        op: "or",
        operands: [
          wrapOpaque(leftPred, left.getText()),
          wrapOpaque(rightPred, right.getText()),
        ],
      };
    }

    // instanceof: error instanceof HttpError → typeCheck
    if (opToken.getKind() === SyntaxKind.InstanceOfKeyword) {
      const subject = resolveSubject(left);
      return { type: "typeCheck", subject, expectedType: right.getText() };
    }

    // in: "email" in body → propertyExists
    if (opToken.getKind() === SyntaxKind.InKeyword) {
      if (Node.isStringLiteral(left)) {
        const subject = resolveSubject(right);
        return {
          type: "propertyExists",
          subject,
          property: left.getLiteralValue(),
          negated: false,
        };
      }
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

  // CallExpression: isActive(user) — try to inline, fall back to opaque
  if (Node.isCallExpression(expr)) {
    // Array.includes() expansion: [200, 201].includes(x) → x === 200 || x === 201
    const includesResult = tryExpandArrayIncludes(expr);
    if (includesResult !== null) {
      return includesResult;
    }

    if (depth < MAX_INLINE_DEPTH) {
      const inlined = tryInlineCallPredicate(expr, depth);
      if (inlined !== null) {
        return inlined;
      }
    }
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

// ---------------------------------------------------------------------------
// Array.includes() expansion
// ---------------------------------------------------------------------------

/**
 * Expand `[lit1, lit2, ...].includes(x)` into a compound OR of equalities.
 * Only works when the receiver is an array literal with all-literal elements.
 *
 * Example: `[200, 201, 204].includes(status)` →
 *   `status === 200 || status === 201 || status === 204`
 */
function tryExpandArrayIncludes(
  call: import("ts-morph").CallExpression,
): Predicate | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  if (callee.getName() !== "includes") {
    return null;
  }

  const receiver = callee.getExpression();
  if (!Node.isArrayLiteralExpression(receiver)) {
    return null;
  }

  const callArgs = call.getArguments();
  if (callArgs.length !== 1) {
    return null;
  }

  const elements = receiver.getElements();
  if (elements.length === 0) {
    return null;
  }

  // All elements must be literals
  const literalValues: ValueRef[] = [];
  for (const el of elements) {
    const ref = resolveSubject(el as Expression);
    if (ref.type !== "literal") {
      return null;
    }
    literalValues.push(ref);
  }

  const subject = resolveSubject(callArgs[0] as Expression);

  if (literalValues.length === 1) {
    return {
      type: "comparison",
      left: subject,
      op: "eq",
      right: literalValues[0],
    };
  }

  return {
    type: "compound",
    op: "or",
    operands: literalValues.map((lit) => ({
      type: "comparison" as const,
      left: subject,
      op: "eq" as const,
      right: lit,
    })),
  };
}

// ---------------------------------------------------------------------------
// Call predicate inlining
// ---------------------------------------------------------------------------

/**
 * Try to inline a call expression used as a condition.
 * If the callee is a local function with a single-expression body,
 * parse the body as a predicate and substitute parameter references
 * with the call-site argument values.
 *
 * Example: `isActive(user)` where `isActive = (u) => !u.deletedAt`
 * → `truthinessCheck(derived(resolveSubject(user), propertyAccess("deletedAt")), negated: true)`
 */
function tryInlineCallPredicate(
  call: import("ts-morph").CallExpression,
  depth: number,
): Predicate | null {
  const callee = call.getExpression();
  const resolved = resolveCallableBody(callee);
  if (resolved === null) {
    return null;
  }

  const { bodyExpr, paramNames } = resolved;
  if (!Node.isExpression(bodyExpr)) {
    return null;
  }

  // Parse the body expression as a predicate (in the callee's scope)
  const bodyPred = parseConditionExpression(bodyExpr as Expression, depth + 1);
  if (bodyPred === null) {
    return null;
  }

  // Build substitution map: param name → argument ValueRef
  const callArgs = call.getArguments();
  const subs = new Map<string, ValueRef>();
  for (let i = 0; i < paramNames.length && i < callArgs.length; i++) {
    subs.set(paramNames[i], resolveSubject(callArgs[i] as Expression));
  }

  if (subs.size === 0) {
    return bodyPred; // No params to substitute
  }

  return substitutePredicate(bodyPred, subs);
}

// ---------------------------------------------------------------------------
// Parameter substitution
// ---------------------------------------------------------------------------

function substitutePredicate(
  pred: Predicate,
  subs: Map<string, ValueRef>,
): Predicate {
  switch (pred.type) {
    case "truthinessCheck":
      return {
        ...pred,
        subject: substituteValueRef(pred.subject, subs),
      };
    case "nullCheck":
      return {
        ...pred,
        subject: substituteValueRef(pred.subject, subs),
      };
    case "comparison":
      return {
        ...pred,
        left: substituteValueRef(pred.left, subs),
        right: substituteValueRef(pred.right, subs),
      };
    case "typeCheck":
      return {
        ...pred,
        subject: substituteValueRef(pred.subject, subs),
      };
    case "propertyExists":
      return {
        ...pred,
        subject: substituteValueRef(pred.subject, subs),
      };
    case "negation":
      return {
        ...pred,
        operand: substitutePredicate(pred.operand, subs),
      };
    case "compound":
      return {
        ...pred,
        operands: pred.operands.map((op) => substitutePredicate(op, subs)),
      };
    case "call":
      return {
        ...pred,
        args: pred.args.map((arg) => substituteValueRef(arg, subs)),
      };
    case "opaque":
      return pred; // Can't substitute into opaque source text
  }
}

function substituteValueRef(
  ref: ValueRef,
  subs: Map<string, ValueRef>,
): ValueRef {
  switch (ref.type) {
    case "input": {
      const sub = subs.get(ref.inputRef);
      if (sub === undefined) {
        return ref;
      }
      // If the input has a path, chain property accesses onto the substituted value
      let result = sub;
      for (const segment of ref.path) {
        result = {
          type: "derived",
          from: result,
          derivation: { type: "propertyAccess", property: segment },
        };
      }
      return result;
    }
    case "derived":
      return {
        ...ref,
        from: substituteValueRef(ref.from, subs),
      };
    default:
      return ref;
  }
}
