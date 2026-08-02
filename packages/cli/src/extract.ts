// extract.ts — `suss extract` command implementation

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeContentHash,
  createProjectWithoutTsconfig,
  createTypeScriptAdapter,
  findNearestTsconfig,
} from "@suss/adapter-typescript";
import { formatProfile, profileEvaluationAsync } from "@suss/datalog";

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

/**
 * A pack factory takes the options its own package documents, or none.
 * Each pack types its own, so the CLI holds them only as "some
 * options", hands over whatever the config file said, and lets the
 * pack decide what is valid.
 */
type PackFactory = (...args: never[]) => PatternPack;

function instantiatePack(
  factory: PackFactory,
  options: unknown,
  specifier: string,
): PatternPack {
  const pack = (factory as (options?: unknown) => PatternPack)(options);

  // The extraction cache keys on the pack's version stamp, so anything
  // that changes what a pack reads has to reach the stamp. Two of those
  // things are invisible to the pack itself: the config it was handed,
  // and its own code. Almost no pack declares a version, and nothing
  // checks that an author bumped one, so a pack edit would otherwise
  // keep serving summaries the previous code produced.
  const stamp = [
    pack.version ?? "unset",
    packCodeHash(specifier),
    options === undefined ? "" : digest(options),
  ].filter((part) => part.length > 0);
  return { ...pack, version: stamp.join("+") };
}

const packCodeHashes = new Map<string, string>();

/**
 * Content hash of the file a pack was loaded from. Resolution happens
 * from the CLI, which is the package that depends on the packs, and the
 * answer is kept for the rest of the process so a run naming a dozen
 * packs reads each file once.
 *
 * Empty when the specifier does not resolve to a file on disk, which is
 * what a host that bundles its packs looks like. Such a pack falls back
 * to whatever version it declares.
 */
function packCodeHash(specifier: string): string {
  const cached = packCodeHashes.get(specifier);
  if (cached !== undefined) {
    return cached;
  }

  const hash = computeContentHash(resolvePackFile(specifier));
  packCodeHashes.set(specifier, hash);
  return hash;
}

/**
 * The file the pack was imported from. `import.meta.resolve` answers
 * under the same conditions the import used, so a package shipping both
 * an ESM and a CommonJS build gives back the one that ran.
 *
 * A specifier it cannot place yields no file, and the pack falls back to
 * whatever version it declares. Resolving such a specifier some other
 * way would be worse than not resolving it: `createRequire` answers with
 * the CommonJS build, and a stable hash of a file the run never loaded
 * reads as a working cache key while invalidating on nothing.
 */
function resolvePackFile(specifier: string): string[] {
  try {
    return [fileURLToPath(import.meta.resolve(specifier))];
  } catch {
    return [];
  }
}

/**
 * Short content hash of a pack's config, stable across key order so
 * reformatting the file does not throw away a valid cache entry.
 */
