/**
 * The value a call encodes or decodes, read off the standard library's
 * encoders and decoders, so the stream reader and the ops over the facts
 * read `JSON.generate(x)` and `x.to_json` as `x` the same way, and a
 * consumer's `JSON.parse(x)` as a decode of `x`. A call matches by the
 * constant's text and the method, as Ruby looks the method up at run
 * time.
 */

import { field, readCallArgs } from "./ast.js";
import { DECODERS, ENCODERS } from "./facts/languageWords.js";

import type {
  ConstantEncoder,
  ReceiverEncoder,
} from "./facts/languageWords.js";
import type { RbNode } from "./parser.js";

/** What an encoder was handed, how it encoded it, and where the call wrote it. */
export interface EncodedNode {
  readonly codec: string;
  readonly value: RbNode;
  /** The receiver, or the position among the call's positional arguments. */
  readonly at: "receiver" | number;
}

/** What a call of one of `ENCODERS` encodes, or null for any other node. */
export function encodedIn(call: RbNode): EncodedNode | null {
  return handedTo(ENCODERS, call);
}

/** What a call of one of `DECODERS` decodes, or null for any other node. */
export function decodedIn(call: RbNode): EncodedNode | null {
  return handedTo(DECODERS, call);
}

function handedTo(
  table: readonly (ConstantEncoder | ReceiverEncoder)[],
  call: RbNode,
): EncodedNode | null {
  if (call.type !== "call") {
    return null;
  }
  for (const codec of table) {
    const found = handedBy(codec, call);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function handedBy(
  codec: ConstantEncoder | ReceiverEncoder,
  call: RbNode,
): EncodedNode | null {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text ?? "";
  if ("of" in codec) {
    return method === codec.method && receiver !== null
      ? { codec: codec.codec, value: receiver, at: "receiver" }
      : null;
  }
  if (receiver?.text !== codec.constant || !codec.methods.includes(method)) {
    return null;
  }
  const value = readCallArgs(field(call, "arguments")).positional[
    codec.argument
  ];
  return value === undefined
    ? null
    : { codec: codec.codec, value, at: codec.argument };
}
