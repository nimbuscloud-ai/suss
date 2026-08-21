import { summaryIdentifier } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * One line per listed unit that suss could not read all of, so a
 * reader knows where the answer might be missing something.
 */
export function gapCaveats(
  summaries: ReadonlyArray<BehavioralSummary>,
): string[] {
  const withGaps = [...new Set(summaries)].filter(
    (summary) => summary.gaps.length > 0,
  );
  if (withGaps.length === 0) {
    return [];
  }
  return withGaps.map(
    (summary) =>
      `${summaryIdentifier(summary)} records ${summary.gaps.length} thing${summary.gaps.length === 1 ? "" : "s"} suss could not read: ${summary.gaps.map((gap) => gap.description).join("; ")}`,
  );
}
