import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import {
  computeContentHash,
  createProjectWithoutTsconfig,
  createTypeScriptAdapter,
  evaluatePackHealth,
  findNearestTsconfig,
  formatPackHealth,
  workspaceRootFor,
} from "@suss/adapter-typescript";
import { SUMMARY_SCHEMA_VERSION } from "@suss/behavioral-ir";
import { formatProfile, profileEvaluationAsync } from "@suss/datalog";

import { renderDiagnosis } from "./diagnosis.js";
import {
  filesOutsideNestedRepositories,
  formatMissingSubmodules,
  readSubmodules,
} from "./gitSubmodules.js";
import { writeJson } from "./jsonStream.js";
import { LANGUAGE_LABEL, languageOfProject } from "./language.js";
import { checkOneTsMorph, formatSecondCopies } from "./oneTsMorph.js";
import { UsageError } from "./usageError.js";

import type { PythonPack } from "@suss/adapter-python";
import type { RubyPack } from "@suss/adapter-ruby";
import type {
  CacheDiagnostic,
  EmptyStage,
  ExtractionReport,
  TimingReport,
} from "@suss/adapter-typescript";
import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Diagnosis } from "./diagnosis.js";
import type { Submodule } from "./gitSubmodules.js";
import type { Language } from "./language.js";

/** Each pack types its own options, so the CLI keeps them untyped. */
type PackFactory = (...args: never[]) => PatternPack;

export { UsageError };

function callPackFactory<T>(
  factory: PackFactory,
  options: unknown,
  name: string,
): T {
  try {
    return (factory as (options?: unknown) => T)(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      [
        `The ${name} pack cannot read anything yet: ${message}`,
        `Write those values to a JSON file and name it: -f ${name}=<config.json>.`,
      ].join("\n"),
    );
  }
}

function instantiatePack(
  loaded: Pick<LoadedFactory, "factory" | "options" | "handedOver">,
  specifier: string,
  name: string,
): PatternPack {
  const pack = callPackFactory<PatternPack>(
    loaded.factory,
    loaded.handedOver,
    name,
  );

  // The extraction cache keys on this stamp. A pack's code and config
  // change what it reads without reaching its declared version; the
  // config's directory does not, so `digest` never sees it.
  const stamp = [
    pack.version ?? "unset",
    packCodeHash(specifier),
    loaded.options === undefined ? "" : digest(loaded.options),
  ].filter((part) => part.length > 0);
  return { ...pack, version: stamp.join("+") };
}

const packCodeHashes = new Map<string, string>();

/** Empty when the specifier resolves to no file, as when a host bundles it. */
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
 * `import.meta.resolve` resolves under the same conditions the import
 * itself did. Do not fall back to `createRequire`: it would hash a
 * build the run never loaded.
 */
function resolvePackFile(specifier: string): string[] {
  try {
    return [fileURLToPath(import.meta.resolve(specifier))];
  } catch {
    return [];
  }
}

/** Stable across key order, so reformatting a config keeps the cache entry. */
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
 * A pack left out still loads through the dynamic fallback below, but
 * never appears in the list the error message prints, so a test asserts
 * every `@suss/framework-*` the CLI depends on is here.
 */
export const BUILTIN_FRAMEWORKS: Record<string, string> = {
  "ts-rest": "@suss/packs/ts-rest",
  "react-router": "@suss/packs/react-router",
  express: "@suss/packs/express",
  fastify: "@suss/packs/fastify",
  hono: "@suss/packs/hono",
  nextjs: "@suss/packs/nextjs",
  react: "@suss/packs/react",
  apollo: "@suss/packs/apollo",
  "nestjs-graphql": "@suss/packs/nestjs-graphql",
  "nestjs-microservices": "@suss/packs/nestjs-microservices",
  "nestjs-rest": "@suss/packs/nestjs-rest",
  "aws-lambda": "@suss/packs/aws-lambda",
  "cloudflare-workers": "@suss/packs/cloudflare-workers",
  prisma: "@suss/packs/prisma",
  drizzle: "@suss/packs/drizzle",
  mongoose: "@suss/packs/mongoose",
  "aws-sqs": "@suss/packs/aws-sqs",
  "aws-eventbridge": "@suss/packs/aws-eventbridge",
  "aws-dynamodb": "@suss/packs/aws-dynamodb",
  "aws-s3": "@suss/packs/aws-s3",
  gcs: "@suss/packs/gcs",
  redis: "@suss/packs/redis",
  fetch: "@suss/packs/fetch",
  axios: "@suss/packs/axios",
  "apollo-client": "@suss/packs/apollo-client",
  node: "@suss/packs/node",
  fastapi: "@suss/packs/fastapi",
  "flask-restx": "@suss/packs/flask-restx",
  "graphql-ruby": "@suss/packs/graphql-ruby",
  sqlalchemy: "@suss/packs/sqlalchemy",
  activerecord: "@suss/packs/activerecord",
};

