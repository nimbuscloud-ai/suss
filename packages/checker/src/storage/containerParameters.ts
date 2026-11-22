import { bindingIs } from "@suss/behavioral-ir";
import { referenceFromName } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The parameters a unit's storage accesses take their container from.
 * A container written as a reference, `{location.table}`, is looked up
 * from the parameter the reference starts at, so a caller that passes
 * that parameter picks the table.
 */
export function containerParametersOf(summary: BehavioralSummary): string[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) => {
      if (
        effect.type !== "interaction" ||
        !bindingIs(effect.binding, "storage")
      ) {
        return [];
      }
      const container = effect.binding.semantics.container;
      const reference =
        container === null ? null : referenceFromName(container);
      return reference === null ? [] : [reference.root];
    }),
  );
}
