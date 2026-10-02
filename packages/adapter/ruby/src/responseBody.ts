/**
 * The JSON body a response call sends, as in
 * `render json: { success: false, status: 422 }, status: 422`.
 *
 * The pack says which keyword gives the body and which methods serialize
 * a value unchanged. The value is read through the evaluator, so a hash
 * a local variable or a project method builds counts the same as one
 * written in place. Only a hash or an array becomes a body. Anything
 * else, such as a model or a string that is already JSON text, is left
 * unread, so the checker treats the body as unknown rather than empty.
 */

import { absentReading, writtenReading } from "@suss/extractor";
import { shapeOfValue } from "@suss/values";

import { field, rangeOf, readCallArgs } from "./ast.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { Reading } from "@suss/extractor";
import type { RbStatusCall } from "./pack.js";
import type { RbNode } from "./parser.js";

const BODY_KINDS: ReadonlySet<string> = new Set([
  "record",
  "sequence",
  "unbounded",
]);

/** The value a serializer is called on, for each serializer call wrapped around `node`. */
function serializedValue(
  node: RbNode,
  serializers: ReadonlySet<string>,
): RbNode {
  const receiver = field(node, "receiver");
  const method = field(node, "method")?.text;
  if (
    node.type !== "call" ||
    receiver === null ||
    method === undefined ||
    !serializers.has(method) ||
    field(node, "arguments") !== null
  ) {
    return node;
  }
  return serializedValue(receiver, serializers);
}

/** What one response call says about the body it sends. */
export function bodyReadingOfCall(
  call: RbNode,
  declaration: RbStatusCall,
  facts: Database | undefined,
): Reading<TypeShape> {
  if (declaration.bodyKeyword === undefined || call.type !== "call") {
    return absentReading;
  }
  const argument = readCallArgs(field(call, "arguments")).keyword[
    declaration.bodyKeyword
  ];
  if (argument === undefined) {
    return absentReading;
  }
  const body = serializedValue(
    argument,
    new Set(declaration.bodySerializers ?? []),
  );
  const value = evaluatedValue(body, facts);
  return BODY_KINDS.has(value.kind)
    ? writtenReading(shapeOfValue(value), rangeOf(argument))
    : absentReading;
}
