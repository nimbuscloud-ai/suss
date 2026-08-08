// corroborateCommand.ts: `suss corroborate` (experimental).
//
// Extract, then execute: run the normal extraction, then run each
// handler's real function in a sandbox against inputs that satisfy
// its own extracted conditions, and write the verdicts back onto the
// summaries (`transition.confidence.corroboration`). The engine and
// its scope live in `corroborate.ts`; this file is the command shell
// around it: source resolution, the human report, and the optional
// annotated-summaries output.

import path from "node:path";

import {
  createProjectWithoutTsconfig,
  createTypeScriptAdapter,
} from "@suss/adapter-typescript";

import { corroborateSummary } from "./corroborate.js";
import { resolveFramework, resolveSource } from "./extract.js";
import { writeJson } from "./jsonStream.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface CorroborateCommandOptions {
  /** Path to the tsconfig covering the code to read. Optional. */
  tsconfig?: string;
  /** Directory to read when no tsconfig is given. Defaults to cwd. */
  dir?: string;
  frameworks: string[];
  /** Write the annotated summaries here instead of discarding them. */
  output?: string;
  /** Verdict-producing executions to aim for per claim. */
  runs?: number;
  /** Sampling attempts per claim before giving up. */
  attempts?: number;
}

interface SummaryReport {
  label: string;
  observed: number;
  refuted: number;
  untested: number;
  counterexamples: unknown[];
}

export interface CorroborateResult {
  summaries: BehavioralSummary[];
  inScope: number;
  refuted: number;
}

function summaryLabel(summary: BehavioralSummary): string {
  const binding = summary.identity.boundaryBinding;
  if (binding !== null && binding.semantics.name === "rest") {
    // A wildcard route serves every method, and an unnamed one gives no
    // method at all. Neither label should start with the gap where a
    // method would go.
    const { method, path } = binding.semantics;
    if (path === null) {
      return summary.identity.name;
    }
    return method === null || method === "*" ? path : `${method} ${path}`;
  }
  return summary.identity.name;
}

function tallySummary(summary: BehavioralSummary): SummaryReport {
  const report: SummaryReport = {
    label: summaryLabel(summary),
    observed: 0,
    refuted: 0,
    untested: 0,
    counterexamples: [],
  };
  for (const transition of summary.transitions) {
    const verdict = transition.confidence?.corroboration;
    if (verdict === undefined) {
      continue;
    }
    if (verdict.outcome === "observed") {
      report.observed += 1;
    }
    if (verdict.outcome === "untested") {
      report.untested += 1;
    }
    if (verdict.outcome === "refuted") {
      report.refuted += 1;
      if (
        verdict.counterexample !== undefined &&
        verdict.counterexample !== null
      ) {
        report.counterexamples.push(verdict.counterexample);
      }
    }
  }
  return report;
}

function formatReport(reports: SummaryReport[], total: number): string {
  const lines: string[] = [];
  if (reports.length === 0) {
    lines.push(
      `None of the ${total} summaries are in scope yet. corroborate currently runs REST handlers from the express and fastify packs, and only checks claims with a literal status code.`,
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `Ran ${reports.length} of ${total} summar${total === 1 ? "y" : "ies"} against their own code.`,
  );
  for (const report of reports) {
    const parts: string[] = [];
    if (report.observed > 0) {
      parts.push(`${report.observed} held`);
    }
    if (report.refuted > 0) {
      parts.push(`${report.refuted} refuted`);
    }
    if (report.untested > 0) {
      parts.push(`${report.untested} untried`);
    }
    const claims = report.observed + report.refuted + report.untested;
    lines.push(
      `  ${report.label}: ${claims} claim${claims === 1 ? "" : "s"}, ${
        parts.length > 0 ? parts.join(", ") : "none with a literal status"
      }`,
    );
    for (const example of report.counterexamples) {
      const detail =
        typeof example === "object" && example !== null
          ? JSON.stringify(example)
          : String(example);
      lines.push(`    counterexample: ${detail}`);
    }
  }

  const refuted = reports.reduce((sum, r) => sum + r.refuted, 0);
  const untested = reports.reduce((sum, r) => sum + r.untested, 0);
  if (refuted > 0) {
    lines.push(
      `${refuted} claim${refuted === 1 ? "" : "s"} did not survive execution. Each counterexample above is a real input; either the extraction is wrong there or the code surprises its own summary.`,
    );
  } else {
    lines.push("Every claim that could be tried held up.");
  }
  if (untested > 0) {
    lines.push(
      "Untried claims need a dependency the sandbox does not have, or an input the sampler did not find. They stay at their static confidence.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Extract the project, corroborate every in-scope summary against the
 * same source, print the report to stdout, and optionally write the
 * annotated summaries. Returns counts so the CLI can pick an exit
 * code (refuted claims fail the run: they are findings).
 */
export async function corroborate(
  options: CorroborateCommandOptions,
): Promise<CorroborateResult> {
  const source = resolveSource(options);
  const packs = await Promise.all(options.frameworks.map(resolveFramework));

  const adapter = createTypeScriptAdapter({
    ...(source.kind === "tsconfig"
      ? { tsConfigFilePath: source.path }
      : { project: createProjectWithoutTsconfig(source.root).project }),
    frameworks: packs,
    // Corroboration re-runs extraction to keep the Project and the
    // summaries in the same session; a cache hit would skip the file
    // loading the sandbox needs.
    cacheDir: null,
  });

  const summaries = await adapter.extractAll();

  const engineOptions = {
    ...(options.runs !== undefined ? { runs: options.runs } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
  };
  const reports: SummaryReport[] = [];
  for (const summary of summaries) {
    const inScope = await corroborateSummary(
      summary,
      adapter.tsProject,
      engineOptions,
    );
    if (inScope) {
      reports.push(tallySummary(summary));
    }
  }

  // Match extract's portability rule: relative paths in anything written.
  for (const summary of summaries) {
    summary.location.file = path.relative(source.root, summary.location.file);
  }

  process.stdout.write(formatReport(reports, summaries.length));

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    await writeJson({ value: summaries, indent: 2, file: outPath });
    process.stderr.write(`Wrote annotated summaries to ${outPath}\n`);
  }

  return {
    summaries,
    inScope: reports.length,
    refuted: reports.reduce((sum, r) => sum + r.refuted, 0),
  };
}
