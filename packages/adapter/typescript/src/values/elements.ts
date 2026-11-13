/**
 * The collection a name is given one element of, read off the syntax the
 * way the `elementOf` facts state it, so the ops over nodes and the ops
 * over the facts give a loop's record the same collection.
 */

import { Node } from "ts-morph";

import { collectionGivenTo, referencedSymbol } from "../facts/extract.js";
import { peelValue } from "../walk/unwrap.js";

/** The collection the value's one declaration is given an element of, or null. */
export function elementCollectionOf(value: Node): Node | null {
  const written = peelValue(value);
  if (!Node.isIdentifier(written)) {
    return null;
  }
  const declarations = referencedSymbol(written)?.getDeclarations() ?? [];
  const [declared] = declarations;
  return declarations.length === 1 && declared !== undefined
    ? collectionGivenTo(declared)
    : null;
}
