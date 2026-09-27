/**
 * What a unit does at each boundary its summary mentions.
 *
 * Parsing a boundary the user typed, and deciding whether it matches a
 * binding, happens in `@suss/ir-core` so that the intent checker uses the
 * same rules. This module re-exports those helpers for the CLI.
 */

import {
  BOUNDARY_ROLE,
  goesThroughRelation,
  interactionDetail,
  OWN_BINDING,
  relationsOf,
} from "@suss/behavioral-ir";
import { accessDetail } from "@suss/checker-intent";
import { displayLabel, labelWithDetail } from "@suss/ir-core";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { Relation } from "@suss/ir-core";

export { interactionDetail, relationsOf } from "@suss/behavioral-ir";
export {
  bindingTokens,
  namesBoundary,
  namesBoundaryExactly,
  spellingTokens,
} from "@suss/ir-core";

export type { Relation } from "@suss/ir-core";

/** The label a report prints for this boundary, which a user can also type into a question. */
export function boundarySpelling(binding: BoundaryBinding): string {
  return displayLabel(binding);
}

/**
 * A touch as a report line prints it: the boundary, with the name read
 * across it when the touch read one. The diff and findings print a
 * config read the same way, without the recognizer's package name.
 */
export function touchLabel(
  touch: Pick<TouchedBoundary, "label" | "binding" | "detail">,
): string {
  return touch.detail === undefined
    ? touch.label
    : labelWithDetail(touch.binding, touch.detail);
}

/** What one access states about the columns it touches, empty when it states none. */
export interface Access {
  readonly fields: readonly string[];
  readonly by: readonly string[];
}

export const NO_ACCESS: Access = { fields: [], by: [] };

export interface TouchedBoundary {
  label: string;
  binding: BoundaryBinding;
  relation: Relation;
  /** The call as the source writes it, when the effect recorded one. */
  callee: string | undefined;
  /** Detail the label leaves out; see `interactionDetail`. */
  detail: string | undefined;
  transitionId: string | undefined;
  /** The columns a storage access states. Left out where nobody reads them. */
  access?: Access;
}

/**
 * Every boundary this unit touches: its own boundary, plus one entry per
 * relation for each call site that goes through a boundary. Pass
 * `transitionIds` to count only the call sites on those transitions.
 */
export function boundariesTouchedBy(
  summary: BehavioralSummary,
  transitionIds?: ReadonlySet<string>,
): TouchedBoundary[] {
  const touched: TouchedBoundary[] = [];
  // The unit's own boundary applies to every line in it, so it is reported
  // even when the caller asks about some transitions. A consumer is bound
  // to its boundary too and reads and writes there like a service call.
  const own = summary.identity.boundaryBinding;
  if (own !== null) {
    for (const relation of OWN_BINDING[BOUNDARY_ROLE[summary.kind]]) {
      touched.push({
        label: boundarySpelling(own),
        binding: own,
        relation,
        callee: undefined,
        detail: undefined,
        transitionId: undefined,
        access: NO_ACCESS,
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
      // Only the provider's contract says which container an access
      // through a relation touches, and this function sees one summary.
      if (goesThroughRelation(effect.interaction)) {
        continue;
      }
      for (const relation of relationsOf(effect.interaction)) {
        touched.push({
          label: boundarySpelling(effect.binding),
          binding: effect.binding,
          relation,
          callee: effect.callee,
          detail: interactionDetail(effect.interaction),
          transitionId: transition.id,
          access: accessDetail(effect.interaction),
        });
      }
    }
  }
  return touched;
}
