/**
 * predicates.ts: what a condition tests, rather than the text it was
 * written as.
 *
 * A reader of a summary asks which member a test reads and what it
 * compares against: the checker does it to find the status a caller's
 * guard names. Text cannot answer that, so a comparison, a null check
 * and a truthiness check each come out as themselves, and anything this
 * does not model stays opaque with its own text.
 */

import { booleanLiteralValue, field, stringLiteralValue } from "../ast.js";

import type { Predicate, ValueRef } from "@suss/behavioral-ir";
import type { RbNode } from "../parser.js";

/** The operators the IR models, by the text Ruby writes them as. */
const OPERATORS: Record<string, "eq" | "neq" | "gt" | "gte" | "lt" | "lte"> = {
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

/** Ruby's own conversions, which say nothing about which member was read. */
const CONVERSIONS = new Set(["to_i", "to_s", "to_sym"]);

const opaqueOf = (node: RbNode): Predicate => ({
  type: "opaque",
  sourceText: node.text,
  reason: "complexExpression",
});

/** What one condition tests. */
export function predicateOf(node: RbNode): Predicate {
  if (node.type === "parenthesized_statements") {
    const inner = node.namedChildren[0];
    return inner == null ? opaqueOf(node) : predicateOf(inner);
  }

  if (node.type === "unary" && field(node, "operator")?.text === "!") {
    const operand = field(node, "operand") ?? node.namedChildren[0];
    return operand == null
      ? opaqueOf(node)
      : { type: "negation", operand: predicateOf(operand) };
  }

  if (node.type === "binary") {
    return binaryOf(node);
  }

  const asked = calledMethod(node);
  if (asked === "nil?") {
    const receiver = field(node, "receiver");
    return receiver === null
      ? opaqueOf(node)
      : { type: "nullCheck", subject: valueRefOf(receiver), negated: false };
  }

  if (node.type === "identifier" || memberChain(node) !== null) {
    return {
      type: "truthinessCheck",
      subject: valueRefOf(node),
      negated: false,
    };
  }

  return opaqueOf(node);
}

function binaryOf(node: RbNode): Predicate {
  const operator = field(node, "operator")?.text ?? "";
  const left = field(node, "left");
  const right = field(node, "right");
  if (left === null || right === null) {
    return opaqueOf(node);
  }
  const op = OPERATORS[operator];
  if (op !== undefined) {
    return {
      type: "comparison",
      left: valueRefOf(left),
      op,
      right: valueRefOf(right),
    };
  }
  if (
    operator === "&&" ||
    operator === "||" ||
    operator === "and" ||
    operator === "or"
  ) {
    return {
      type: "compound",
      op: operator === "&&" || operator === "and" ? "and" : "or",
      operands: [predicateOf(left), predicateOf(right)],
    };
  }
  return opaqueOf(node);
}

/** The value one side of a test reads. */
function valueRefOf(node: RbNode): ValueRef {
  const literal = literalOf(node);
  if (literal !== null) {
    return literal;
  }
  const chain = memberChain(node);
  if (chain !== null) {
    const [name, ...accessChain] = chain;
    if (name !== undefined && accessChain.length > 0) {
      return { type: "dependency", name, accessChain };
    }
  }
  return { type: "unresolved", sourceText: node.text };
}

function literalOf(node: RbNode): ValueRef | null {
  if (node.type === "integer") {
    const value = Number.parseInt(node.text, 10);
    return Number.isNaN(value) ? null : { type: "literal", value };
  }
  const string = stringLiteralValue(node);
  if (string !== null) {
    return { type: "literal", value: string };
  }
  const boolean = booleanLiteralValue(node);
  return boolean === null ? null : { type: "literal", value: boolean };
}

/**
 * `response.status` as the name it starts from and the members read off
 * it, so a reader can ask which member the test read. A trailing
 * conversion is the language's own and says nothing about that, so
 * `response.code.to_i` reads as `code` the way `response.status` does.
 * Null for anything with arguments or a receiver that is not a name.
 */
function memberChain(node: RbNode, tail: string[] = []): string[] | null {
  if (node.type === "identifier") {
    return [node.text, ...tail];
  }
  const called = calledMethod(node);
  const receiver = field(node, "receiver");
  if (
    called === null ||
    receiver === null ||
    field(node, "arguments") !== null
  ) {
    return null;
  }
  const rest =
    CONVERSIONS.has(called) && tail.length === 0 ? tail : [called, ...tail];
  return memberChain(receiver, rest);
}

/** The method a call names, for a call with no arguments and no block. */
function calledMethod(node: RbNode): string | null {
  if (node.type !== "call" || field(node, "block") !== null) {
    return null;
  }
  return field(node, "method")?.text ?? null;
}
