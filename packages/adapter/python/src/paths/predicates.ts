/**
 * Turns a condition expression into a Predicate.
 *
 * The checker reads a transition's conditions to tell a status test from an
 * ordinary one, and an opaque condition gives it nothing to read. Each side
 * of a comparison goes through the shared value evaluator, so a status
 * written as a named constant comes out as its number.
 */

import { constantOf, literalOf } from "@suss/values";

import { allChildren, children, field } from "../ast.js";
import { evaluatedValue } from "../values/evaluator.js";
import { caseArmOf, patternTestText } from "./caseArms.js";

import type { ComparisonOp, Predicate, ValueRef } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { PyNode } from "../parser.js";
import type { CaseArm, PatternTest } from "./caseArms.js";

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

/** Joined with a space so `is not` and `not in` come out as one operator. */
function operatorText(node: PyNode): string {
  return allChildren(node)
    .filter((child) => !child.isNamed)
    .map((child) => child.text)
    .join(" ");
}

/**
 * The input each operand of a body's conditions reads, by node id, for
 * the operands whose value came from exactly one input. `guardInputs`
 * builds it.
 */
export type GuardInputs = ReadonlyMap<number, ValueRef>;

function valueRefOf(
  node: PyNode,
  facts: Database | undefined,
  inputs: GuardInputs | undefined,
): ValueRef {
  const value = evaluatedValue(node, facts);
  const constant = constantOf(value);
  if (constant !== undefined) {
    return { type: "literal", value: constant };
  }
  const literal = literalOf(value);
  if (literal !== null) {
    return { type: "literal", value: literal };
  }
  const input = inputs?.get(node.id);
  if (input !== undefined) {
    return input;
  }

  const chain = attributeChain(node);
  if (chain !== null) {
    const [name, ...accessChain] = chain;
    if (name !== undefined && accessChain.length > 0) {
      return { type: "dependency", name, accessChain };
    }
  }

  return { type: "unresolved", sourceText: node.text };
}

/**
 * `response.status_code` as the name it starts from and the members read
 * off it. The checker finds a status test by matching those members, so it
 * needs the parts and cannot use the text. Null for anything with a call or
 * a subscript in it, where the value depends on more than the name.
 */
function attributeChain(node: PyNode, tail: string[] = []): string[] | null {
  if (node.type === "identifier") {
    return [node.text, ...tail];
  }
  if (node.type !== "attribute") {
    return null;
  }
  const object = field(node, "object");
  const attribute = field(node, "attribute");
  if (object === null || attribute === null) {
    return null;
  }
  return attributeChain(object, [attribute.text, ...tail]);
}

const opaqueOf = (node: PyNode): Predicate => ({
  type: "opaque",
  sourceText: node.text,
  reason: "complexExpression",
});

/** `x is None` and `x is not None`, which is how Python asks about null. */
function nullCheckOf(
  subject: PyNode,
  negated: boolean,
  facts: Database | undefined,
  inputs: GuardInputs | undefined,
): Predicate {
  return {
    type: "nullCheck",
    subject: valueRefOf(subject, facts, inputs),
    negated,
  };
}

function comparisonOf(
  node: PyNode,
  facts: Database | undefined,
  inputs: GuardInputs | undefined,
): Predicate {
  const [left, right] = children(node).filter(
    (child): child is PyNode => child !== null,
  );
  if (left === undefined || right === undefined) {
    return opaqueOf(node);
  }

  const operator = operatorText(node);
  if (operator === "is" && right.type === "none") {
    return nullCheckOf(left, false, facts, inputs);
  }
  if (operator === "is not" && right.type === "none") {
    return nullCheckOf(left, true, facts, inputs);
  }
  if (operator === "is" && left.type === "none") {
    return nullCheckOf(right, false, facts, inputs);
  }

  const op = COMPARISONS[operator];
  if (op === undefined) {
    return opaqueOf(node);
  }

  return {
    type: "comparison",
    left: valueRefOf(left, facts, inputs),
    op,
    right: valueRefOf(right, facts, inputs),
  };
}

type PatternReading<T> = {
  [K in PatternTest["kind"]]: (
    test: Extract<PatternTest, { kind: K }>,
    facts: Database | undefined,
    inputs: GuardInputs | undefined,
  ) => T;
};