function digest(options: unknown): string {
  return createHash("sha256")
    .update(canonicalize(options))
    .digest("hex")
    .slice(0, 12);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

/**
 * The pack names `-f` accepts, each mapped to the package that supplies
 * it. Every `@suss/framework-*` the CLI depends on belongs here under
 * its suffix; a test asserts that, because a pack left out still loads
 * through the dynamic fallback below but never appears in the list the
 * error message prints, so nobody finds out it exists.
 */
export const BUILTIN_FRAMEWORKS: Record<string, string> = {
  // HTTP framework packs (providers).
  "ts-rest": "@suss/framework-ts-rest",
  "react-router": "@suss/framework-react-router",
  express: "@suss/framework-express",
  fastify: "@suss/framework-fastify",
  hono: "@suss/framework-hono",
  // Next.js route handlers, whose route comes from where the file sits.
  nextjs: "@suss/framework-nextjs",
  // React components + event handlers + useEffect bodies.
  react: "@suss/framework-react",
  // GraphQL code-first resolver discovery (Apollo Server).
  apollo: "@suss/framework-apollo",
  // GraphQL resolver discovery via NestJS decorators.
  "nestjs-graphql": "@suss/framework-nestjs-graphql",
  // REST controller discovery via NestJS decorators.
  "nestjs-rest": "@suss/framework-nestjs-rest",
  // AWS Lambda HTTP handlers, paired to SAM/CFN-declared routes.
  "aws-lambda": "@suss/framework-aws-lambda",
  // Storage access, emitted as interactions per read / write.
  prisma: "@suss/framework-prisma",
  drizzle: "@suss/framework-drizzle",
  // Message producers.
  "aws-sqs": "@suss/framework-aws-sqs",
  "aws-eventbridge": "@suss/framework-aws-eventbridge",
  // HTTP client packs (consumers).
  fetch: "@suss/client-web",
  axios: "@suss/client-axios",
  // GraphQL consumer hooks / imperative client calls.
  "apollo-client": "@suss/client-apollo",
  // JS runtime packs.
  node: "@suss/runtime-node",
};

/**
 * Split `-f aws-sqs=packs/sqs.json` into the pack name and the options
 * the file holds. A plain `-f aws-sqs` carries no options.
 *
 * Configuration is per pack because what it says is per pack: a pack
 * that reads a project's own dispatcher needs to be told which one,
 * and no other pack can act on that.
 */
export function parseFrameworkSpec(spec: string): {
  name: string;
  options?: unknown;
} {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    return { name: spec };
  }

  const name = spec.slice(0, separator);
  const configPath = spec.slice(separator + 1);
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No pack config at ${resolved}, named by -f ${name}=${configPath}.`,
    );
  }

  try {
    return { name, options: JSON.parse(fs.readFileSync(resolved, "utf8")) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`The pack config at ${resolved} is not JSON: ${message}`);
  }
}

export async function resolveFramework(spec: string): Promise<PatternPack> {
  const { name, options } = parseFrameworkSpec(spec);

  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    const mod = (await import(builtin)) as { default: PackFactory };
    return instantiatePack(mod.default, options, builtin);
  }

  // A name the record does not carry is taken for a pack published
  // under the family prefix, so someone can ship one without waiting
  // for the CLI to list it.
  const specifier = `@suss/framework-${name}`;
  let mod: { default: PackFactory };
  try {
    mod = (await import(specifier)) as { default: PackFactory };
  } catch {
    throw new Error(
      `Unknown framework: "${name}". Built-in: ${Object.keys(BUILTIN_FRAMEWORKS).join(", ")}`,
    );
  }
  return instantiatePack(mod.default, options, specifier);
}

// ---------------------------------------------------------------------------
// Extract command
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /**
   * Path to the tsconfig covering the code to read. Optional. Without
   * one, the nearest tsconfig or jsconfig above the working directory
   * is used, and the directory itself is read when there is none.
   */
  tsconfig?: string;
  /** Directory to read when no tsconfig is given. Defaults to cwd. */
  dir?: string;
  frameworks: string[];
  files?: string[];
  output?: string;
  gaps?: "strict" | "permissive" | "silent";
  /** Print the per-phase wall-clock breakdown to stderr. */
  timing?: boolean;
  /**
   * Print where datalog evaluation spent the run: time and tuples per
   * rule, tuples per relation, rounds to fixpoint. Off by default, since
   * collecting it costs a timestamp per rule attempt.
   */
  datalogProfile?: boolean;
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

/**
 * Where to read the code from. A tsconfig carries the project's own
 * module resolution and path aliases, so it wins when one exists;
 * otherwise the directory is walked directly.
 */
export type Source =
  | { kind: "tsconfig"; path: string; root: string }
  | { kind: "directory"; root: string };

export function resolveSource(
  options: Pick<ExtractOptions, "tsconfig" | "dir">,
): Source {
  if (options.tsconfig !== undefined) {
    const resolved = path.resolve(options.tsconfig);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `No tsconfig at ${resolved}. Leave -p off to read the current directory instead.`,
      );
    }
    return { kind: "tsconfig", path: resolved, root: path.dirname(resolved) };
  }

  const root = path.resolve(options.dir ?? process.cwd());
  const nearest = findNearestTsconfig(root);
  if (nearest !== null) {
    return { kind: "tsconfig", path: nearest, root: path.dirname(nearest) };
  }
  return { kind: "directory", root };
}

export async function extract(
  options: ExtractOptions,
): Promise<BehavioralSummary[]> {
  const source = resolveSource(options);

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
    ...(source.kind === "tsconfig"
      ? { tsConfigFilePath: source.path }
      : { project: createProjectWithoutTsconfig(source.root).project }),
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

  const runExtraction = (): Promise<BehavioralSummary[]> =>
    options.files !== undefined && options.files.length > 0
      ? adapter.extractFromFiles(options.files.map((f) => path.resolve(f)))
      : adapter.extractAll();

  // Extract
  const profiled =
    options.datalogProfile === true
      ? await profileEvaluationAsync(runExtraction)
      : null;
  const summaries = profiled === null ? await runExtraction() : profiled.result;

  // Make file paths relative to the project root so summaries are portable.
  // Absolute paths leak filesystem structure and break on other machines.
  const projectRoot = source.root;
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
  if (profiled !== null) {
    process.stderr.write(`${formatProfile(profiled.profile)}\n`);
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
