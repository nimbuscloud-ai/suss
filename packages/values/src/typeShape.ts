/**
 * Turns an evaluated value into the type shape a response body is
 * compared by.
 *
 * A language with no declared types, such as Ruby, writes a JSON body
 * as a hash, and the evaluator is what reads that hash wherever it was
 * built. This module writes down what the value says about its
 * structure. A key the source wrote becomes a property, a literal stays
 * a literal, and anything the evaluator left as a hole becomes
 * `unknown`, so the checker treats it as unread rather than empty.
 */

import { force, literalsOf } from "./value.js";

import type { TypeShape } from "@suss/ir-core";
import type { Constant, Item, Value } from "./value.js";

/** More literal strings than this become text, as a declared union would. */
const LITERAL_CAP = 8;

/**
 * A record the evaluator left open may have keys it could not see. The
 * checker reads a spread as "may have any field", so an open record
 * gets one, without source text to point at.
 */
const UNSEEN_KEYS = { sourceText: "..." };

const UNKNOWN: TypeShape = { type: "unknown" };

function unionOf(shapes: readonly TypeShape[]): TypeShape {
  const distinct = new Map<string, TypeShape>();
  for (const shape of shapes) {
    distinct.set(JSON.stringify(shape), shape);
  }
  const variants = [...distinct.values()];
  if (variants.length === 1) {
    return variants[0] as TypeShape;
  }
  return variants.length === 0 ? UNKNOWN : { type: "union", variants };
}

function constantShape(option: Constant): TypeShape {
  if (option === null) {
    return { type: "null" };
  }
  if (option === undefined) {
    return { type: "undefined" };
  }
  return { type: "literal", value: option };
}

function stringShape(value: Value): TypeShape {
  const literals = literalsOf(value, LITERAL_CAP);
  if (literals === null) {
    return { type: "text" };
  }
  return unionOf(
    literals.map((literal) => ({ type: "literal", value: literal })),
  );
}

function itemShape(item: Item): TypeShape {
  const shape = shapeOfValue(item.value);
  return item.presence === "optional"
    ? { type: "union", variants: [shape, { type: "undefined" }] }
    : shape;
}

function recordShape(value: Extract<Value, { kind: "record" }>): TypeShape {
  const properties: Record<string, TypeShape> = {};
  for (const [name, item] of value.fields) {
    properties[name] = itemShape(item);
  }
  return value.open
    ? { type: "record", properties, spreads: [UNSEEN_KEYS] }
    : { type: "record", properties };
}

type ShapeTable = {
  [K in Value["kind"]]: (value: Extract<Value, { kind: K }>) => TypeShape;
};

const SHAPES: ShapeTable = {
  string: stringShape,
  constant: (value) => unionOf(value.options.map(constantShape)),
  sequence: (value) => ({
    type: "array",
    items: unionOf(value.items.map((item) => shapeOfValue(item.value))),
  }),
  unbounded: (value) => ({ type: "array", items: shapeOfValue(value.element) }),
  record: recordShape,
  hole: () => UNKNOWN,
  ref: () => UNKNOWN,
  // `force` never returns a deferred value, so this entry only satisfies the table.
  deferred: () => UNKNOWN,
};

/** The structure an evaluated value has, with `unknown` wherever the evaluator could not see. */
export function shapeOfValue(value: Value): TypeShape {
  const forced = force(value);
  return (SHAPES[forced.kind] as (v: Value) => TypeShape)(forced);
}
