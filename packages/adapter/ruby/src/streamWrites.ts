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
import {
  callSiteKey,
  numberRepeatedCallSites,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";

import { children, field, rangeOf, readCallArgs } from "./ast.js";
import { isClaimed } from "./claims.js";
import { encodedIn } from "./encoded.js";
import { writtenShapeOf } from "./writtenShape.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";
import type { EffectAt } from "./paths/effects.js";

export const RUBY_STREAM_RECOGNITION = "ruby-stdlib";

/** The Kernel methods that print, and the stream each one prints to. */
const KERNEL_WRITES: ReadonlyMap<string, string> = new Map([
  ["puts", "stdout"],
  ["print", "stdout"],
  ["warn", "stderr"],
  ["abort", "stderr"],
]);

/** The ways Ruby spells each stream as a receiver. */
const STREAM_RECEIVERS: ReadonlyMap<string, string> = new Map([
  ["$stdout", "stdout"],
  ["STDOUT", "stdout"],
  ["$stderr", "stderr"],
  ["STDERR", "stderr"],
]);

const STREAM_METHODS = new Set(["puts", "print", "write", "<<"]);

/** The stream a global or a top-level constant spells, such as `$stdout`, or null. */
export function streamSpelledBy(node: RbNode): string | null {
  if (node.type !== "global_variable" && node.type !== "constant") {
    return null;
  }
  return node.parent?.type === "scope_resolution"
    ? null
    : (STREAM_RECEIVERS.get(node.text) ?? null);
}

/** A method or a block prints when it runs, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/** The write effects for every print under `root`, in source order. The blocks and lambdas in `claimed` are left out. */
export function streamWriteEffects(
  root: RbNode,
  claimed?: ReadonlySet<number>,
): EffectAt[] {
  return numberRepeatedCallSites(
    writesUnder(root, claimed).map((write) => [write]),
  ).flat();
}

function writesUnder(
  root: RbNode,
  claimed: ReadonlySet<number> | undefined,
): EffectAt[] {
  const found: EffectAt[] = [];
  walkDescendants<RbNode, null>(root, null, children, {
    at: (node) => {
      const write = node.type === "call" ? streamWriteAt(node) : null;
      if (write !== null) {
        found.push({ effect: write, at: node });
      }
    },
    into: (node) =>
      DEFERRED_BODY_TYPES.has(node.type) || isClaimed(node, claimed)
        ? SKIP_CHILDREN
        : null,
  });
  return found;
}

/** The stream a call writes to, or null when it is not a write to one. */
export function streamWrittenBy(call: RbNode): string | null {
  const method = field(call, "method")?.text ?? "";
  const receiver = field(call, "receiver");
  if (receiver === null) {
    return KERNEL_WRITES.get(method) ?? null;
  }
  if (!STREAM_METHODS.has(method)) {
    return null;
  }
  return STREAM_RECEIVERS.get(receiver.text) ?? null;
}

function streamWriteAt(call: RbNode): Effect | null {
  const target = streamWrittenBy(call);
  if (target === null) {
    return null;
  }
  const { positional } = readCallArgs(field(call, "arguments"));
  // `abort` with no message ends the process without printing anything.
  if (positional.length === 0 && field(call, "method")?.text === "abort") {
    return null;
  }
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
  const effect: Extract<Effect, { type: "interaction" }> = {
    type: "interaction",
    binding: ioBinding({ recognition: RUBY_STREAM_RECOGNITION, target }),
    callee: receiver === null ? method : `${receiver.text}.${method}`,
    interaction: { class: "stream-write", ...payloadOf(args) },
    location: rangeOf(call),
  };
  return { ...effect, groupId: callSiteKey(effect) };
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

/** The value a call serializes as JSON, or null for any other expression. */
function jsonSerialized(node: RbNode): RbNode | null {
  const encoded = encodedIn(node);
  return encoded?.codec === "json" ? encoded.value : null;
}