/** Packs that read something other than TypeScript. */
const PACK_LANGUAGE: Record<string, Language> = {
  fastapi: "python",
  "flask-restx": "python",
  "graphql-ruby": "ruby",
  sqlalchemy: "python",
  activerecord: "ruby",
};

/** Which language's adapter reads the code this pack describes. */
export function languageOfPack(name: string): Language {
  return PACK_LANGUAGE[name] ?? "typescript";
}

export function parseFrameworkSpec(spec: string): {
  name: string;
  options?: unknown;
  /** Absolute path of the file the options came from, when they came from one. */
  configFile?: string;
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
    return {
      name,
      options: JSON.parse(fs.readFileSync(resolved, "utf8")),
      configFile: resolved,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`The pack config at ${resolved} is not JSON: ${message}`);
  }
}

/**
 * A pack option that gives a path is written relative to its own config
 * file, and only the pack knows which of its options are paths, so the
 * directory goes along with them. Resolving against the working
 * directory instead fails silently: every field then looks unwired
 * rather than like an error.
 */
function optionsForFactory(options: unknown, configFile?: string): unknown {
  if (
    configFile === undefined ||
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    return options;
  }
  return {
    ...(options as Record<string, unknown>),
    configDirectory: path.dirname(configFile),
  };
}

interface LoadedFactory {
  name: string;
  /** What the config file said, exactly, which is what the cache key sees. */
  options: unknown;
  /** The same options, plus the config file's own directory. */
  handedOver: unknown;
  factory: PackFactory;
  specifier: string;
}

/**
 * What each pack this process loaded was imported from. The ts-morph
 * check reads it to ask what each pack resolves, which is a fact about
 * this run rather than about any pack, so it is recorded where the
 * imports happen.
 */
const loadedFrom = new Map<string, string>();

export function packsLoadedSoFar(): Array<{
  name: string;
  specifier: string;
}> {
  return [...loadedFrom].map(([name, specifier]) => ({ name, specifier }));
}

async function loadPackFactory(spec: string): Promise<LoadedFactory> {
  const { name, options, configFile } = parseFrameworkSpec(spec);
  const handedOver = optionsForFactory(options, configFile);

  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    const mod = (await import(builtin)) as { default: PackFactory };
    loadedFrom.set(name, builtin);
    return {
      name,
      options,
      handedOver,
      factory: mod.default,
      specifier: builtin,
    };
  }

  const candidates = looksLikeAPackage(name)
    ? [name]
    : [`@suss/packs/${name}`, `@suss/framework-${name}`, `@suss/${name}`];
  for (const specifier of candidates) {
    const mod = await importPack(specifier);
    if (mod !== null) {
      loadedFrom.set(name, specifier);
      return { name, options, handedOver, factory: mod.default, specifier };
    }
  }

  throw new UsageError(
    [
      `Unknown pack: "${name}".`,
      `Tried to import ${candidates.map((c) => `"${c}"`).join(" and ")}.`,
      `Built in: ${Object.keys(BUILTIN_FRAMEWORKS).join(", ")}`,
    ].join("\n"),
  );
}

function assertPackLanguage(name: string, language: Language): void {
  const belongs = languageOfPack(name);
  if (belongs === language) {
    return;
  }
  throw new UsageError(
    [
      `The ${name} pack reads ${LANGUAGE_LABEL[belongs]}, and this run is reading ${LANGUAGE_LABEL[language]}.`,
      `Read the ${LANGUAGE_LABEL[belongs]} code in its own run: suss extract --lang ${belongs} --dir <directory> -f ${name}`,
    ].join("\n"),
  );
}

export async function resolveFramework(spec: string): Promise<PatternPack> {
  const loaded = await loadPackFactory(spec);
  assertPackLanguage(loaded.name, "typescript");
  return instantiatePack(loaded, loaded.specifier, loaded.name);
}

