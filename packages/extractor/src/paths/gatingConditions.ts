// gatingConditions.ts: what every path to a terminal agrees on.
// The engine gives one condition list per path; a caller that wants to say
// what gates a terminal can only claim what all of those lists share.

import type { Predicate } from "@suss/behavioral-ir";
import type { RawCondition } from "../index.js";
import type { ConditionInfo } from "./structuredStatement.js";

const keyOf = (condition: { sourceText: string; polarity: string }): string =>
  `${condition.polarity}:${condition.sourceText}`;

/**
 * The conditions every path to a terminal agrees on. A terminal reached more
 * than one way keeps only the shared ones, so a condition is never claimed
 * for a path without it.
 *
 * `readPredicate` turns the language's own expression handle into a
 * predicate. Without one every condition stays opaque, which is what a
 * caller that has no reader gets.
 */
export function sharedGatingConditions<Cond>(
  paths: readonly (readonly ConditionInfo<Cond>[])[] | undefined,
  readPredicate?: (expression: Cond) => Predicate,
): RawCondition[] {
  const [first, ...rest] = paths ?? [];
  if (first === undefined) {
    return [];
  }

  const shared = new Set(first.map(keyOf));
  for (const path of rest) {
    const here = new Set(path.map(keyOf));
    for (const value of shared) {
      if (!here.has(value)) {
        shared.delete(value);
      }
    }
  }

  return first
    .filter((condition) => shared.has(keyOf(condition)))
    .map((condition) => ({
      sourceText: condition.sourceText,
      structured:
        readPredicate === undefined || condition.expression === null
          ? null
          : readPredicate(condition.expression),
      polarity: condition.polarity,
      source: condition.source,
    }));
}
