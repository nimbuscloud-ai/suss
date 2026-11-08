/**
 * The shape a value says it has where the source writes it, without
 * following any name: a literal, a hash of literals, an array. The stream
 * reader records a write's payload this way, and the ops over the facts
 * answer `ValueOps.shape` with it.
 */

import {
  children,
  field,
  hashKeySymbolName,
  stringLiteralValue,
  symbolValue,
} from "./ast.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

const SCALARS: Readonly<Record<string, TypeShape>> = {
  integer: { type: "integer" },
  float: { type: "number" },
  true: { type: "boolean" },
  false: { type: "boolean" },
  nil: { type: "null" },
};

/** What a written-out value says about its own shape; anything computed is unknown. */
export function writtenShapeOf(node: RbNode): TypeShape {
  const scalar = SCALARS[node.type];
  if (scalar !== undefined) {
    return scalar;
  }
  if (node.type === "string") {
    const literal = stringLiteralValue(node);
    return literal === null
      ? { type: "text" }
      : { type: "literal", value: literal };
  }
  if (node.type === "hash") {
    return hashShape(node);
  }
  if (node.type === "array") {
    const first = children(node).find((child) => child !== null);
    return {
      type: "array",
      items: first ? writtenShapeOf(first) : { type: "unknown" },
    };
  }
  return { type: "unknown" };
}

/** A hash written with symbol or string keys is a record of them. */
function hashShape(node: RbNode): TypeShape {
  const properties: Record<string, TypeShape> = {};
  for (const pair of children(node)) {
    if (pair?.type !== "pair") {
      continue;
    }
    const key = field(pair, "key");
    const value = field(pair, "value");
    const name = key === null ? null : keyName(key);
    if (name !== null && value !== null) {
      properties[name] = writtenShapeOf(value);
    }
  }
  return { type: "record", properties };
}

function keyName(key: RbNode): string | null {
  return hashKeySymbolName(key) ?? symbolValue(key) ?? stringLiteralValue(key);
}
