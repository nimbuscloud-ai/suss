/**
 * declaredDelivery.ts: give a deployed code unit the boundary a
 * declaration says delivers to it.
 *
 * A queue consumer arrives as two summaries with half of it each. The
 * code says what the handler does with a message and cannot say which
 * queue delivers it, because a SAM template decides that. The
 * template's summary says which queue and knows nothing about the
 * handler's branches. Both give the same deployable unit, which is what
 * puts them back together. Anything that reads summaries by boundary
 * key needs this join before it looks.
 */

import { boundaryKey } from "@suss/ir-core";

import type {
  BehavioralSummary,
  BoundaryBinding,
  DeployableUnit,
  Semantics,
} from "./index.js";

/** Whether two units refer to the same thing to deploy. */
export function sameUnit(a: DeployableUnit, b: DeployableUnit): boolean {
  return (
    a.deploymentTarget === b.deploymentTarget &&
    a.instanceName === b.instanceName
  );
}

function unitKey(unit: DeployableUnit): string {
  return `${unit.deploymentTarget} ${unit.instanceName}`;
}

/**
 * The declaration's boundary where this one left a blank, or null when
 * there is nothing to take. A field the code did state and the
 * declaration disagrees with stops the merge: the two are describing
 * different boundaries, and a value nobody wrote is worse than a gap.
 */
function filledFrom(mine: Semantics, theirs: Semantics): Semantics | null {
  if (mine.name !== theirs.name) {
    return null;
  }
  const merged: Record<string, unknown> = { ...mine };
  let took = false;
  for (const [field, value] of Object.entries(theirs)) {
    if (merged[field] === value) {
      continue;
    }
    if (merged[field] !== null) {
      return null;
    }
    merged[field] = value;
    took = true;
  }
  return took ? (merged as Semantics) : null;
}

/**
 * What each deployed unit is declared to receive. A unit two
 * declarations disagree about is left out: nothing here can pick
 * between two queues feeding one Lambda, and a guess would file a
 * handler's behaviour under a boundary it may never receive from.
 */
function declaredByUnit(
  summaries: readonly BehavioralSummary[],
): Map<string, BoundaryBinding | null> {
  const found = new Map<string, BoundaryBinding | null>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    const unit = summary.identity.deployableUnit;
    if (
      summary.kind !== "consumer" ||
      summary.confidence.source !== "declared" ||
      binding == null ||
      unit === undefined
    ) {
      continue;
    }
    const key = unitKey(unit);
    const seen = found.get(key);
    if (seen === undefined) {
      found.set(key, binding);
      continue;
    }
    if (seen === null || boundaryKey(seen) !== boundaryKey(binding)) {
      found.set(key, null);
    }
  }
  return found;
}

/**
 * The same summaries, with a unit's boundary filled in from the
 * declaration that says what reaches it. A summary that can already be
 * keyed keeps what it has: a consumer built by a factory that states
 * its subject has said something the template cannot, and it is the
 * more specific answer.
 */
export function withDeclaredDelivery(
  summaries: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const declared = declaredByUnit(summaries);
  if (declared.size === 0) {
    return [...summaries];
  }

  return summaries.map((summary) => {
    const binding = summary.identity.boundaryBinding;
    const unit = summary.identity.deployableUnit;
    if (
      binding == null ||
      unit === undefined ||
      boundaryKey(binding) !== null
    ) {
      return summary;
    }
    const from = declared.get(unitKey(unit));
    if (from == null) {
      return summary;
    }
    const semantics = filledFrom(binding.semantics, from.semantics);
    if (semantics === null) {
      return summary;
    }
    return {
      ...summary,
      identity: {
        ...summary.identity,
        boundaryBinding: { ...binding, semantics },
      },
    };
  });
}
