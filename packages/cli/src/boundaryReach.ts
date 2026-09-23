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
  OWN_BINDING,
  relationsOf,
} from "@suss/behavioral-ir";
import { displayLabel } from "@suss/ir-core";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Interaction,
} from "@suss/behavioral-ir";
import type { Relation } from "@suss/ir-core";

export { relationsOf } from "@suss/behavioral-ir";
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
 * Detail about an effect that the boundary label leaves out. A store's
 * label already includes the container, but the label of a config or
 * metadata read only identifies the recognizer, so the detail is the name
 * that was read.
 */
export function interactionDetail(
  interaction: Interaction,
): string | undefined {
  if (
    interaction.class === "config-read" ||
    interaction.class === "metadata-read"
  ) {
    return interaction.name;
  }
  return undefined;
}

export interface TouchedBoundary {
  label: string;
  binding: BoundaryBinding;
  relation: Relation;
  /** The call as the source writes it, when the effect recorded one. */
  callee: string | undefined;
  /** Detail the label leaves out; see `interactionDetail`. */
  detail: string | undefined;
  transitionId: string | undefined;
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
        });
      }
    }
  }
  return touched;
}
