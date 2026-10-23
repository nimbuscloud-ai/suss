/**
 * What a set of units reaches: the boundaries they touch themselves, and
 * the boundaries touched by every function their calls lead to.
 *
 * `suss ask "what does <unit> reach"` and `suss map` both answer through
 * `touchesReached`, so the tables a route reaches on the map are the ones
 * ask lists for it. They differ only in how the call paths are found.
 * ask runs one fixpoint per question, and map runs one fixpoint for every
 * route at once and hands each route its own paths.
 */

import { functionOf } from "@suss/checker";

import { touchesOfUnits } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts, CallPath, FunctionKey } from "@suss/checker";
import type { TargetTouch } from "./target.js";

/** A touch, and the calls from the unit in the question to the unit that makes it. */
export interface ReachedTouch extends TargetTouch {
  through?: string[];
}

/**
 * The touches of `start`, then the touches of each function in `reached`,
 * nearest first. `direct` is what `start` touches itself, which a caller
 * may have narrowed already. A unit's own boundary is left out, since
 * listing that a route serves itself would bury what it calls.
 */
export function touchesReached(
  direct: readonly TargetTouch[],
  reached: ReadonlyMap<FunctionKey, CallPath>,
  facts: CallFacts,
): ReachedTouch[] {
  const own = direct.filter((touch) => !servesItself(touch));
  const already = new Set(own.map((touch) => touchKey(touch)));
  const found: ReachedTouch[] = [];
  for (const [fn, through, possible] of shortestFirst(reached, facts)) {
    for (const touch of touchesOfUnits(facts.units.get(fn) ?? [])) {
      if (servesItself(touch) || already.has(touchKey(touch))) {
        continue;
      }
      already.add(touchKey(touch));
      found.push({ ...touch, through, ...(possible ? { possible } : {}) });
    }
  }
  return [...own, ...found];
}

/** The functions the calls out of `start` lead to, with the shortest path to each. */
export function reachedFunctions(
  start: readonly BehavioralSummary[],
  facts: CallFacts,
): Map<FunctionKey, CallPath> {
  return facts.reachedFrom(start.map((unit) => functionOf(unit)));
}

/** Nearest functions first, so the path shown for a boundary is the shortest one. */
export function shortestFirst(
  paths: ReadonlyMap<FunctionKey, CallPath>,
  facts: CallFacts,
): Array<[FunctionKey, string[], boolean]> {
  return [...paths]
    .map(([fn, path]): [FunctionKey, string[], boolean] => [
      fn,
      hopSpellings(path, facts),
      path.some((hop) => hop.recorded === "possible"),
    ])
    .sort(
      ([, a], [, b]) =>
        a.length - b.length || a.join(" ").localeCompare(b.join(" ")),
    );
}

/** A call that picks its function at run time may never pick the one this path goes through, so the hop says so. */
function hopSpellings(path: CallPath, facts: CallFacts): string[] {
  return path.map((hop) => {
    const picked = hop.to === null ? undefined : facts.units.get(hop.to)?.[0];
    return hop.recorded === "possible" && picked !== undefined
      ? `${hop.callee}, which may run ${picked.identity.name}`
      : hop.callee;
  });
}

function touchKey(touch: TargetTouch): string {
  return `${touch.touched.label} ${touch.touched.relation}`;
}

export function servesItself(touch: TargetTouch): boolean {
  return (
    touch.touched.relation === "provides" &&
    touch.touched.binding === touch.summary.identity.boundaryBinding
  );
}
