/**
 * The strings a Ruby expression comes down to, for the readers that want a
 * name or a list of names rather than a route path.
 *
 * Everything goes through the shared value evaluator, so `only: ACTIONS`
 * with the array written in a constant reads the same as `only: %i[show]`
 * written at the call, and a symbol, a string and a `%i[...]` element all
 * come down to the same string.
 */

import { force, literalOf } from "@suss/values";

import { evaluatedValue } from "./evaluator.js";

import type { Database } from "@suss/datalog";
import type { Value } from "@suss/values";
import type { RbNode } from "../parser.js";

/** The strings `value` is when it is a list of them, or null when any element is something else. */
function literalElementsIn(value: Value): string[] | null {
  if (value.kind !== "sequence") {
    return null;
  }
  const elements: string[] = [];
  for (const item of value.items) {
    const literal = literalOf(force(item.value));
    if (literal === null) {
      return null;
    }
    elements.push(literal);
  }
  return elements;
}

/** The strings the expression at `node` comes down to when it is a list of them. */
export function literalElementsOf(
  node: RbNode,
  db?: Database,
): string[] | null {
  return literalElementsIn(evaluatedValue(node, db));
}

/**
 * Every name one expression writes: the single string it comes down to, or
 * every string in the list it comes down to. Null when neither settles, and
 * a caller reads that as having been told nothing.
 */
export function namesOf(node: RbNode, db?: Database): string[] | null {
  const value = evaluatedValue(node, db);
  const single = literalOf(value);
  return single === null ? literalElementsIn(value) : [single];
}
