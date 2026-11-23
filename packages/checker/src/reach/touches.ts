import { BOUNDARY_ROLE, boundaryKey } from "@suss/behavioral-ir";

import { boundariesTouchedBy, type TouchedBoundary } from "./boundaryReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** A unit the target picked out, and what it does at one boundary. */
export interface TargetTouch {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
  /**
   * The calls from the unit the user asked about to this one. Set only
   * when the touch was found by following calls out of that unit.
   */
  through?: string[];
  /** Set when one of those calls picks its function at run time and may pick another. */
  possible?: true;
}

/**
 * What the given units do at every boundary they touch. For a boundary
 * target this list is wider than the target's own touches, which only
 * cover the boundary the user asked about.
 */
export function touchesOfUnits(
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetTouch[] {
  return touchesOf(summaries);
}

/**
 * The units that provide the boundary. A question about a boundary
 * follows calls out of these units only. A client of the boundary calls
 * into it, so what the client calls afterwards is not downstream of it.
 */
export function unitsServing(
  touches: ReadonlyArray<TargetTouch>,
): BehavioralSummary[] {
  return [
    ...new Set(
      touches
        .filter((touch) => touch.touched.relation === "provides")
        .map((touch) => touch.summary),
    ),
  ];
}

/**
 * The boundary key a provider unit serves on its own binding. Returns
 * undefined for any other unit, so an answer item can leave the field
 * out.
 */
export function providesKeyOf(summary: BehavioralSummary): string | undefined {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
    return undefined;
  }
  return boundaryKey(binding) ?? undefined;
}

export function touchesOf(
  summaries: ReadonlyArray<BehavioralSummary>,
  transitionIds?: ReadonlySet<string>,
): TargetTouch[] {
  return summaries.flatMap((summary) =>
    boundariesTouchedBy(summary, transitionIds).map((touched) => ({
      summary,
      touched,
    })),
  );
}
