/**
 * Reads a Ruby expression down to a string or a list of strings, for
 * callers that need a name rather than a route path.
 *
 * Everything goes through the shared value evaluator. So `only: ACTIONS`
 * with the array in a constant reads the same as `only: %i[show]` written
 * at the call, and a symbol, a string and a `%i[...]` element all come
 * down to the same string.
 */

import { force, literalOf, sequence, text } from "@suss/values";

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

/** One element a loop runs over, and the parts a block that takes it apart is given, in order. */
export interface LoopElement {
  readonly whole: Value;
  readonly parts: readonly Value[];
}

/**
 * The elements a loop over the expression at `node` runs through, or
 * null when it does not come down to a list or a hash the source writes
 * out. A hash gives its key and value pairs. An element that is not a
 * list is its own first part, since Ruby gives it whole to the first
 * variable of a block that takes elements apart.
 */
export function loopElementsOf(
  node: RbNode,
  db?: Database,
): LoopElement[] | null {
  const value = evaluatedValue(node, db);
  if (value.kind === "sequence") {
    return value.items.map((item) => elementOfList(force(item.value)));
  }
  if (value.kind === "record" && !value.open) {
    return [...value.fields].map(([key, item]) => {
      const parts = [text(key), force(item.value)];
      return { whole: sequence(parts), parts };
    });
  }
  return null;
}

function elementOfList(whole: Value): LoopElement {
  return {
    whole,
    parts:
      whole.kind === "sequence"
        ? whole.items.map((item) => force(item.value))
        : [whole],
  };
}

/**
 * Every name one expression writes: the single string it comes down to, or
 * every string in the list it comes down to. Returns null when neither
 * settles, which a caller treats as no names given.
 */
export function namesOf(node: RbNode, db?: Database): string[] | null {
  const value = evaluatedValue(node, db);
  const single = literalOf(value);
  return single === null ? literalElementsIn(value) : [single];
}
