// extract.ts — `suss extract` command implementation

import fs from "node:fs";
import path from "node:path";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import type {
  CacheDiagnostic,
  EmptyStage,
  ExtractionReport,
  TimingReport,
} from "@suss/adapter-typescript";
import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Framework pack resolution
// ---------------------------------------------------------------------------

const BUILTIN_FRAMEWORKS: Record<
  string,
  () => Promise<{ default: () => PatternPack }>
> = {
  // HTTP framework packs (providers).
  "ts-rest": () => import("@suss/framework-ts-rest"),
  "react-router": () => import("@suss/framework-react-router"),
  express: () => import("@suss/framework-express"),
  fastify: () => import("@suss/framework-fastify"),
  // React components + event handlers + useEffect bodies.
  react: () => import("@suss/framework-react"),
  // GraphQL code-first resolver discovery (Apollo Server).
  apollo: () => import("@suss/framework-apollo"),
  // GraphQL resolver discovery via NestJS decorators.
  "nestjs-graphql": () => import("@suss/framework-nestjs-graphql"),
  // REST controller discovery via NestJS decorators.
  "nestjs-rest": () => import("@suss/framework-nestjs-rest"),
  // AWS Lambda HTTP handlers, paired to SAM/CFN-declared routes.
  "aws-lambda": () => import("@suss/framework-aws-lambda"),
  // HTTP client packs (consumers).
  fetch: () => import("@suss/client-web"),
  axios: () => import("@suss/client-axios"),
  // GraphQL consumer hooks / imperative client calls.
  "apollo-client": () => import("@suss/client-apollo"),
  // JS runtime packs.
  node: () => import("@suss/runtime-node"),
};

