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
    throw new Error(
      `No tsconfig at ${tsconfigPath}. Point -p at the tsconfig that covers the code you want read, usually the one your build uses.`,
    );
  }

  if (options.frameworks.length === 0) {
    throw new Error(
      "Pick at least one pack with -f, for example: -f express. Run `suss --help` for the built-in list.",
    );
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
    // An empty run gets its own line. "Wrote 0 summaries" announces an
    // empty file as if it were an accomplishment, and the funnel that
    // follows explains what actually happened.
    process.stderr.write(
      summaries.length === 0
        ? `No summaries to write${formatTimingTotal(timingReport)}.\n`
        : `Wrote ${summaries.length} summar${summaries.length === 1 ? "y" : "ies"} to ${outPath}${formatTimingTotal(timingReport)}\n`,
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

/**
 * What went wrong and what to do about it, per stage. Written to be
 * read by someone who has never opened this codebase: the cause names
 * what suss looked for and did not find, and the next step is
 * something they can act on without knowing how extraction works.
 *
 * Each entry reads the counts so it can be specific. "102 files import
 * @apollo/client and the package is missing" tells a user what to do;
 * "a gate specifier did not resolve" does not.
 */
const EMPTY_STAGE_COPY: Record<
  EmptyStage,
  (report: ExtractionReport) => { cause: string; next: string }
> = {
  tsconfig: () => ({
    cause: "That tsconfig matched no source files.",
    next: "Check its `include` and `files` patterns against where your source actually lives.",
  }),
  gateResolution: (report) => {
    const blocked = report.packs.filter((p) => p.unresolvedGates.length > 0);
    const missing = [...new Set(blocked.flatMap((p) => p.unresolvedGates))];
    const files = blocked.reduce((sum, p) => sum + p.candidateFiles, 0);
    return {
      cause: `${files} ${files === 1 ? "file imports" : "files import"} ${listOf(missing)}, but ${missing.length === 1 ? "that package is" : "those packages are"} not installed here, so suss cannot see what those calls do.`,
      next: "Install this project's dependencies, then run the command again.",
    };
  },
  candidateFiles: (report) => ({
    cause: `No file imports anything ${listOf(report.packs.map((p) => p.pack))} looks for.`,
    next: "Either this project does not use it, or your code reaches it through a local wrapper module. suss only recognizes direct imports today.",
  }),
  discovery: (report) => ({
    cause: `suss read ${report.filesWalked} ${report.filesWalked === 1 ? "file" : "files"} but recognized no boundaries in them.`,
    next: "Your code probably declares its boundaries in a shape this pack does not describe yet. Worth opening an issue with an example.",
  }),
  assembly: (report) => ({
    cause: `suss recognized ${totalUnits(report)} boundaries but built no summaries from them.`,
    next: "That is a bug in suss. Please open an issue with the code shape that triggered it.",
  }),
};

function totalUnits(report: ExtractionReport): number {
  return report.packs.reduce((sum, p) => sum + p.unitsDiscovered, 0);
}

function listOf(items: ReadonlyArray<string>): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Show where the summaries came from, or where the count reached zero.
 *
 * Leads with the outcome and the next step, then the numbers as
 * supporting evidence, because someone reading this wants to know what
 * to do before they want to know how many files were walked.
 */
export function formatExtractionReport(report: ExtractionReport): string {
  const lines: string[] = [];

  if (report.emptyStage !== null) {
    const { cause, next } = EMPTY_STAGE_COPY[report.emptyStage](report);
    lines.push(`  ${cause}`);
    lines.push(`  ${next}`);
    lines.push("");
    lines.push("  Where it stopped:");
  } else {
    lines.push("  Where these came from:");
  }

  const rows: Array<[number, string]> = [];
  if (report.filesInProject !== null) {
    rows.push([report.filesInProject, "files in the tsconfig"]);
  }
  rows.push([report.filesWalked, "files read"]);

  for (const pack of report.packs) {
    const imports =
      pack.gates.length > 0
        ? `files importing ${listOf(pack.gates)}`
        : `files ${pack.pack} looked at`;
    rows.push([pack.candidateFiles, imports]);
    rows.push([pack.unitsDiscovered, `boundaries recognized by ${pack.pack}`]);
    rows.push([pack.summariesProduced, `summaries from ${pack.pack}`]);
  }

  const width = Math.max(...rows.map(([count]) => String(count).length));
  for (const [count, label] of rows) {
    lines.push(`    ${String(count).padStart(width)}  ${label}`);
  }

  // A dependency suss could not resolve while the pack still produced
  // summaries is worth a note but not an alarm: packs that match on
  // import text keep working, they only lose type information.
  const degraded = report.packs.filter(
    (p) => p.unresolvedGates.length > 0 && p.summariesProduced > 0,
  );
  for (const pack of degraded) {
    lines.push("");
    const packages = listOf(pack.unresolvedGates.map((g) => `\`${g}\``));
    lines.push(
      `  Note: ${packages} ${pack.unresolvedGates.length === 1 ? "is" : "are"} not installed here, so the ${pack.pack} pack matched on import names alone. Installing dependencies may produce more detail.`,
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
