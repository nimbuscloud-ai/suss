// undefinedValue.ts: whether the source writes `undefined` at a node,
// for every reader that treats it as no value.

import { Node } from "ts-morph";

/**
 * Whether the source writes `undefined` here. TypeScript parses it as an
 * identifier, not as a keyword the way it parses `null`, so the check is
 * on the name.
 */
export function writesUndefined(node: Node): boolean {
  return Node.isIdentifier(node) && node.getText() === "undefined";
}