async function resolveFramework(name: string): Promise<PatternPack> {
  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    const mod = await builtin();
    return mod.default();
  }

  // Try dynamic import for custom framework packs
  try {
    const mod = (await import(`@suss/framework-${name}`)) as {
      default: () => PatternPack;
    };
    return mod.default();
  } catch {
    throw new Error(
      `Unknown framework: "${name}". Built-in: ${Object.keys(BUILTIN_FRAMEWORKS).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Extract command
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  tsconfig: string;
  frameworks: string[];
  files?: string[];
  output?: string;
  gaps?: "strict" | "permissive" | "silent";
  /** Print the per-phase wall-clock breakdown to stderr. */
  timing?: boolean;
  /**
   * Skip the on-disk extraction cache for this run. Mostly useful
   * for debugging when cache invalidation isn't keeping up with
   * intentional changes — normal runs benefit from the cache.
   */
  noCache?: boolean;
  /**
   * Print the extraction funnel even when the run produced summaries.
   * A run that produced nothing prints it either way.
   */
  explain?: boolean;
  /**
   * Exit non-zero when the run produces no summaries. Off by default,
   * since a project may legitimately have no boundaries. Worth turning
   * on in CI, where a silent zero looks identical to a passing check.
   */
  failOnEmpty?: boolean;
}

export async function extract(
  options: ExtractOptions,
): Promise<BehavioralSummary[]> {
  const tsconfigPath = path.resolve(options.tsconfig);

  if (!fs.existsSync(tsconfigPath)) {
    throw new Error(`tsconfig not found: ${tsconfigPath}`);
  }

  if (options.frameworks.length === 0) {
    throw new Error("At least one framework (-f) is required");
  }

  // Resolve all framework packs
  const packs = await Promise.all(options.frameworks.map(resolveFramework));

  // Build extractor options
  const extractorOptions =
    options.gaps !== undefined ? { gapHandling: options.gaps } : undefined;

  // Wall-clock breakdown of the extract pipeline. `--timing` swaps the
  // one-line summary for the per-phase view. The cost of always-on
  // instrumentation is one `performance.now()` per phase entry — well
  // under the noise floor of a real extraction.
  let timingReport: TimingReport | null = null;
  let cacheDiagnostic: CacheDiagnostic | null = null;
  let extractionReport: ExtractionReport | null = null;

  // Create adapter
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: tsconfigPath,
    frameworks: packs,
    ...(extractorOptions !== undefined ? { extractorOptions } : {}),
    ...(options.noCache === true ? { cacheDir: null } : {}),
    onTiming: (report) => {
      timingReport = report;
    },
    onCacheDiagnostic: (diag) => {
      cacheDiagnostic = diag;
    },
    onExtractionReport: (report) => {
      extractionReport = report;
    },
  });

  // Extract
  const summaries =
    options.files !== undefined && options.files.length > 0
      ? await adapter.extractFromFiles(
          options.files.map((f) => path.resolve(f)),
        )
      : await adapter.extractAll();

  // Make file paths relative to the project root so summaries are portable.
  // Absolute paths leak filesystem structure and break on other machines.
  const projectRoot = path.dirname(tsconfigPath);
  for (const summary of summaries) {
    summary.location.file = path.relative(projectRoot, summary.location.file);
  }

  // Output
  const json = JSON.stringify(summaries, null, 2);

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
    process.stderr.write(
      `Wrote ${summaries.length} summaries to ${outPath}${formatTimingTotal(timingReport)}\n`,
    );
  } else {
    process.stdout.write(`${json}\n`);
  }

  if (options.timing === true && timingReport !== null) {
    process.stderr.write(formatTimingBreakdown(timingReport));
  }
  if (options.timing === true && cacheDiagnostic !== null) {
    process.stderr.write(formatCacheDiagnostic(cacheDiagnostic));
  }

  // A run that found nothing is the failure worth explaining. Print the
  // funnel unprompted in that case, since the user has no other way to
  // tell "this project has no boundaries" from "the packs never got to
  // look at it". `--explain` prints it either way.
  if (extractionReport !== null) {
    const report = extractionReport as ExtractionReport;
    if (options.explain === true || report.summaries === 0) {
      process.stderr.write(formatExtractionReport(report));
    }
  }

  if (options.failOnEmpty === true && summaries.length === 0) {
    process.stderr.write(
      "Failing because the extract produced no summaries (--fail-on-empty).\n",
    );
    process.exitCode = 1;
  }

  return summaries;
}

/** What each empty stage means, and what the user should do about it. */
const EMPTY_STAGE_EXPLANATION: Record<EmptyStage, string> = {
  tsconfig:
    "The tsconfig matched no files. Check its `include` and `files` against where your source actually lives.",
  gateResolution:
    "A pack's gate specifier does not resolve from this tsconfig, listed below. Packs that rely on type information find nothing when the dependency is missing, so install the project's dependencies and re-run.",
  candidateFiles:
    "No file imported anything the active packs gate on. Either the project does not use these frameworks, or it reaches them through a local wrapper module rather than importing them directly.",
  discovery:
    "The packs saw candidate files but recognized no units in them. The code likely expresses its boundaries in a shape the pack does not describe yet.",
  assembly:
    "Units were discovered but none produced a summary. This is a bug worth reporting, with the source shape that triggered it.",
};

/**
 * Render the funnel. Every row is a count produced by the stage that
 * owns it, so the reader can see which stage the count died at rather
 * than inferring it from a single "0 summaries" line.
 */
export function formatExtractionReport(report: ExtractionReport): string {
  const lines: string[] = [];
  lines.push("  extraction funnel:");
  if (report.filesInProject !== null) {
    lines.push(`    files in tsconfig:  ${report.filesInProject}`);
  }
  lines.push(`    files walked:       ${report.filesWalked}`);

  for (const pack of report.packs) {
    const gate =
      pack.gates.length > 0 ? pack.gates.join(", ") : "(applies to every file)";
    lines.push(`    pack ${pack.pack}:`);
    lines.push(`      gate:             ${gate}`);
    if (pack.unresolvedGates.length > 0) {
      // A gate that does not resolve is only a problem when the pack
      // also found nothing. Packs that match on import text alone work
      // fine against an uninstalled dependency, and calling that out as
      // a failure on a run that produced summaries would be noise.
      const hint =
        pack.summariesProduced === 0
          ? " (dependency not installed?)"
          : " (matched on import text; type information unavailable)";
      lines.push(
        `      unresolved:       ${pack.unresolvedGates.join(", ")}${hint}`,
      );
    }
    lines.push(`      candidate files:  ${pack.candidateFiles}`);
    lines.push(`      units discovered: ${pack.unitsDiscovered}`);
    lines.push(`      summaries:        ${pack.summariesProduced}`);
  }

  if (report.emptyStage !== null) {
    lines.push("");
    lines.push(
      `  Nothing was produced. ${EMPTY_STAGE_EXPLANATION[report.emptyStage]}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * One-line cache diagnostic emitted under `--timing`. Reports the
 * three outcomes the cache can produce: full hit, partial hit (some
 * summaries reused, some files re-extracted), or full miss.
 */
export function formatCacheDiagnostic(diag: CacheDiagnostic): string {
  if (diag.kind === "hit") {
    return "  cache: hit (returned all summaries from manifest)\n";
  }
  if (diag.kind === "partial-hit" && diag.partial !== undefined) {
    const p = diag.partial;
    const churn = [
      p.changedFiles > 0 ? `${p.changedFiles} changed` : null,
      p.addedFiles > 0 ? `${p.addedFiles} added` : null,
      p.removedFiles > 0 ? `${p.removedFiles} removed` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    return `  cache: partial-hit (${churn}) — reused ${p.reusedSummaries} summaries, re-extracted ${p.filesToReExtract} files\n`;
  }
  return `  cache: miss (${diag.missReason ?? "unknown"})\n`;
}

function formatTimingTotal(report: TimingReport | null): string {
  if (report === null) {
    return "";
  }
  return ` in ${(report.totalMs / 1000).toFixed(2)}s`;
}

/**
 * Per-phase breakdown emitted under `--timing`. Sorted by wall time
 * descending (the timer's natural order). Indented under the
 * `Timing:` header so it reads as a sub-block of the extract
 * acknowledgment line.
 */
function formatTimingBreakdown(report: TimingReport): string {
  const lines: string[] = ["Timing:"];
  for (const phase of report.phases) {
    const ms = phase.durationMs.toFixed(0).padStart(6);
    const pct = ((phase.durationMs / report.totalMs) * 100)
      .toFixed(1)
      .padStart(5);
    const calls = phase.calls > 1 ? ` (${phase.calls} calls)` : "";
    lines.push(`  ${ms}ms  ${pct}%  ${phase.label}${calls}`);
  }
  lines.push(`  ${report.totalMs.toFixed(0).padStart(6)}ms  100.0%  total`);
  return `${lines.join("\n")}\n`;
}
