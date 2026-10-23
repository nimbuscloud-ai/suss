/**
 * Every table the code touches, with what `ask "what writes <table>"`
 * and `ask "what reads <table>"` list for it.
 *
 * The routes that reach a table come from the entry points' reach. The
 * places that read and write it come from ask, which also counts an
 * access through a relation against the table the relation arrives at.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";

import { unitsAtBoundary } from "../ask.js";
import { boundariesTouchedBy } from "../boundaryReach.js";
import { boundaryOf } from "./mapReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { LoadedSummaries } from "../loadedSummaries.js";
import type { BoundaryTable, MapTable, MapTouch } from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

export function gatherTables(
  loaded: LoadedSummaries,
  units: UnitTable,
  boundaries: BoundaryTable,
): MapTable[] {
  const { summaries } = loaded;
  const tables = new Set<number>();
  for (const summary of summaries) {
    if (units.isSpec(summary)) {
      continue;
    }
    for (const touched of boundariesTouchedBy(summary)) {
      const boundary = boundaryOf(touched);
      if (boundary.category === "table" && touched.relation !== "provides") {
        tables.add(boundaries.of(boundary));
      }
    }
  }

  const byId = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    byId.set(summaryIdentifier(summary), summary);
  }
  const listed = (direction: "reads" | "writes", boundary: number) =>
    touchesAt(direction, boundary, boundaries, loaded, byId, units);

  return [...tables].map((boundary) => ({
    boundary,
    writers: listed("writes", boundary),
    readers: listed("reads", boundary),
  }));
}

interface AnswerItem {
  unit?: string;
  line?: number;
  via?: string;
}

function touchesAt(
  direction: "reads" | "writes",
  boundary: number,
  boundaries: BoundaryTable,
  loaded: LoadedSummaries,
  byId: ReadonlyMap<string, BehavioralSummary>,
  units: UnitTable,
): MapTouch[] {
  const label = boundaries.all()[boundary]?.label ?? "";
  const answer = unitsAtBoundary(direction, label, loaded);
  const touches: MapTouch[] = [];
  for (const item of answer.items as AnswerItem[]) {
    const summary = item.unit === undefined ? undefined : byId.get(item.unit);
    if (summary === undefined) {
      continue;
    }
    touches.push({
      boundary,
      relations: [direction],
      unit: units.of(summary),
      via: item.via ?? null,
      through: [],
      line: null,
    });
  }
  return touches;
}
