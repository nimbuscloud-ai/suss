/**
 * Gap warnings under an answer, one `warning:` line per unit in the
 * compiler's file:line format, so a reader knows where the answer
 * might be missing something without wading through prose. The full
 * gap records stay in --json.
 */

import type { BehavioralSummary, Gap } from "@suss/behavioral-ir";

const MOST_WARNINGS = 8;

const phraseOf: Record<Gap["type"], (gap: Gap) => string> = {
  unfollowedCall: (gap) =>
    gap.callee !== undefined
      ? `unfollowed call to ${gap.callee}`
      : "an unfollowed call",
  unreadOutcome: () => "an outcome this run did not read",
  unhandledCase: () => "an unhandled case",
};

function warningLine(summary: BehavioralSummary): string {
  const phrases = [
    ...new Set(summary.gaps.map((gap) => phraseOf[gap.type](gap))),
  ];
  const where = `${summary.location.file}:${summary.location.range.start}`;
  return `warning: ${where} ${summary.identity.name}: ${phrases.join(", ")}`;
}

export function gapCaveats(
  summaries: ReadonlyArray<BehavioralSummary>,
): string[] {
  const withGaps = [...new Set(summaries)].filter(
    (summary) => summary.gaps.length > 0,
  );
  if (withGaps.length === 0) {
    return [];
  }

  const lines = withGaps.map(warningLine);
  if (lines.length <= MOST_WARNINGS) {
    return lines;
  }
  const hidden = lines.length - MOST_WARNINGS;
  return [
    ...lines.slice(0, MOST_WARNINGS),
    `warning: ${hidden} more unit${hidden === 1 ? "" : "s"} record gaps. Run with --json to see every gap.`,
  ];
}
