/**
 * What a unit does at each boundary a summary mentions.
 *
 * How somebody spells a boundary, and whether what they wrote picks one
 * out, is `boundarySpelling.ts` in `@suss/ir-core`, which the intent
 * checker reads too.
 */

import {
  BOUNDARY_ROLE,
  goesThroughRelation,
  OWN_BINDING,
  relationsOf,
} from "@suss/behavioral-ir";
import { displayLabel } from "@suss/ir-core";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { Relation } from "@suss/ir-core";

export { relationsOf } from "@suss/behavioral-ir";
export {
  bindingTokens,
  namesBoundary,
  namesBoundaryExactly,
  spellingTokens,
} from "@suss/ir-core";

export type { Relation } from "@suss/ir-core";

/** How a report writes this boundary, and how somebody types it back. */
export function boundarySpelling(binding: BoundaryBinding): string {
  return displayLabel(binding);
}

export interface TouchedBoundary {
  label: string;
  binding: BoundaryBinding;
  relation: Relation;
  /** The call as the source writes it, when the effect recorded one. */
  callee: string | undefined;
  transitionId: string | undefined;
}

/**
 * Every boundary this unit touches: the one it serves, and one entry
 * per relation for each call site that goes through one. The call sites
 * narrow to the given transitions when a caller asks about part of a
 * unit.
 */
export function boundariesTouchedBy(
  summary: BehavioralSummary,
  transitionIds?: ReadonlySet<string>,
): TouchedBoundary[] {
  const touched: TouchedBoundary[] = [];
  // What a unit does at its own boundary is true of every line in it,
  // so asking about one line still reports it. A unit on the calling
  // side of a boundary is bound to it too, and it reads and writes
  // there the same way a call to a service does.
  const own = summary.identity.boundaryBinding;
  if (own !== null) {
    for (const relation of OWN_BINDING[BOUNDARY_ROLE[summary.kind]]) {
      touched.push({
        label: boundarySpelling(own),
        binding: own,
        relation,
        callee: undefined,
        transitionId: undefined,
      });
    }
  }

  for (const transition of summary.transitions) {
    if (transitionIds !== undefined && !transitionIds.has(transition.id)) {
      continue;
    }
    for (const effect of transition.effects) {
      if (effect.type !== "interaction") {
        continue;
      }
      // Which container an access written under a relation touches
      // comes from the provider's contract, and this walk has one
      // summary.
      if (goesThroughRelation(effect.interaction)) {
        continue;
      }
      for (const relation of relationsOf(effect.interaction)) {
        touched.push({
          label: boundarySpelling(effect.binding),
          binding: effect.binding,
          relation,
          callee: effect.callee,
          transitionId: transition.id,
        });
      }
    }
  }
  return touched;
}
