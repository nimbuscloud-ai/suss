/**
 * Prints one Markdown row per repository from the results a run wrote,
 * with the measured columns of the scorecard. Grades and the reasons for
 * them come from reading the output and the code, so they are left out.
 *
 *   npx tsx tools/first-run/src/table.ts --work <dir>
 */

import fs from "node:fs";
import path from "node:path";

interface StoredResult {
  name: string;
  stack: string;
  installed: boolean;
  outcome: string;
  peakRssBytes: number | null;
  check: {
    paired: number | null;
    total: number | null;
    unpairedProviderBoundaries: number;
    unpairedConsumerBoundaries: number;
    findings: Record<string, number>;
    run: string[];
  } | null;
  diff: { changedSummaries: number; parsed: boolean } | null;
  summaries: Array<{ summaries: number }>;
  steps: Array<{
    step: string;
    exitCode: number | null;
    timedOut: boolean;
    wallMs: number;
  }>;
  errors: string[];
}

function main(): void {
  const at = process.argv.indexOf("--work");
  const work = process.argv[at + 1];
  if (at < 0 || work === undefined) {
    throw new Error("usage: table.ts --work <dir>");
  }

  const resultsDir = path.join(work, "results");
  const rows = fs
    .readdirSync(resultsDir)
    .map((name) => path.join(resultsDir, name, "result.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as StoredResult);
  console.log(
    "| repo | stack | deps | outcome | suss time | peak | summaries | paired / total | unpaired providers / consumers | findings | failed steps |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function formatRow(row: StoredResult): string {
  const summaries = row.summaries.reduce(
    (sum, file) => sum + file.summaries,
    0,
  );
  const check = row.check;
  const paired =
    check === null ? "none" : `${check.paired ?? "?"} / ${check.total ?? "?"}`;
  const unpaired =
    check === null
      ? ""
      : `${check.unpairedProviderBoundaries} / ${check.unpairedConsumerBoundaries}`;
  const findings = check === null ? "" : formatTally(check.findings);
  const failed = row.steps
    .filter((step) => step.exitCode !== 0 && !step.step.startsWith("check"))
    .map((step) => (step.timedOut ? `${step.step} (timeout)` : step.step));
  return [
    row.name,
    row.stack,
    row.installed ? "installed" : "not installed",
    row.outcome,
    `${Math.round(sussMs(row) / 1000)}s`,
    row.peakRssBytes === null
      ? ""
      : `${Math.round(row.peakRssBytes / 1_048_576)} MB`,
    String(summaries),
    paired,
    unpaired,
    findings,
    failed.join(", "),
  ]
    .map((cell) => cell.replaceAll("|", "/"))
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

/** Time spent in suss itself. The clone and the install are not counted. */
function sussMs(row: StoredResult): number {
  return row.steps
    .filter((step) => step.step !== "install")
    .reduce((sum, step) => sum + step.wallMs, 0);
}

function formatTally(tally: Record<string, number>): string {
  return Object.entries(tally)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

main();
