/**
 * Records what a condition tests instead of only its source text.
 *
 * The checker needs to know which member a test reads and what it
 * compares against, to find the status a caller's guard checks for. The
 * source text cannot tell it that, so a comparison, a null check and a
 * truthiness check each become their own predicate. Anything not
 * modelled here stays opaque, with its source text.
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

/**
 * The input each operand of a body's conditions reads, by node id, for
 * the operands whose value came from exactly one input. `guardInputs`
 * builds it.
 */
export type GuardInputs = ReadonlyMap<number, ValueRef>;

/** The operators that join two tests into one. */
const JOINING = new Set(["&&", "||", "and", "or"]);

/** What one condition tests. */
export function predicateOf(node: RbNode, inputs?: GuardInputs): Predicate {
  if (node.type === "parenthesized_statements") {
    const inner = node.namedChildren[0];
    return inner == null ? opaqueOf(node) : predicateOf(inner, inputs);
  }

  if (node.type === "unary" && field(node, "operator")?.text === "!") {
    const operand = field(node, "operand") ?? node.namedChildren[0];
    return operand == null
      ? opaqueOf(node)
      : { type: "negation", operand: predicateOf(operand, inputs) };
  }

  if (node.type === "binary") {
    return binaryOf(node, inputs);
  }

  const asked = calledMethod(node);
  if (asked === "nil?") {
    const receiver = field(node, "receiver");
    return receiver === null
      ? opaqueOf(node)
      : {
          type: "nullCheck",
          subject: valueRefOf(receiver, inputs),
          negated: false,
        };
  }

  if (
    node.type === "identifier" ||
    memberChain(node) !== null ||
    inputs?.has(node.id) === true
  ) {
    return {
      type: "truthinessCheck",
      subject: valueRefOf(node, inputs),
      negated: false,
    };
  }

  return opaqueOf(node);
}

/**
 * The values `predicateOf` reads a condition's subjects from, so a body
 * can ask where all of them came from before it builds any predicate.
 */
export function operandsOf(node: RbNode): RbNode[] {
  if (node.type === "parenthesized_statements") {
    const inner = node.namedChildren[0];
    return inner == null ? [] : operandsOf(inner);
  }
  if (node.type === "unary" && field(node, "operator")?.text === "!") {
    const operand = field(node, "operand") ?? node.namedChildren[0];
    return operand == null ? [] : operandsOf(operand);
  }
  if (node.type === "binary") {
    const operator = field(node, "operator")?.text ?? "";
    const sides = [field(node, "left"), field(node, "right")].filter(
      (side): side is RbNode => side !== null,
    );
    if (JOINING.has(operator)) {
      return sides.flatMap(operandsOf);
    }
    return OPERATORS[operator] === undefined ? [] : sides;
  }
  const receiver = field(node, "receiver");
  if (calledMethod(node) === "nil?" && receiver !== null) {
    return operandsOf(receiver);
  }
  return mayReadAnInput(node) ? [node] : [];
}

/**
 * Whether a subject is written the way a read of an input is: a name, a
 * member read with no arguments, or an entry read. A literal or a call
 * with arguments computes its value, and asking where it came from costs
 * a walk that ends at the call.
 */
function mayReadAnInput(node: RbNode): boolean {
  return (
    node.type === "identifier" ||
    node.type === "element_reference" ||
    memberChain(node) !== null
  );
}

function binaryOf(node: RbNode, inputs: GuardInputs | undefined): Predicate {
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
      left: valueRefOf(left, inputs),
      op,
      right: valueRefOf(right, inputs),
    };
  }
  if (JOINING.has(operator)) {
    return {
      type: "compound",
      op: operator === "&&" || operator === "and" ? "and" : "or",
      operands: [predicateOf(left, inputs), predicateOf(right, inputs)],
    };
  }
  return opaqueOf(node);
}

/** The value one side of a test reads. */
function valueRefOf(node: RbNode, inputs: GuardInputs | undefined): ValueRef {
  const literal = literalOf(node);
  if (literal !== null) {
    return literal;
  }
  const input = inputs?.get(node.id);
  if (input !== undefined) {
    return input;
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
 * `response.status` as the name it starts from plus the members read off
 * it, so a reader can ask which member the test read. A trailing
 * conversion does not change which member was read, so
 * `response.code.to_i` comes out as `["response", "code"]`. Null for a
 * call with arguments, or a chain that does not start at a name.
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

/** The method a call invokes, or null for anything other than a call without a block. */
function calledMethod(node: RbNode): string | null {
  if (node.type !== "call" || field(node, "block") !== null) {
    return null;
  }
  return field(node, "method")?.text ?? null;
}