/** No version stamp: the stamp keys a cache the Python adapter does not keep. */
export async function resolvePythonPack(spec: string): Promise<PythonPack> {
  const loaded = await loadPackFactory(spec);
  assertPackLanguage(loaded.name, "python");
  return callPackFactory<PythonPack>(
    loaded.factory,
    loaded.handedOver,
    loaded.name,
  );
}

export async function resolveRubyPack(spec: string): Promise<RubyPack> {
  const loaded = await loadPackFactory(spec);
  assertPackLanguage(loaded.name, "ruby");
  return callPackFactory<RubyPack>(
    loaded.factory,
    loaded.handedOver,
    loaded.name,
  );
}

/** A scoped name or a path is the package itself, not a short name. */
const looksLikeAPackage = (name: string): boolean =>
  name.startsWith("@") || name.includes("/");

async function importPack(
  specifier: string,
): Promise<{ default: PackFactory } | null> {
  try {
    return (await import(specifier)) as { default: PackFactory };
  } catch {
    return null;
  }
}

export interface ExtractOptions {
  /**
   * Path to the tsconfig covering the code to read. Without one, the
   * nearest tsconfig or jsconfig above the working directory is used,
   * and the directory itself when there is none.
   */
  tsconfig?: string;
  /** Directory to read when no tsconfig is given. Defaults to cwd. */
  dir?: string;
  /** Leave it out and suss works it out from what is in the directory. */
  lang?: Language;
  frameworks: string[];
  files?: string[];
  output?: string;
  /**
   * What to do with gaps. `permissive` (default) and `strict` record the
   * same gaps; `strict` also exits non-zero when any were recorded.
   * `silent` skips gap detection and records none.
   */
  gaps?: "strict" | "permissive" | "silent";
  /** Print the per-phase wall-clock breakdown to stderr. */
  timing?: boolean;
  /**
   * Print where datalog evaluation spent the run. Off by default, since
   * collecting it costs a timestamp per rule attempt.
   */
  datalogProfile?: boolean;
  /** Skip the on-disk extraction cache for this run. */
  noCache?: boolean;
  /**
   * Print the extraction funnel even when the run produced summaries.
   * A run that produced nothing prints it either way.
   */
  explain?: boolean;
  /** Exit non-zero when the run produces no summaries. */
  failOnEmpty?: boolean;
  /** Exit non-zero when a pack threw while it was reading. */
  failOnPackError?: boolean;
}

/** A tsconfig wins when one exists, because it has the path aliases. */
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

interface LanguageRun {
  summaries: BehavioralSummary[];
  /** The directory summary paths are written relative to. */
  root: string;
  /** How many source files the adapter was given. */
  filesRead: number;
  timingReport: TimingReport | null;
  cacheDiagnostic: CacheDiagnostic | null;
  extractionReport: ExtractionReport | null;
  /**
   * True when every pack in the run recognizes calls inside boundaries
   * but none of them discovers boundaries, so the run cannot produce a
   * summary no matter what the code says.
   */
  recognizersOnly: boolean;
}

interface LanguageRunOptions {
  options: ExtractOptions;
  /** The directory the command was pointed at. */
  root: string;
  submodules: readonly Submodule[];
}

/**
 * A file given on the command line is read whichever repository it is
 * in. A walk of the directory takes only this project's own files.
 */
function filesToRead(
  { options, root }: LanguageRunOptions,
  findFiles: (root: string) => string[],
  submodules: readonly Submodule[],
): string[] {
  if (options.files !== undefined && options.files.length > 0) {
    return options.files.map((file) => path.resolve(file));
  }
  return filesOutsideNestedRepositories(findFiles(root), root, submodules);
}

