/**
 * Marks a branch condition that can never be true. Each adapter reads
 * the condition and its subject with its language's sound evaluator,
 * which gives a value only when the value covers every run. When that
 * says the condition always comes out one way, and the branch needs the
 * other, the branch can never run. Assembly turns the mark into the
 * transition's `unreachable` field.
 *
 * Only a test of a value's truth is read here, `x`, `!x`, `not x`, since
 * that is where the language's rule decides the answer. A subject read
 * off an input is left alone: a caller can pass the unit anything.
 */

import { truthTestSubject } from "@suss/behavioral-ir";

import type { TypeShape, Unreachable, ValueRef } from "@suss/behavioral-ir";
import type { RawCondition } from "./index.js";

/** What an adapter's sound evaluator says about one condition. */
export interface SettledCondition {
  /** What the whole condition comes to, by the language's rule. */
  readonly truth: boolean;
  /** Every value the condition's subject can have. */
  readonly values: TypeShape;
  /** What the language's rule makes of every one of those values. */
  readonly every: Unreachable["every"];
}

/** Whether a value comes off one of the unit's inputs, however many reads down. */
function readsAnInput(ref: ValueRef): boolean {
  if (ref.type === "derived") {
    return readsAnInput(ref.from);
  }
  return ref.type === "input";
}

/**
 * Whether an adapter should ask its sound evaluator about this condition
 * at all. Most conditions test an input, and those can never be settled.
 */
function asksSettledTruth(condition: RawCondition): boolean {
  const subject = truthTestSubject(condition.structured);
  return subject !== null && !readsAnInput(subject);
}

/**
 * The condition, marked when its branch needs the answer it never gives.
 * `settle` reads the condition's expression with the language's sound
 * evaluator. `answers` keeps what it said under the expression's `key`,
 * since every path through a function repeats the conditions above it.
 */
export function withSettledCondition<K>(
  condition: RawCondition,
  key: K | null,
  answers: Map<K, SettledCondition | null>,
  settle: () => SettledCondition | null,
): RawCondition {
  if (key === null || !asksSettledTruth(condition)) {
    return condition;
  }
  let answer = answers.get(key);
  if (answer === undefined) {
    answer = settle();
    answers.set(key, answer);
  }
  return withSettledTruth(condition, answer);
}

function withSettledTruth(
  condition: RawCondition,
  settled: SettledCondition | null,
): RawCondition {
  if (settled === null) {
    return condition;
  }
  const needed = condition.polarity === "positive";
  if (settled.truth === needed) {
    return condition;
  }
  return {
    ...condition,
    neverHolds: { values: settled.values, every: settled.every },
  };
}

/** Where the first condition that can never be true is, and why, for a transition built from these. */
export function unreachableOf(
  conditions: readonly RawCondition[],
): Unreachable | null {
  const at = conditions.findIndex(
    (condition) => condition.neverHolds !== undefined,
  );
  const found = conditions[at]?.neverHolds;
  return found === undefined ? null : { condition: at, ...found };
}
