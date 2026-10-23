/**
 * What each entry point reaches, as `ask "what does <unit> reach"` lists
 * it for the units that serve the entry.
 *
 * ask runs one fixpoint per question, which is too slow for every route
 * of a large project, so this asks the call facts for every entry at
 * once and hands each entry's paths to the same `touchesReached` ask
 * uses. The boundaries come out the same; only the work is shared.
 */

import { functionOf } from "@suss/checker";

import { touchLabel } from "../boundaryReach.js";
import { oneTouchPerCall, touchesOfUnits } from "../target.js";
import { touchesReached } from "../unitReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallPath, FunctionKey } from "@suss/checker";
import type { TouchedBoundary } from "../boundaryReach.js";
import type { LoadedSummaries } from "../loadedSummaries.js";
import type {
  BoundaryCategory,
  BoundaryTable,
  MapBoundary,
  MapEntry,
  MapTouch,
} from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

export function gatherReach(
  entries: readonly MapEntry[],
  servedBy: ReadonlyMap<MapEntry, BehavioralSummary[]>,
  loaded: LoadedSummaries,
  units: UnitTable,
  boundaries: BoundaryTable,
): void {
  const facts = loaded.callFacts;
  const starts = new Set<FunctionKey>();
  for (const entry of entries) {
    for (const summary of servedBy.get(entry) ?? []) {
      starts.add(functionOf(summary));
    }
  }
  const each = facts.reachedFromEach(starts);

  for (const entry of entries) {
    const code = servedBy.get(entry) ?? [];
    const reached = shortestOfAll(
      code.map((summary) => each.get(functionOf(summary))?.functions),
    );
    const touches = oneTouchPerCall(
      touchesReached(touchesOfUnits(code), reached, facts),
    );
    entry.reach = touches.map(
      (touch): MapTouch => ({
        boundary: boundaries.of(boundaryOf(touch.touched)),
        relations: touch.relations,
        unit: units.of(touch.summary),
        via: touch.touched.callee ?? null,
        through: touch.through ?? [],
        line: touch.touched.line ?? null,
      }),
    );

    const onTheWay = [
      ...code,
      ...[...reached.keys()].flatMap((fn) => facts.units.get(fn) ?? []),
    ];
    entry.unfollowed = [
      ...new Set(
        onTheWay.filter(recordsUnfollowedCall).map((s) => units.of(s)),
      ),
    ];
  }
}

export function recordsUnfollowedCall(summary: BehavioralSummary): boolean {
  return summary.gaps.some((gap) => gap.type === "unfollowedCall");
}

/** Every function any of the maps reaches, with the shortest path among them. */
function shortestOfAll(
  maps: ReadonlyArray<ReadonlyMap<FunctionKey, CallPath> | undefined>,
): Map<FunctionKey, CallPath> {
  const merged = new Map<FunctionKey, CallPath>();
  for (const map of maps) {
    for (const [fn, path] of map ?? []) {
      const seen = merged.get(fn);
      if (seen === undefined || path.length < seen.length) {
        merged.set(fn, path);
      }
    }
  }
  return merged;
}

const CATEGORY_OF: Record<string, BoundaryCategory> = {
  storage: "table",
  "runtime-config": "env",
};

/** The boundary a touch is at, as the page lists it. */
export function boundaryOf(touched: TouchedBoundary): MapBoundary {
  const semantics = touched.binding.semantics as Record<string, unknown>;
  const category = CATEGORY_OF[String(semantics.name)] ?? "other";
  return {
    label: touchLabel(touched),
    category,
    name: nameOf(category, semantics, touched),
    system:
      typeof semantics.storageSystem === "string"
        ? semantics.storageSystem
        : null,
  };
}

function nameOf(
  category: BoundaryCategory,
  semantics: Record<string, unknown>,
  touched: TouchedBoundary,
): string {
  if (category === "table" && typeof semantics.container === "string") {
    return semantics.container;
  }
  if (category === "env" && touched.detail !== undefined) {
    return touched.detail;
  }
  return touchLabel(touched);
}
