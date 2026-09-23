/**
 * The experimental `suss corroborate` command.
 *
 * It runs the normal extraction, then runs each handler's own function in
 * a sandbox with inputs that satisfy the conditions extracted for it, and
 * writes each verdict onto the summary under
 * `transition.confidence.corroboration`. `corroborateSummary` does the
 * sandboxed runs and decides which summaries are in scope. This module
 * finds the source, prints the report, and writes the annotated summaries
 * when asked.
 */

import path from "node:path";

import {
  createProjectWithoutTsconfig,
  createTypeScriptAdapter,
  workspaceRootFor,
} from "@suss/adapter-typescript";

import { corroborateSummary } from "./corroborate.js";
import {
  relativizeSummaryPaths,
  resolveFramework,
  resolveSource,
} from "./extract.js";
import { writeJson } from "./jsonStream.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface CorroborateCommandOptions {
  tsconfig?: string;
  /** Directory to read when no tsconfig is given. Defaults to cwd. */
  dir?: string;
  frameworks: string[];
  /** Where to write the annotated summaries. Without it they are discarded. */
  output?: string;
  /** How many runs per claim should reach a verdict. */
  runs?: number;
  /** How many inputs to try per claim before giving up. */
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
    // A wildcard route serves every method and some routes have no method,
    // so their labels show the path alone.
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
 * Extracts the project, corroborates every summary in scope against the
 * same source, prints the report to stdout, and writes the annotated
 * summaries when `output` is set. The returned counts let the CLI choose
 * the exit code. A refuted claim is a finding, so it fails the run.
 */
export async function corroborate(
  options: CorroborateCommandOptions,
): Promise<CorroborateResult> {
  const source = resolveSource(options);
  const runRoot = workspaceRootFor(source.root);
  const packs = await Promise.all(
    options.frameworks.map((one) => resolveFramework(one, undefined, runRoot)),
  );

  const adapter = createTypeScriptAdapter({
    ...(source.kind === "tsconfig"
      ? { tsConfigFilePath: source.path }
      : { project: createProjectWithoutTsconfig(source.root).project }),
    projectRoot: runRoot,
    frameworks: packs,
    // The sandbox needs the files loaded into the same Project that
    // produced the summaries, and a cache hit would skip loading them.
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

  // Written summaries use relative paths, the same as `suss extract` writes.
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, runRoot);
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
