/**
 * Which values count as true in a condition. Languages disagree: an
 * empty dict is false in Python and true in JavaScript and Ruby, and `0`
 * and `""` are true only in Ruby. So the engine and the rows never
 * decide it. Each lowering writes its language's rule as a table with
 * one entry for each kind of value, and `truthinessFrom` turns the table
 * into the rule. The helpers below are pieces those entries share.
 */

import { shapeOfValue } from "./typeShape.js";
import { force } from "./value.js";

import type { TypeShape } from "@suss/ir-core";
import type { Constant, Item, Value } from "./value.js";

/**
 * True when every value the abstract value can be counts as true, false
 * when every one counts as false, and null when they differ or nobody
 * knows.
 */
export type Truthiness = (value: Value) => boolean | null;

export type TruthTable = {
  readonly [K in Value["kind"]]: (
    value: Extract<Value, { kind: K }>,
  ) => boolean | null;
};

export function truthinessFrom(table: TruthTable): Truthiness {
  return (value) => {
    const forced = force(value);
    return (table[forced.kind] as (v: Value) => boolean | null)(forced);
  };
}

/** Whether every option counts as true, every one as false, or null when they differ. */
export function everyOption(
  options: readonly Constant[],
  countsAsTrue: (option: Constant) => boolean,
): boolean | null {
  const truths = new Set(options.map(countsAsTrue));
  if (truths.size !== 1) {
    return null;
  }
  return truths.has(true);
}

/**
 * Whether a string is empty: true for `""`, false when one of its pieces
 * is text that is never empty, and null when a hole or an optional piece
 * could leave it empty or not.
 */
export function stringIsEmpty(
  value: Extract<Value, { kind: "string" }>,
): boolean | null {
  if (value.pieces.length === 0) {
    return true;
  }
  const settled = value.pieces.some(
    (piece) =>
      piece.kind === "text" && piece.options.every((option) => option !== ""),
  );
  return settled ? false : null;
}

/**
 * Whether a list or a record has no entries: true when it has none,
 * false when one is always there, and null when every entry is one only
 * some paths wrote. A record code the evaluator cannot see may have
 * changed is open, and nobody knows how many entries that one has.
 */
export function hasNoEntries(
  value: Extract<Value, { kind: "sequence" | "record" }>,
): boolean | null {
  if (value.kind === "record" && value.open) {
    return null;
  }
  const items: readonly Item[] =
    value.kind === "record" ? [...value.fields.values()] : value.items;
  if (items.length === 0) {
    return true;
  }
  return items.some((item) => item.presence === "one") ? false : null;
}

/** The opposite answer, keeping null. */
export function opposite(answer: boolean | null): boolean | null {
  return answer === null ? null : !answer;
}

/** A test of truth that comes out the same way on every run, and why. */
export interface SettledTest {
  /** What the whole condition comes to. */
  readonly truth: boolean;
  /** Every value the condition's subject can have. */
  readonly values: TypeShape;
  /** What the rule makes of every one of those values. */
  readonly every: "truthy" | "falsy";
}

/**
 * What a condition comes to, given a sound value for the whole condition
 * and one for the value it tests, `x` in `!x`. Null when either could
 * come out either way. The subject is read only once the condition
 * settles.
 */
export function settledTest(
  condition: Value,
  subject: () => Value,
  truthiness: Truthiness,
): SettledTest | null {
  const truth = truthiness(condition);
  if (truth === null) {
    return null;
  }
  const tested = subject();
  const every = truthiness(tested);
  if (every === null) {
    return null;
  }
  return {
    truth,
    values: shapeOfValue(tested),
    every: every ? "truthy" : "falsy",
  };
}
