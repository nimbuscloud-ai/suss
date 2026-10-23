/**
 * Which branch an effect belongs to.
 *
 * An adapter finds the calls a body makes once, then has to say which
 * of the branches it also found each call runs on. `firesOn` settles it
 * from what is already extracted: the guards the call is written under,
 * the line it is written on, and where the branch's terminal is. Every
 * adapter attributes effects to branches through it, so they all decide
 * it the same way, for a plain call and for one a pack recognized.
 *
 * This package's DESIGN.md shows why each test is there, with the cases
 * where leaving one out puts an effect on the wrong branch.
 */

import type { RawBranch, RawCondition } from "./index.js";

/** The spelling of a condition that two lists are compared by. */
const keyOf = (condition: RawCondition): string =>
  `${condition.polarity}:${condition.sourceText}`;

const opposite = (condition: RawCondition): string =>
  `${condition.polarity === "positive" ? "negative" : "positive"}:${condition.sourceText}`;

/** Where the call or read behind an effect is written. */
export interface EffectSite {
  /** The line the statement the call is written in starts on. */
  line: number;
  /** The guards the call is written under, spelled the way a branch records its conditions. */
  preconditions?: readonly RawCondition[] | undefined;
  /**
   * For a call in a `finally` or `ensure` body, the first line of the
   * try it cleans up after. The call runs on every path that entered
   * that try, including one that returned or threw before reaching it.
   */
  cleansUpFrom?: number | undefined;
}

/** An effect, and where it was written. */
export interface PlacedEffect<E> {
  effect: E;
  site: EffectSite;
}

/** What the branch test reads off a branch. */
export type BranchEnding = Pick<
  RawBranch,
  "conditions" | "terminal" | "loopAround"
>;

/**
 * Whether the effect written at `site` can run before `branch` reaches its
 * terminal. A call in the loop around the terminal may have run on an
 * earlier pass, whatever its guards say about the last one, so it stays.
 * Anything else needs a branch that does not contradict its guards, and
 * has to be written no later than the terminal ends.
 */
export function firesOn(site: EffectSite, branch: BranchEnding): boolean {
  const loop = branch.loopAround;
  if (loop !== undefined && site.line >= loop.start && site.line <= loop.end) {
    return true;
  }
  if (!guardsHoldOn(site.preconditions, branch.conditions)) {
    return false;
  }
  return runsBefore(
    site.cleansUpFrom ?? site.line,
    branch.terminal.location.end,
  );
}

/** The effects that can run before the branch reaches its terminal, in the order given. */
export function effectsFiringOn<E>(
  placed: readonly PlacedEffect<E>[],
  branch: BranchEnding,
): E[] {
  return placed
    .filter((one) => firesOn(one.site, branch))
    .map((one) => one.effect);
}

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
