/**
 * The value a call encodes, read off the language's encoders, so the
 * fact ops, the ops over nodes and the readers of a response body all
 * read `JSON.stringify(x)` as `x` the same way.
 */

import { Node } from "ts-morph";

import { dottedPathOf } from "../facts/extract.js";
import { ENCODERS } from "../facts/languageWords.js";
import { peelSyntax } from "../walk/unwrap.js";

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
  const call = peelSyntax(node);
  if (!Node.isCallExpression(call)) {
    return null;
  }
  const callee = dottedPathOf(call.getExpression());
  const encoder = ENCODERS.find((one) => one.callee === callee);
  if (encoder === undefined) {
    return null;
  }
  const value = call.getArguments()[encoder.argument];
  return value === undefined
    ? null
    : { codec: encoder.codec, value: peelSyntax(value) };
}
