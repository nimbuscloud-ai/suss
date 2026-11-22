/**
 * Where a reach question ends, for a set of units or a boundary's
 * touches, and the summary an answer prints for a function.
 */

import { BOUNDARY_ROLE, bindingIs, boundaryKey } from "@suss/behavioral-ir";

import { functionOf } from "../calls/callFacts.js";
import { unitsServing } from "./touches.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  CallFacts,
  FunctionKey,
  ReachTarget,
} from "../calls/callFacts.js";
import type { TargetTouch } from "./touches.js";

/** The reach target for a boundary, given every touch on it. */
export function reachTargetOfTouches(
  touches: ReadonlyArray<TargetTouch>,
): ReachTarget {
  const providers = new Set(unitsServing(touches));
  const keys = new Set<string>();
  const at = new Set<FunctionKey>();
  for (const touch of touches) {
    const binding = touch.touched.binding;
    const key = boundaryKey(binding);
    if (key !== null) {
      keys.add(key);
    }
    if (providers.has(touch.summary)) {
      continue;
    }
    const placedByBinding =
      binding === touch.summary.identity.boundaryBinding &&
      bindingIs(binding, "function-call") &&
      key !== null;
    if (!placedByBinding) {
      at.add(functionOf(touch.summary));
    }
  }
  return {
    functions: [...new Set([...providers].map((unit) => functionOf(unit)))],
    keys: [...keys],
    at: [...at],
  };
}

/** The reach target for some units: their functions, and the exports they provide. */
export function reachTargetOfUnits(
  units: ReadonlyArray<BehavioralSummary>,
): ReachTarget {
  const keys = new Set<string>();
  for (const unit of units) {
    const binding = unit.identity.boundaryBinding;
    if (
      BOUNDARY_ROLE[unit.kind] === "provider" &&
      bindingIs(binding, "function-call")
    ) {
      const key = boundaryKey(binding);
      if (key !== null) {
        keys.add(key);
      }
    }
  }
  return {
    functions: [...new Set(units.map((unit) => functionOf(unit)))],
    keys: [...keys],
  };
}

/**
 * The summary an answer prints for a function. That is the provider
 * summary when there is one, because callers refer to the function by
 * that id, and otherwise the first summary the run wrote.
 */
export function representativeUnit(
  facts: CallFacts,
  fn: FunctionKey,
): BehavioralSummary {
  const units = facts.units.get(fn) ?? [];
  const provider = units.find(
    (unit) =>
      BOUNDARY_ROLE[unit.kind] === "provider" &&
      unit.identity.boundaryBinding !== null,
  );
  const chosen = provider ?? units[0];
  if (chosen === undefined) {
    throw new Error(`no summary for function ${fn}`);
  }
  return chosen;
}
