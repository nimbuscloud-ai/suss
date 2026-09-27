/**
 * Where a reach question ends, worked out from what the user typed.
 *
 * The call facts and the reach rules live in `@suss/checker`, so any
 * caller can ask a reach question. Turning a spelling into target
 * functions goes through the same resolver `--at` uses, which is why it
 * stays with the commands.
 */

import {
  BOUNDARY_ROLE,
  bindingIs,
  boundaryKey,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import { functionOf } from "@suss/checker";

import { resolveTarget, unitsServing } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts, FunctionKey, ReachTarget } from "@suss/checker";
import type { ResolvedTarget, TargetTouch } from "./target.js";

export type SpelledFunctions =
  | {
      found: true;
      target: ReachTarget;
      /** The subject's label in the answer. */
      label: string;
    }
  | { found: false; headline: string };

/**
 * The functions a spelling matches, and the exports they provide. A
 * boundary spelling matches the export itself, so a caller bound to it
 * counts even when no summary provides it. A bare name that matches
 * several functions is rejected, and the headline lists them.
 */
export function functionsSpelled(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
  facts: CallFacts,
): SpelledFunctions {
  const resolution = resolveTarget(spec, summaries);
  if (resolution.matched && resolution.target.kind === "boundary") {
    return {
      found: true,
      target: reachTargetOf(resolution.target),
      label: resolution.target.touches[0]?.touched.label ?? spec,
    };
  }

  const units = resolution.matched
    ? resolution.target.summaries
    : summaries.filter(
        (summary) =>
          summary.identity.name === spec ||
          summary.identity.name.endsWith(`.${spec}`),
      );
  if (units.length === 0) {
    return {
      found: false,
      headline: `No summary here is ${spec}. Spell the unit as a file, a summary id, or its function name.`,
    };
  }

  const target = reachTargetOfUnits(units);
  const byName = !resolution.matched || resolution.target.kind === "summary";
  if (byName && target.functions.length > 1) {
    const candidates = target.functions.map((fn) =>
      summaryIdentifier(representativeUnit(facts, fn)),
    );
    return {
      found: false,
      headline: `${spec} could mean ${target.functions.length} functions here: ${candidates.join(", ")}. Ask about one of them.`,
    };
  }

  return {
    found: true,
    target,
    label:
      target.functions.length === 1
        ? summaryIdentifier(representativeUnit(facts, target.functions[0]))
        : spec,
  };
}

/**
 * Where a reach question ends. A function reaches a boundary by touching
 * it or by calling into the unit that serves it, and reaches a unit by
 * calling it. A caller bound to a function-call boundary is linked by
 * that binding. Any other unit that touches the boundary counts as at it.
 */
export function reachTargetOf(target: ResolvedTarget): ReachTarget {
  if (target.kind !== "boundary") {
    return reachTargetOfUnits(target.summaries);
  }
  return reachTargetOfTouches(target.touches);
}

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
function reachTargetOfUnits(
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
