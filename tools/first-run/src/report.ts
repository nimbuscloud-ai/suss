/**
 * Reduces what the CLI wrote to the counts the scorecard needs. The CLI's
 * own output stays on disk next to the counts, so anything a count leaves
 * out can be read there.
 */

import fs from "node:fs";

export interface SummaryFileCounts {
  project: string;
  verb: string;
  file: string;
  summaries: number;
}

export function summariseSummaryFile(
  file: string,
  project: string,
  verb: string,
): SummaryFileCounts {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const summaries = Array.isArray(parsed) ? parsed.length : 0;
  return { project, verb, file, summaries };
}

export interface CheckCounts {
  paired: number | null;
  total: number | null;
  pairs: number;
  unpairedProviderBoundaries: number;
  unpairedConsumerBoundaries: number;
  unpairable: Record<string, number>;
  findings: Record<string, number>;
  findingsBySeverity: Record<string, number>;
  run: string[];
  summariesWithGaps: number;
}

interface Unmatched {
  key?: string | null;
  reason?: string;
}

interface CheckReport {
  findings?: Array<{ kind?: string; severity?: string }>;
  run?: Array<{ kind?: string }>;
  pairs?: unknown[];
  unmatched?: {
    providers?: Unmatched[];
    consumers?: Unmatched[];
    unpairable?: Unmatched[];
  };
  summariesWithGaps?: number;
}

/** `text` is what the same check printed without --json; its first line has the boundary counts. */
export function summariseCheck(report: CheckReport, text: string): CheckCounts {
  const { paired, total } = boundaryCounts(text);
  return {
    paired,
    total,
    pairs: report.pairs?.length ?? 0,
    unpairedProviderBoundaries: distinctKeys(report.unmatched?.providers ?? []),
    unpairedConsumerBoundaries: distinctKeys(report.unmatched?.consumers ?? []),
    unpairable: tally(
      (report.unmatched?.unpairable ?? []).map(
        (entry) => entry.reason ?? "unknown",
      ),
    ),
    findings: tally(
      (report.findings ?? []).map((finding) => finding.kind ?? "unknown"),
    ),
    findingsBySeverity: tally(
      (report.findings ?? []).map((finding) => finding.severity ?? "unknown"),
    ),
    run: (report.run ?? []).map((finding) => finding.kind ?? "unknown"),
    summariesWithGaps: report.summariesWithGaps ?? 0,
  };
}

const COMPARED = /Compared (\d+) of (\d+) boundar/;
const NOTHING_COMPARED = /Nothing was compared/;
const UNPAIRED_TOTAL = /(\d+) boundar(?:y|ies) had nothing to pair with/;

export function boundaryCounts(text: string): {
  paired: number | null;
  total: number | null;
} {
  const compared = COMPARED.exec(text);
  if (compared?.[1] !== undefined && compared[2] !== undefined) {
    return { paired: Number(compared[1]), total: Number(compared[2]) };
  }

  if (NOTHING_COMPARED.test(text)) {
    const unpaired = UNPAIRED_TOTAL.exec(text)?.[1];
    return { paired: 0, total: unpaired === undefined ? 0 : Number(unpaired) };
  }

  return { paired: null, total: null };
}

function distinctKeys(entries: Unmatched[]): number {
  return new Set(entries.map((entry) => entry.key ?? "")).size;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

export interface DiffCounts {
  changedSummaries: number;
  changedBoundaries: number;
  parsed: boolean;
}

export function summariseDiff(stdout: string): DiffCounts {
  try {
    const parsed = JSON.parse(stdout) as {
      changed?: number;
      boundaries?: unknown[];
    };
    return {
      changedSummaries: parsed.changed ?? 0,
      changedBoundaries: parsed.boundaries?.length ?? 0,
      parsed: true,
    };
  } catch {
    return { changedSummaries: 0, changedBoundaries: 0, parsed: false };
  }
}
