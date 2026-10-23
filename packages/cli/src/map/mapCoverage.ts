/**
 * How much of the code suss read: the units in each read, the calls suss
 * could not follow and how many entry points they touch, and the
 * outcomes suss did not read. The counts are over the gaps the summaries
 * record, which `inspect` prints under "Could not follow".
 */

import { unfollowedCalls } from "../ask.js";
import { recordsUnfollowedCall } from "./mapReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { MapCoverage, MapEntry, MapRead } from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

const TOP_UNFOLLOWED = 5;

export function gatherCoverage(
  summaries: readonly BehavioralSummary[],
  entries: readonly MapEntry[],
  reads: readonly MapRead[],
  units: UnitTable,
): MapCoverage {
  const code = summaries.filter((summary) => !units.isSpec(summary));
  const withUnfollowed = code.filter(recordsUnfollowedCall);

  const byCallee = new Map<
    string,
    { count: number; summary: BehavioralSummary }
  >();
  for (const summary of withUnfollowed) {
    for (const gap of summary.gaps) {
      if (gap.type !== "unfollowedCall" || gap.callee === undefined) {
        continue;
      }
      const callee = gap.callee.replace(/\s+/g, " ");
      const seen = byCallee.get(callee) ?? { count: 0, summary };
      seen.count += 1;
      byCallee.set(callee, seen);
    }
  }

  const unitsPerRead = reads.map(() => 0);
  for (const summary of code) {
    const read = units.readIndexOf(summary);
    unitsPerRead[read] = (unitsPerRead[read] ?? 0) + 1;
  }

  return {
    functions: code.length,
    withUnfollowed: withUnfollowed.length,
    unfollowedCalls:
      withUnfollowed.length === 0 ? 0 : unfollowedCalls(withUnfollowed).count,
    topUnfollowed: [...byCallee]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, TOP_UNFOLLOWED)
      .map(([callee, { count, summary }]) => ({
        callee,
        count,
        unit: units.of(summary),
      })),
    entriesAffected: entries.filter((entry) => entry.unfollowed.length > 0)
      .length,
    withUnreadOutcome: code.filter((summary) =>
      summary.gaps.some((gap) => gap.type === "unreadOutcome"),
    ).length,
    unitsPerRead,
  };
}
