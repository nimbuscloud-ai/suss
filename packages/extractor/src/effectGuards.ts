/**
 * Which branch an effect belongs to.
 *
 * An adapter finds the calls a body makes once, then has to say which
 * of the branches it also found each call runs on. Two facts settle it,
 * and both are already extracted: the guards the call is written under,
 * and where the branch's terminal is in the file. Every adapter that
 * attributes effects to branches reads from here, so they all decide
 * it the same way.
 *
 * Neither test is enough alone, and the README beside this file says
 * why with the two shapes that go wrong.
 */

import type { RawCondition } from "./index.js";

/** The spelling of a condition that two lists are compared by. */
const keyOf = (condition: RawCondition): string =>
  `${condition.polarity}:${condition.sourceText}`;

const opposite = (condition: RawCondition): string =>
  `${condition.polarity === "positive" ? "negative" : "positive"}:${condition.sourceText}`;

/**
 * Whether the branch leaves room for every guard on the effect. A guard
 * the branch wrote down the other way around rules the effect out. A
 * guard it says nothing about does not, because a branch out of a loop
 * or a catch says nothing about what happened inside.
 */
export function guardsHoldOn(
  preconditions: readonly RawCondition[] | undefined,
  conditions: readonly RawCondition[],
): boolean {
  if (preconditions === undefined || preconditions.length === 0) {
    return true;
  }
  const onBranch = new Set(conditions.map(keyOf));
  return preconditions.every(
    (precondition) => !onBranch.has(opposite(precondition)),
  );
}

/**
 * Whether a call on `effectLine` was written by the time the terminal
 * ending on `terminalEndLine` is reached. The terminal's last line and
 * not its first, because a call written inside the terminal's own
 * expression, `return new Promise((resolve) => resolve(read()))`, runs
 * as part of producing it.
 */
export function runsBefore(
  effectLine: number,
  terminalEndLine: number,
): boolean {
  return effectLine <= terminalEndLine;
}
