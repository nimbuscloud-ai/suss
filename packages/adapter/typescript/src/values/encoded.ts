/**
 * The value a call encodes or decodes, read off the language's encoders
 * and decoders, so the fact ops, the ops over nodes and the readers of a
 * response body all read `JSON.stringify(x)` as `x` the same way, and a
 * consumer's `JSON.parse(x)` as a decode of `x`.
 */

import { Node } from "ts-morph";

import { dottedPathOf } from "../facts/extract.js";
import { DECODERS, ENCODERS } from "../facts/languageWords.js";
import { peelSyntax } from "../walk/unwrap.js";

import type { GlobalCodec } from "../facts/languageWords.js";

/** What an encoder was handed, and how it encoded it. */
export interface EncodedNode {
  readonly codec: string;
  readonly value: Node;
}

/**
 * What a call of one of `ENCODERS` encodes, or null for any other value.
 * A cast around the call or around the argument is looked through.
 */
export function encodedIn(node: Node): EncodedNode | null {
  return handedTo(ENCODERS, node);
}

/** What a call of one of `DECODERS` decodes, looked through the same way. */
export function decodedIn(node: Node): EncodedNode | null {
  return handedTo(DECODERS, node);
}

function handedTo(
  table: readonly GlobalCodec[],
  node: Node,
): EncodedNode | null {
  const call = peelSyntax(node);
  if (!Node.isCallExpression(call)) {
    return null;
  }
  const callee = dottedPathOf(call.getExpression());
  const codec = table.find((one) => one.callee === callee);
  if (codec === undefined) {
    return null;
  }
  const value = call.getArguments()[codec.argument];
  return value === undefined
    ? null
    : { codec: codec.codec, value: peelSyntax(value) };
}