async function runTypeScript(
  runOptions: LanguageRunOptions,
): Promise<LanguageRun> {
  const { options } = runOptions;
  const source = resolveSource(options);
  // Ids and the written summaries' paths are both relative to this
  // root, so a reader can rebuild an id from a summary's own fields.
  const runRoot = workspaceRootFor(source.root);
  const packs = await Promise.all(options.frameworks.map(resolveFramework));
  process.stderr.write(formatSecondCopies(checkOneTsMorph(packsLoadedSoFar())));

  const extractorOptions =
    options.gaps !== undefined ? { gapHandling: options.gaps } : undefined;

  let timingReport: TimingReport | null = null;
  let cacheDiagnostic: CacheDiagnostic | null = null;
  let extractionReport: ExtractionReport | null = null;

  const adapter = createTypeScriptAdapter({
    ...(source.kind === "tsconfig"
      ? { tsConfigFilePath: source.path }
      : { project: createProjectWithoutTsconfig(source.root).project }),
    projectRoot: runRoot,
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

  const summaries =
    options.files !== undefined && options.files.length > 0
      ? await adapter.extractFromFiles(
          options.files.map((f) => path.resolve(f)),
        )
      : await adapter.extractAll();

  return {
    summaries,
    root: runRoot,
    filesRead: (extractionReport as ExtractionReport | null)?.filesWalked ?? 0,
    timingReport,
    cacheDiagnostic,
    extractionReport,
    recognizersOnly:
      packs.length > 0 &&
      packs.every(
        (p) => p.discovery.length === 0 && p.discoverUnits === undefined,
      ),
  };
}

async function runPython(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const packs = await Promise.all(
    runOptions.options.frameworks.map(resolvePythonPack),
  );
  // A submodule has to be a root of its own, or imports into the shared
  // framework inside it do not resolve.
  const submodules = runOptions.submodules;
  const files = filesToRead(runOptions, findPythonFiles, submodules);
  const roots = [
    runOptions.root,
    ...submodules
      .filter((submodule) => submodule.checkedOut)
      .map((submodule) => submodule.directory),
  ];

  const { summaries } = await extractPythonProject({
    files,
    packs,
    roots,
    ...(runOptions.options.gaps !== undefined
      ? { gapHandling: runOptions.options.gaps }
      : {}),
  });
  return languageRun(
    summaries,
    runOptions.root,
    files.length,
    packs.length > 0 && packs.every((p) => p.discovery.length === 0),
  );
}

async function runRuby(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const packs = await Promise.all(
    runOptions.options.frameworks.map(resolveRubyPack),
  );
  // findRubyFiles skips any directory called .git, but it does not
  // notice that the .git directory means there is a separate repository
  // there.
  const files = filesToRead(runOptions, findRubyFiles, runOptions.submodules);
  const { summaries } = await extractRubyProject({ files, packs });
  return languageRun(
    summaries,
    runOptions.root,
    files.length,
    packs.length > 0 && packs.every((p) => p.discovery.length === 0),
  );
}

/** Null rather than zero, so a breakdown of nothing does not look instant. */
function languageRun(
  summaries: BehavioralSummary[],
  root: string,
  filesRead: number,
  recognizersOnly: boolean,
): LanguageRun {
  return {
    summaries,
    root,
    filesRead,
    timingReport: null,
    cacheDiagnostic: null,
    extractionReport: null,
    recognizersOnly,
  };
}

const RUN_BY_LANGUAGE: Record<
  Language,
  (options: LanguageRunOptions) => Promise<LanguageRun>
> = {
  typescript: runTypeScript,
  python: runPython,
  ruby: runRuby,
};

export function languageOfRun(options: ExtractOptions): Language {
  if (options.lang !== undefined) {
    return options.lang;
  }
  if (options.tsconfig !== undefined) {
    return "typescript";
  }

  const asked = [...new Set(options.frameworks.map(specLanguage))];
  const only = asked.length === 1 ? asked[0] : undefined;
  if (only !== undefined && only !== "typescript") {
    return only;
  }

  // resolveSource reads a directory as TypeScript when there is a
  // tsconfig above it, so detection has to see that same tsconfig.
  const root = path.resolve(options.dir ?? process.cwd());
  const detected = languageOfProject(root, {
    coveredByTsconfig: findNearestTsconfig(root) !== null,
  });
  if ("cannotTell" in detected) {
    throw new UsageError(detected.cannotTell);
  }
  return detected.language;
}

function specLanguage(spec: string): Language {
  const separator = spec.indexOf("=");
  return languageOfPack(separator === -1 ? spec : spec.slice(0, separator));
}

export async function extract(
  options: ExtractOptions,
): Promise<BehavioralSummary[]> {
  if (options.frameworks.length === 0) {
    throw new Error(
      "Pick at least one pack with -f, for example: -f express. Run `suss --help` for the built-in list.",
    );
  }

  const language = languageOfRun(options);
  const root = path.resolve(options.dir ?? process.cwd());

  const submodules = readSubmodules(root);
  const missingSubmodules = submodules
    .filter((submodule) => !submodule.checkedOut)
    .map((submodule) => submodule.declaredPath);
  process.stderr.write(formatMissingSubmodules(submodules));

  const runExtraction = (): Promise<LanguageRun> =>
    RUN_BY_LANGUAGE[language]({ options, root, submodules });

  const profiled =
    options.datalogProfile === true
      ? await profileEvaluationAsync(runExtraction)
      : null;
  const run = profiled === null ? await runExtraction() : profiled.result;
  const { summaries, timingReport, cacheDiagnostic, extractionReport } = run;

  const projectRoot = run.root;
  for (const summary of summaries) {
    summary.location.file = path.relative(projectRoot, summary.location.file);
    const moduleImports = summary.metadata?.moduleImports;
    if (Array.isArray(moduleImports)) {
      summary.metadata = {
        ...summary.metadata,
        moduleImports: moduleImports.map((file) =>
          typeof file === "string" ? path.relative(projectRoot, file) : file,
        ),
      };
    }
    summary.schemaVersion = SUMMARY_SCHEMA_VERSION;
  }

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    await writeJson({ value: summaries, indent: 2, file: outPath });
    await writeIncompleteness({
      outPath,
      projectRoot,
      report: extractionReport,
      missingSubmodules,
    });
    process.stderr.write(
      summaries.length === 0
        ? `No summaries to write${formatTimingTotal(timingReport)}.\n`
        : `Wrote ${summaries.length} summar${summaries.length === 1 ? "y" : "ies"} to ${outPath}${formatTimingTotal(timingReport)}\n`,
    );
  } else {
    await writeJson({ value: summaries, indent: 2 });
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

  if (extractionReport === null && options.explain === true) {
    process.stderr.write(
      "These summaries came back from the cache, so there is no breakdown of where they came from. Run this again with --no-cache to walk the files and get one.\n",
    );
  }

  if (extractionReport !== null) {
    const report = extractionReport as ExtractionReport;
    if (options.explain === true || report.summaries === 0) {
      process.stderr.write(
        formatExtractionReport(
          report,
          run.recognizersOnly ? options.frameworks : undefined,
        ),
      );
    }

    // What the person running this can act on always prints; what only
    // a pack's author can fix waits for `--explain`.
    process.stderr.write(
      formatPackHealth(
        evaluatePackHealth(report),
        options.explain === true ? ["run", "pack"] : ["run"],
      ),
    );

    const threw = report.packs.filter((p) => p.failures.length > 0);
    if (options.failOnPackError === true && threw.length > 0) {
      process.stderr.write(
        `Failing because ${listOf(threw.map((p) => p.pack))} threw while reading (--fail-on-pack-error).\n`,
      );
      process.exitCode = 1;
    }
  }

  if (extractionReport === null && summaries.length === 0) {
    process.stderr.write(
      formatEmptyLanguageRun(
        language,
        run.filesRead,
        options.frameworks,
        run.recognizersOnly,
      ),
    );
  }

  if (options.failOnEmpty === true && summaries.length === 0) {
    process.stderr.write(
      "Failing because the extract produced no summaries (--fail-on-empty).\n",
    );
    process.exitCode = 1;
  }

  if (options.gaps === "strict") {
    const gapped = summaries.flatMap((summary) =>
      summary.gaps.map((gap) => ({ summary, gap })),
    );
    if (gapped.length > 0) {
      process.stderr.write(
        `Failing because ${gapped.length} gap${gapped.length === 1 ? "" : "s"} ${gapped.length === 1 ? "was" : "were"} recorded (--gaps strict).\n`,
      );
      const shown = gapped.slice(0, 5);
      for (const { summary, gap } of shown) {
        process.stderr.write(
          `  ${summary.location.file}:${summary.location.range.start} ${summary.identity.name}: ${gap.description}\n`,
        );
      }
      const remaining = gapped.length - shown.length;
      if (remaining > 0) {
        process.stderr.write(
          `  and ${remaining} more gap${remaining === 1 ? "" : "s"} not shown.\n`,
        );
      }
      process.exitCode = 1;
    }
  }

  return summaries;
}

/** Enough unreadable files to see the pattern, not the whole list. */
const UNREADABLE_FILES_SHOWN = 5;

/** A separate file beside the summaries, because every reader of the
 * summaries validates them as a bare array. */
export function incompletenessPathFor(summariesPath: string): string {
  const ext = path.extname(summariesPath);
  const base = summariesPath.slice(0, summariesPath.length - ext.length);
  return `${base}.incomplete${ext === "" ? ".json" : ext}`;
}

/** A note left by an earlier run is deleted, because a stale one would
 * fail a job that has since been fixed. */
async function writeIncompleteness(args: {
  outPath: string;
  projectRoot: string;
  report: ExtractionReport | null;
  missingSubmodules: readonly string[];
}): Promise<void> {
  const notePath = incompletenessPathFor(args.outPath);
  const unreadable = args.report?.filesWithUnreadableExports ?? [];
  if (unreadable.length === 0 && args.missingSubmodules.length === 0) {
    fs.rmSync(notePath, { force: true });
    return;
  }

  await writeJson({
    value: {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      ...(unreadable.length > 0
        ? {
            filesWithUnreadableExports: unreadable.map((file) =>
              path.relative(args.projectRoot, file),
            ),
          }
        : {}),
      ...(args.missingSubmodules.length > 0
        ? { submodulesNotCheckedOut: [...args.missingSubmodules] }
        : {}),
    },
    indent: 2,
    file: notePath,
  });
}

const EMPTY_STAGE_COPY: Record<
  EmptyStage,
  (report: ExtractionReport) => Diagnosis
> = {
  tsconfig: () => ({
    problem: "That tsconfig matched no source files.",
    fix: {
      advice:
        "Check its `include` and `files` patterns against where your source actually lives.",
    },
  }),
  gateResolution: (report) => {
    const blocked = report.packs.filter((p) => p.unresolvedGates.length > 0);
    const missing = [...new Set(blocked.flatMap((p) => p.unresolvedGates))];
    const files = blocked.reduce((sum, p) => sum + p.candidateFiles, 0);
    return {
      problem: `${files} ${files === 1 ? "file imports" : "files import"} ${listOf(missing)}, but ${missing.length === 1 ? "that package is" : "those packages are"} not installed here.`,
      cause: "suss cannot see what a call does without the package behind it.",
      fix: {
        advice:
          "Install this project's dependencies, then run the command again.",
      },
    };
  },
  candidateFiles: (report) => ({
    problem: `No file imports anything ${listOf(report.packs.map((p) => p.pack))} looks for.`,
    cause:
      "Either this project does not use it, or your code reaches it through a local wrapper module. suss only recognizes direct imports today.",
  }),
  discovery: (report) => ({
    problem: `suss read ${report.filesWalked} ${report.filesWalked === 1 ? "file" : "files"} but recognized no boundaries in them.`,
    cause:
      "Your code probably declares its boundaries in a shape this pack does not describe yet.",
    fix: { advice: "Worth opening an issue with an example." },
  }),
  assembly: (report) => ({
    problem: `suss recognized ${totalUnits(report)} boundaries but built no summaries from them.`,
    cause: "That is a bug in suss.",
    fix: {
      advice: "Please open an issue with the code shape that triggered it.",
    },
  }),
};

/**
 * Replaces the discovery-stage copy when no pack in the run can discover
 * boundaries. The default copy blames the code, and the code is fine:
 * a recognizer-only pack reads what happens inside a boundary some other
 * pack has to find first. `packSpecs` come straight from the user's -f
 * flags, so the suggested command is theirs with one flag added.
 */
function recognizersOnlyDiagnosis(
  packSpecs: ReadonlyArray<string>,
  example: string,
): Diagnosis {
  const kept = packSpecs.map((s) => `-f ${s}`).join(" ");
  const names = packSpecs.map((s) => s.split("=")[0]);
  return {
    problem: "No discovery pack is loaded.",
    cause: `${listOf(names)} ${names.length === 1 ? "labels" : "label"} calls inside boundaries, and a discovery pack finds the boundaries.`,
    fix: {
      command: `suss extract -f ${example} ${kept}`,
      note: "`suss extract --help` lists the packs",
    },
  };
}

/** A discovery-capable pack of the same language, for the suggestion. */
const EXAMPLE_DISCOVERY_PACK: Record<Language, string> = {
  typescript: "express",
  python: "fastapi",
  ruby: "graphql-ruby",
};

export function formatEmptyLanguageRun(
  language: Language,
  filesRead: number,
  packs: ReadonlyArray<string>,
  recognizersOnly = false,
): string {
  const label = LANGUAGE_LABEL[language];
  const diagnosis = emptyLanguageRunDiagnosis(
    language,
    label,
    filesRead,
    packs,
    recognizersOnly,
  );
  return [...renderDiagnosis(diagnosis), ""].join("\n");
}

function emptyLanguageRunDiagnosis(
  language: Language,
  label: string,
  filesRead: number,
  packs: ReadonlyArray<string>,
  recognizersOnly: boolean,
): Diagnosis {
  if (filesRead === 0) {
    return {
      problem: `suss found no ${label} files to read.`,
      fix: {
        advice:
          "Point it at the directory holding the source with --dir, or name the files with --files.",
      },
    };
  }

  if (recognizersOnly) {
    const base = recognizersOnlyDiagnosis(
      packs,
      EXAMPLE_DISCOVERY_PACK[language],
    );
    return {
      ...base,
      cause: `suss read ${filesRead} ${label} ${filesRead === 1 ? "file" : "files"}, and ${base.cause}`,
    };
  }

  return {
    problem: `suss read ${filesRead} ${label} ${filesRead === 1 ? "file" : "files"} and recognized no boundaries in them.`,
    cause: `Either this project declares its boundaries in a shape ${listOf([...packs])} does not describe yet, or the code that does declare them sits somewhere the run did not read.`,
  };
}

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

export function formatExtractionReport(
  report: ExtractionReport,
  recognizerOnlyPacks?: ReadonlyArray<string>,
): string {
  const lines: string[] = [];

  if (report.emptyStage !== null) {
    const diagnosis =
      recognizerOnlyPacks !== undefined && report.emptyStage === "discovery"
        ? recognizersOnlyDiagnosis(
            recognizerOnlyPacks,
            EXAMPLE_DISCOVERY_PACK.typescript,
          )
        : EMPTY_STAGE_COPY[report.emptyStage](report);
    lines.push(...renderDiagnosis(diagnosis));
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

    // A pack made only of recognisers discovers no boundary, so the
    // rows below would print three zeros and look like a broken pack.
    if (!pack.discovers && pack.recognizes) {
      rows.push([
        pack.unitsInGatedFiles,
        `unit bodies ${pack.pack} could look inside`,
      ]);
      rows.push([pack.effectsRecognized, `effects ${pack.pack} recognized`]);
      continue;
    }

    rows.push([pack.unitsDiscovered, `boundaries recognized by ${pack.pack}`]);
    rows.push([pack.summariesProduced, `summaries from ${pack.pack}`]);
    rows.push([
      pack.summariesWithBehavior,
      `of those, summaries saying what ${pack.pack} does`,
    ]);
  }

  const width = Math.max(...rows.map(([count]) => String(count).length));
  for (const [count, label] of rows) {
    lines.push(`    ${String(count).padStart(width)}  ${label}`);
  }

  const unreadable = report.filesWithUnreadableExports;
  if (unreadable.length > 0) {
    lines.push("");
    lines.push(
      `  Warning: suss could not follow the re-exports of ${unreadable.length} ${unreadable.length === 1 ? "file" : "files"}, so it read them as exporting nothing. Anything reachable only through them is missing from the counts above.`,
    );
    for (const file of unreadable.slice(0, UNREADABLE_FILES_SHOWN)) {
      lines.push(`    ${file}`);
    }
    if (unreadable.length > UNREADABLE_FILES_SHOWN) {
      lines.push(`    and ${unreadable.length - UNREADABLE_FILES_SHOWN} more`);
    }
  }

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

export function formatCacheDiagnostic(diag: CacheDiagnostic): string {
  if (diag.kind === "hit") {
    return "  cache: hit (returned all summaries from manifest)\n";
  }
  if (diag.kind === "partial") {
    const partial = diag.partial;
    if (partial === undefined) {
      return "  cache: partial\n";
    }
    const declined =
      partial.rootsDeclined > 0
        ? `, ${partial.rootsDeclined} never cached`
        : "";
    return `  cache: partial (${partial.rootsReused} files reused, ${partial.rootsReextracted} re-extracted after ${partial.filesChanged} changed, ${partial.summariesReused} summaries reused${declined})\n`;
  }
  return `  cache: miss (${diag.missReason ?? "unknown"})\n`;
}

function formatTimingTotal(report: TimingReport | null): string {
  if (report === null) {
    return "";
  }
  return ` in ${(report.totalMs / 1000).toFixed(2)}s`;
}

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
