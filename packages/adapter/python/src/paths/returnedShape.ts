/**
 * The shape of the value a return statement writes. A route's declared
 * annotation gives every branch the same body, so a branch reads its own
 * returned expression instead when it can.
 */

import {
  children,
  field,
  isStringLiteral,
  numberLiteralValue,
  stringLiteralValue,
} from "../ast.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { PyNode } from "../parser.js";

/** How deep into a written-out value the reading goes before it gives up. */
const MAX_DEPTH = 6;

const SCALARS: Record<string, TypeShape> = {
  none: { type: "null" },
  true: { type: "boolean" },
  false: { type: "boolean" },
};

/** A dict written with string keys is a record; anything else about it is a dictionary. */
function recordShape(node: PyNode, depth: number): TypeShape {
  const properties: Record<string, TypeShape> = {};
  let everyKeyWritten = true;
  for (const pair of children(node)) {
    if (pair.type !== "pair") {
      everyKeyWritten = false;
      continue;
    }
    const key = field(pair, "key");
    const name = key === null ? null : stringLiteralValue(key);
    const value = field(pair, "value");
    if (name === null || value === null) {
      everyKeyWritten = false;
      continue;
    }
    properties[name] = shapeOfReturned(value, depth + 1);
  }

  return everyKeyWritten && Object.keys(properties).length > 0
    ? { type: "record", properties }
    : { type: "dictionary", values: { type: "unknown" } };
}

/**
 * What one written-out value says about its own shape. A name becomes a ref
 * to that name instead of a guess at its value, the same as the TypeScript
 * adapter does for an identifier it has not followed.
 */
export function shapeOfReturned(node: PyNode, depth = 0): TypeShape {
  if (depth > MAX_DEPTH) {
    return { type: "unknown" };
  }

  const scalar = SCALARS[node.type];
  if (scalar !== undefined) {
    return scalar;
  }

  // An f-string that interpolates a value has no one value to write
  // down, so it reads as text, the same as a template in TypeScript.
  if (isStringLiteral(node)) {
    const value = stringLiteralValue(node);
    return value === null ? { type: "text" } : { type: "literal", value };
  }
  if (node.type === "integer") {
    const value = numberLiteralValue(node);
    return value === null ? { type: "integer" } : { type: "literal", value };
  }
  if (node.type === "float") {
    return { type: "number" };
  }
  if (node.type === "dictionary") {
    return recordShape(node, depth);
  }
  if (node.type === "list" || node.type === "tuple" || node.type === "set") {
    const first = children(node)[0];
    return {
      type: "array",
      items:
        first === undefined
          ? { type: "unknown" }
          : shapeOfReturned(first, depth + 1),
    };
  }
  if (node.type === "identifier" || node.type === "attribute") {
    return { type: "ref", name: node.text };
  }

  return { type: "unknown" };
}

/**
 * The body a return writes. From a returned tuple it takes the first
 * element, because Flask reads the status from the second. Null when the
 * return writes nothing with a readable shape.
 */
export function returnedBodyShape(statement: PyNode): TypeShape | null {
  const returned = statement.namedChild(0);
  if (returned == null) {
    return null;
  }

  const value =
    returned.type === "expression_list" ? children(returned)[0] : returned;
  if (value === undefined) {
    return null;
  }

  const shape = shapeOfReturned(value);
  return shape.type === "unknown" ? null : shape;
}
