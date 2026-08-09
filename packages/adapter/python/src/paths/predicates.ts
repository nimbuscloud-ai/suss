// predicates.ts: what a condition expression says, as a Predicate.
// The checker reads a transition's conditions to tell a status test from an
// ordinary one, so a condition left opaque takes no part in that.

import { field } from "../ast.js";

import type { ComparisonOp, Predicate, ValueRef } from "@suss/behavioral-ir";
import type { PyNode } from "../parser.js";

/** Python's own spelling of each operator the IR models. */
const COMPARISONS: Record<string, ComparisonOp> = {
  "==": "eq",
  "!=": "neq",
  "<>": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

/** The operator a comparison writes, which comes between its two operands. */
function operatorText(node: PyNode): string {
  return node.children
    .filter((child) => child !== null && !child.isNamed)
    .map((child) => child.text)
    .join(" ");
}

/** A literal the IR can carry, or the expression as written. */
function valueRefOf(node: PyNode): ValueRef {
  if (node.type === "string") {
    return { type: "literal", value: node.text.slice(1, -1) };
  }
  if (node.type === "integer") {
    const value = Number.parseInt(node.text, 10);
    if (!Number.isNaN(value)) {
      return { type: "literal", value };
    }
  }
  if (node.type === "true" || node.type === "false") {
    return { type: "literal", value: node.type === "true" };
  }

  return { type: "unresolved", sourceText: node.text };
}

const opaqueOf = (node: PyNode): Predicate => ({
  type: "opaque",
  sourceText: node.text,
  reason: "complexExpression",
});

/** `x is None` and `x is not None`, which is how Python asks about null. */
function nullCheckOf(subject: PyNode, negated: boolean): Predicate {
  return { type: "nullCheck", subject: valueRefOf(subject), negated };
}

function comparisonOf(node: PyNode): Predicate {
  const [left, right] = node.namedChildren.filter(
    (child): child is PyNode => child !== null,
  );
  if (left === undefined || right === undefined) {
    return opaqueOf(node);
  }

  const operator = operatorText(node);
  if (operator === "is" && right.type === "none") {
    return nullCheckOf(left, false);
  }
  if (operator === "is not" && right.type === "none") {
    return nullCheckOf(left, true);
  }
  if (operator === "is" && left.type === "none") {
    return nullCheckOf(right, false);
  }

  const op = COMPARISONS[operator];
  if (op === undefined) {
    return opaqueOf(node);
  }

  return {
    type: "comparison",
    left: valueRefOf(left),
    op,
    right: valueRefOf(right),
  };
}

/**
 * What a condition expression says. Anything this does not model stays
 * opaque with its own source text, which is what every Python condition was
 * before.
 */
export function predicateOf(node: PyNode): Predicate {
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner == null ? opaqueOf(node) : predicateOf(inner);
  }

  if (node.type === "comparison_operator") {
    return comparisonOf(node);
  }

  if (node.type === "not_operator") {
    const operand = field(node, "argument") ?? node.namedChildren[0];
    return operand == null
      ? opaqueOf(node)
      : { type: "negation", operand: predicateOf(operand) };
  }

  if (node.type === "identifier" || node.type === "attribute") {
    return {
      type: "truthinessCheck",
      subject: valueRefOf(node),
      negated: false,
    };
  }

  return opaqueOf(node);
}
