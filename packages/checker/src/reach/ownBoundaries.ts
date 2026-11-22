import { providesKeyOf, touchesOfUnits } from "./touches.js";
import { servesItself } from "./unitReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts, FunctionKey } from "../calls/callFacts.js";
import type { TargetTouch } from "./touches.js";

/** The boundaries a function serves, one per summary of it that serves one. */
export function ownBoundariesOf(
  facts: CallFacts,
  fn: FunctionKey,
): TargetTouch[] {
  return touchesOfUnits(facts.units.get(fn) ?? []).filter(
    (touch) =>
      (servesItself(touch) || consumesItsChannel(touch)) &&
      !reachedOnTheWay(touch.summary),
  );
}

/**
 * A job or queue consumer runs on each message that arrives on its own
 * channel, so the channel behaves differently when what it calls changes.
 */
function consumesItsChannel(touch: TargetTouch): boolean {
  return (
    touch.summary.kind === "consumer" &&
    touch.touched.binding === touch.summary.identity.boundaryBinding
  );
}

/**
 * A library function the walk reached from something else. Its binding
 * addresses nothing, so it serves no boundary of its own, where a
 * package's export has a key that a caller in another package uses.
 */
function reachedOnTheWay(summary: BehavioralSummary): boolean {
  return summary.kind === "library" && providesKeyOf(summary) === undefined;
}
