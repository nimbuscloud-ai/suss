/**
 * Every place the code reads an environment variable, and whether it
 * gives a value to use when the variable is not set. These are the
 * `config-read` effects in the summaries, one per unit, variable and
 * default, however many paths through the unit repeat the read.
 */

import { boundarySpelling } from "../boundaryReach.js";
import { boundaryOf } from "./mapReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { BoundaryTable, MapEnvRead } from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

export function gatherEnvReads(
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
  boundaries: BoundaryTable,
): MapEnvRead[] {
  const reads: MapEnvRead[] = [];
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (units.isSpec(summary)) {
      continue;
    }
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        // A helper that reads a name it is handed doesn't record a name of
        // its own, and each call to it records the variable it passes.
        if (
          effect.type !== "interaction" ||
          effect.interaction.class !== "config-read" ||
          effect.interaction.name === null
        ) {
          continue;
        }
        const boundary = boundaries.of(
          boundaryOf({
            label: boundarySpelling(effect.binding),
            binding: effect.binding,
            relation: "reads",
            callee: effect.callee,
            detail: effect.interaction.name,
            transitionId: transition.id,
          }),
        );
        const unit = units.of(summary);
        const defaulted = effect.interaction.defaulted;
        const key = `${boundary} ${unit} ${defaulted}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        reads.push({ boundary, unit, defaulted });
      }
    }
  }
  return reads;
}
