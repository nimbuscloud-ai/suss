/**
 * The value a call encodes, read off the standard library's encoders, so
 * the stream reader and the ops over the facts read `JSON.generate(x)`
 * and `x.to_json` as `x` the same way. A call matches by the constant's
 * text and the method, as Ruby looks the method up at run time.
 */

import { field, readCallArgs } from "./ast.js";
import { ENCODERS } from "./facts/languageWords.js";

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
  if (call.type !== "call") {
    return null;
  }
  for (const encoder of ENCODERS) {
    const found = encodedBy(encoder, call);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function encodedBy(
  encoder: ConstantEncoder | ReceiverEncoder,
  call: RbNode,
): EncodedNode | null {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text ?? "";
  if ("of" in encoder) {
    return method === encoder.method && receiver !== null
      ? { codec: encoder.codec, value: receiver, at: "receiver" }
      : null;
  }
  if (
    receiver?.text !== encoder.constant ||
    !encoder.methods.includes(method)
  ) {
    return null;
  }
  const value = readCallArgs(field(call, "arguments")).positional[
    encoder.argument
  ];
  return value === undefined
    ? null
    : { codec: encoder.codec, value, at: encoder.argument };
}
