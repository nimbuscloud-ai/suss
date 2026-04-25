// extract.ts — `suss extract` command implementation

import fs from "node:fs";
import path from "node:path";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

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
  // HTTP client runtimes (consumers).
  fetch: () => import("@suss/runtime-web"),
  axios: () => import("@suss/runtime-axios"),
  // GraphQL consumer hooks / imperative client calls.
  "apollo-client": () => import("@suss/runtime-apollo-client"),
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
  let timingReport: import("@suss/adapter-typescript").TimingReport | null =
    null;
  let cacheDiagnostic:
    | import("@suss/adapter-typescript").CacheDiagnostic
    | null = null;

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

  return summaries;
}

/**
 * One-line cache diagnostic emitted under `--timing`. Reports the
 * three outcomes the cache can produce: full hit, partial hit (some
 * summaries reused, some files re-extracted), or full miss.
 */
export function formatCacheDiagnostic(
  diag: import("@suss/adapter-typescript").CacheDiagnostic,
): string {
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

function formatTimingTotal(
  report: import("@suss/adapter-typescript").TimingReport | null,
): string {
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
function formatTimingBreakdown(
  report: import("@suss/adapter-typescript").TimingReport,
): string {
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