const PATTERN_PREDICATES: PatternReading<Predicate> = {
  equals: (test, facts, inputs) => ({
    type: "comparison",
    left: valueRefOf(test.subject, facts, inputs),
    op: "eq",
    right: valueRefOf(test.pattern, facts, inputs),
  }),
  isNone: (test, facts, inputs) =>
    nullCheckOf(test.subject, false, facts, inputs),
  matches: (test) => ({
    type: "opaque",
    sourceText: patternTestText(test),
    reason: "complexExpression",
  }),
};

/** The values each test's predicate may read an input from, as `operandsOf` gives them for a comparison. */
const PATTERN_OPERANDS: PatternReading<PyNode[]> = {
  equals: (test) =>
    [test.subject, test.pattern].filter((one) => SUBJECT_TYPES.has(one.type)),
  isNone: (test) =>
    SUBJECT_TYPES.has(test.subject.type) ? [test.subject] : [],
  matches: () => [],
};

/** Any one of a case's tests picks it, and its guard must also be true. */
function caseArmPredicate(
  arm: CaseArm,
  facts: Database | undefined,
  inputs: GuardInputs | undefined,
): Predicate {
  const tests = arm.tests.map((test) =>
    (
      PATTERN_PREDICATES[test.kind] as (
        one: PatternTest,
        given: Database | undefined,
        read: GuardInputs | undefined,
      ) => Predicate
    )(test, facts, inputs),
  );
  const guard =
    arm.guard === null ? [] : [predicateOf(arm.guard, facts, inputs)];
  return joined("and", [
    ...(tests.length === 0 ? [] : [joined("or", tests)]),
    ...guard,
  ]);
}

/** Several predicates joined with `op`, or the one predicate when there is only one. */
function joined(op: "and" | "or", operands: Predicate[]): Predicate {
  const [only] = operands;
  return operands.length === 1 && only !== undefined
    ? only
    : { type: "compound", op, operands };
}

/** A condition this does not model stays opaque, with its source text. */
export function predicateOf(
  node: PyNode,
  facts?: Database | undefined,
  inputs?: GuardInputs | undefined,
): Predicate {
  const arm = caseArmOf(node);
  if (arm !== null) {
    return caseArmPredicate(arm, facts, inputs);
  }

  if (node.type === "parenthesized_expression") {
    const inner = node.namedChild(0);
    return inner == null ? opaqueOf(node) : predicateOf(inner, facts, inputs);
  }

  if (node.type === "comparison_operator") {
    return comparisonOf(node, facts, inputs);
  }

  if (node.type === "not_operator") {
    const operand = field(node, "argument") ?? node.namedChild(0);
    return operand == null
      ? opaqueOf(node)
      : { type: "negation", operand: predicateOf(operand, facts, inputs) };
  }

  if (
    node.type === "identifier" ||
    node.type === "attribute" ||
    inputs?.has(node.id) === true
  ) {
    return {
      type: "truthinessCheck",
      subject: valueRefOf(node, facts, inputs),
      negated: false,
    };
  }

  return opaqueOf(node);
}

/** The subjects a guard can test whose source the walk can follow. */
const SUBJECT_TYPES = new Set(["identifier", "attribute", "subscript"]);

/**
 * The values `predicateOf` reads a condition's subjects from, so a body
 * can ask where all of them came from before it builds any predicate.
 */
export function operandsOf(node: PyNode): PyNode[] {
  const arm = caseArmOf(node);
  if (arm !== null) {
    const tested = arm.tests.flatMap((test) =>
      (PATTERN_OPERANDS[test.kind] as (one: PatternTest) => PyNode[])(test),
    );
    return arm.guard === null ? tested : [...tested, ...operandsOf(arm.guard)];
  }
  if (
    node.type === "parenthesized_expression" ||
    node.type === "not_operator"
  ) {
    const inner = field(node, "argument") ?? node.namedChild(0);
    return inner == null ? [] : operandsOf(inner);
  }
  if (node.type === "comparison_operator") {
    return children(node).filter(
      (child): child is PyNode =>
        child !== null && SUBJECT_TYPES.has(child.type),
    );
  }
  return SUBJECT_TYPES.has(node.type) ? [node] : [];
}
