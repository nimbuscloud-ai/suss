/**
 * What a body prints. `puts`, `print` and `warn` written with no
 * receiver, and a write to `$stdout`, `STDOUT`, `$stderr` or `STDERR`,
 * become the same `stream-write` effect the Node pack records for
 * `console.log`, on an `io` binding that says which stream.
 *
 * These are Ruby's own `Kernel` methods and globals, so the adapter reads
 * them without a pack, the way it reads `ENV`.
 */

import { ioBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import {
  field,
  hashKeySymbolName,
  readCallArgs,
  stringLiteralValue,
  symbolValue,
} from "./ast.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

export const RUBY_STREAM_RECOGNITION = "ruby-stdlib";

/** The Kernel methods that print, and the stream each one prints to. */
const KERNEL_WRITES: Readonly<Record<string, string>> = {
  puts: "stdout",
  print: "stdout",
  warn: "stderr",
};

/** The ways Ruby spells each stream as a receiver. */
const STREAM_RECEIVERS: Readonly<Record<string, string>> = {
  $stdout: "stdout",
  STDOUT: "stdout",
  $stderr: "stderr",
  STDERR: "stderr",
};

const STREAM_METHODS = new Set(["puts", "print", "write", "<<"]);

/** A method or a block prints when it runs, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/** The write effects for every print under `root`, in source order. */
export function streamWriteEffects(root: RbNode): Effect[] {
  const found: Effect[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const write = node.type === "call" ? streamWriteAt(node) : null;
      if (write !== null) {
        found.push(write);
      }
    },
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });
  return found;
}

/** The stream a call writes to, or null when it is not a write to one. */
export function streamWrittenBy(call: RbNode): string | null {
  const method = field(call, "method")?.text ?? "";
  const receiver = field(call, "receiver");
  if (receiver === null) {
    return KERNEL_WRITES[method] ?? null;
  }
  if (!STREAM_METHODS.has(method)) {
    return null;
  }
  return STREAM_RECEIVERS[receiver.text] ?? null;
}

function streamWriteAt(call: RbNode): Effect | null {
  const target = streamWrittenBy(call);
  if (target === null) {
    return null;
  }
  const { positional } = readCallArgs(field(call, "arguments"));
  return writeEffect(call, target, positional);
}

/** A write effect for a call that prints these arguments to this stream. */
export function writeEffect(
  call: RbNode,
  target: string,
  args: readonly RbNode[],
): Effect {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text ?? "";
  return {
    type: "interaction",
    binding: ioBinding({ recognition: RUBY_STREAM_RECOGNITION, target }),
    callee: receiver === null ? method : `${receiver.text}.${method}`,
    groupId: `${call.startPosition.row + 1}:${call.startPosition.column + 1}`,
    interaction: { class: "stream-write", ...payloadOf(args) },
  };
}

/**
 * `JSON.generate(report)` and `report.to_json` write the report as JSON.
 * Several arguments are printed one after another, so their shapes come
 * back keyed by position.
 */
function payloadOf(args: readonly RbNode[]): {
  payload: TypeShape | null;
  serialized: "json" | "text";
} {
  const only = args[0];
  if (args.length !== 1 || only === undefined) {
    const properties: Record<string, TypeShape> = {};
    for (const [at, arg] of args.entries()) {
      properties[String(at)] = writtenShapeOf(arg);
    }
    return { payload: { type: "record", properties }, serialized: "text" };
  }
  const serialized = jsonSerialized(only);
  return serialized === null
    ? { payload: writtenShapeOf(only), serialized: "text" }
    : { payload: writtenShapeOf(serialized), serialized: "json" };
}

const JSON_WRITERS = new Set(["generate", "pretty_generate", "dump"]);

/** The value a call serializes as JSON, or null for any other expression. */
function jsonSerialized(node: RbNode): RbNode | null {
  if (node.type !== "call") {
    return null;
  }
  const receiver = field(node, "receiver");
  const method = field(node, "method")?.text ?? "";
  if (method === "to_json") {
    return receiver;
  }
  if (receiver?.text !== "JSON" || !JSON_WRITERS.has(method)) {
    return null;
  }
  return readCallArgs(field(node, "arguments")).positional[0] ?? null;
}

const SCALARS: Readonly<Record<string, TypeShape>> = {
  integer: { type: "integer" },
  float: { type: "number" },
  true: { type: "boolean" },
  false: { type: "boolean" },
  nil: { type: "null" },
};

/** What a written-out value says about its own shape; anything computed is unknown. */
function writtenShapeOf(node: RbNode): TypeShape {
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
    const first = node.namedChildren.find((child) => child !== null);
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
  for (const pair of node.namedChildren) {
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
