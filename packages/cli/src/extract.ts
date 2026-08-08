// extract.ts — `suss extract` command implementation

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
} from "@suss/adapter-typescript";
import { SUMMARY_SCHEMA_VERSION } from "@suss/behavioral-ir";
import { formatProfile, profileEvaluationAsync } from "@suss/datalog";

import {
  filesOutsideNestedRepositories,
  formatMissingSubmodules,
  readSubmodules,
} from "./gitSubmodules.js";
import { writeJson } from "./jsonStream.js";
import { LANGUAGE_LABEL, languageOfProject } from "./language.js";

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
import type { Submodule } from "./gitSubmodules.js";
import type { Language } from "./language.js";

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

/**
 * Something the person running the command can fix by typing something
 * else. The dispatch prints the sentence and stops; a stack trace above
 * a message about a missing flag helps nobody.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Build the pack, and turn anything it objects to into a sentence
 * naming the flag that fixes it.
 *
 * A pack that cannot work without a value only this project knows (the
 * directory a class is looked up under, say) throws when it is handed
 * nothing, which is the pack stating its own requirement. What it
 * cannot know is how the person in front of it supplies one, so that
 * half is added here.
 */
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

  // The extraction cache keys on the pack's version stamp, so anything
  // that changes what a pack reads has to reach the stamp. Two of those
  // things are invisible to the pack itself: the config it was handed,
  // and its own code. Almost no pack declares a version, and nothing
  // checks that an author bumped one, so a pack edit would otherwise
  // keep serving summaries the previous code produced.
  //
  // The config the stamp sees is the file's own content, without the
  // directory it was read from: moving a checkout changes that
  // directory and changes nothing about what the pack reads.
  const stamp = [
    pack.version ?? "unset",
    packCodeHash(specifier),
    loaded.options === undefined ? "" : digest(loaded.options),
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
  // Python route packs, read by the Python adapter.
  fastapi: "@suss/framework-fastapi",
  "flask-restx": "@suss/framework-flask-restx",
  // Ruby GraphQL field packs, read by the Ruby adapter.
  "graphql-ruby": "@suss/framework-graphql-ruby",
};

/**
 * The language a pack reads, for every pack that reads something other
 * than TypeScript. A pack missing from here reads TypeScript, which
 * covers both the rest of the built-in list and any pack somebody
 * publishes for the CLI to import by name.
 *
 * A pack is written against one language's adapter, so naming one in a
 * run of another language cannot work, and the run says which one it
 * belongs to rather than coming back empty.
 */
const PACK_LANGUAGE: Record<string, Language> = {
  fastapi: "python",
  "flask-restx": "python",
  "graphql-ruby": "ruby",
};

/** Which language's adapter reads the code this pack describes. */
export function languageOfPack(name: string): Language {
  return PACK_LANGUAGE[name] ?? "typescript";
}

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
 * The options as the pack receives them: what the file said, plus where
 * the file was.
 *
 * A pack option naming a directory is written relative to something,
 * and the only thing whoever wrote the file can be sure of is the file
 * itself. Resolving against the working directory instead means the
 * same config works from the project root and silently resolves to
 * nothing from anywhere else, which is the shape of bug nobody
 * notices: every field reads as unwired rather than failing.
 *
 * So the directory travels with the options and each pack resolves its
 * own paths against it, since only the pack knows which of its options
 * are paths. It stays out of the cache key, because where a checkout
 * sits says nothing about what a pack reads.
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

/** A pack's factory, with what the spec said to hand it. */
interface LoadedFactory {
  name: string;
  /** What the config file said, exactly, which is what the cache key sees. */
  options: unknown;
  /** The same options with the config file's own directory alongside them. */
  handedOver: unknown;
  factory: PackFactory;
  specifier: string;
}

async function loadPackFactory(spec: string): Promise<LoadedFactory> {
  const { name, options, configFile } = parseFrameworkSpec(spec);
  const handedOver = optionsForFactory(options, configFile);

  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    const mod = (await import(builtin)) as { default: PackFactory };
    return {
      name,
      options,
      handedOver,
      factory: mod.default,
      specifier: builtin,
    };
  }

  // A name the record does not carry is taken for a package to import.
  // Someone shipping a pack should not have to wait for the CLI to list
  // it, and a name that already looks like a package is used as written
  // so a pack outside the family prefix can be named at all.
  const candidates = looksLikeAPackage(name)
    ? [name]
    : [`@suss/framework-${name}`, `@suss/${name}`];
  for (const specifier of candidates) {
    const mod = await importPack(specifier);
    if (mod !== null) {
      return { name, options, handedOver, factory: mod.default, specifier };
    }
  }

  throw new Error(
    [
      `Unknown pack: "${name}".`,
      `Tried to import ${candidates.map((c) => `"${c}"`).join(" and ")}.`,
      `Built in: ${Object.keys(BUILTIN_FRAMEWORKS).join(", ")}`,
    ].join("\n"),
  );
}

/**
 * Refuse a pack written for another language's adapter. Handing a
 * Python pack to the TypeScript adapter finds nothing, and nothing is
 * the answer a person spends an afternoon on.
 */
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

/**
 * A pack the Python adapter reads. Nothing is stamped with a version
 * here the way a TypeScript pack is: that stamp is the extraction
 * cache's key, and the Python and Ruby adapters keep no cache.
 */
export async function resolvePythonPack(spec: string): Promise<PythonPack> {
  const loaded = await loadPackFactory(spec);
  assertPackLanguage(loaded.name, "python");
  return callPackFactory<PythonPack>(
    loaded.factory,
    loaded.handedOver,
    loaded.name,
  );
}

/** A pack the Ruby adapter reads. */
export async function resolveRubyPack(spec: string): Promise<RubyPack> {
  const loaded = await loadPackFactory(spec);
  assertPackLanguage(loaded.name, "ruby");
  return callPackFactory<RubyPack>(
    loaded.factory,
    loaded.handedOver,
    loaded.name,
  );
}

/** A scoped name or a path names the package itself, not a short name. */
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
  /**
   * Which language's adapter reads this project. Left out, suss works
   * it out from what the directory holds, and says so when it cannot.
   */
  lang?: Language;
  frameworks: string[];
  files?: string[];
  output?: string;
  /**
   * What to do with gaps. `permissive` (default) and `strict` record the
   * same gaps in the summary; extraction itself does not differ. `strict`
   * also fails the run (sets a non-zero exit code) when any summary came
   * out carrying a gap, which is what CI wants: a gap nobody looked at is
   * worse than a run that stopped to say so. `silent` skips gap detection
   * entirely, recording none.
   */
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
  /**
   * Exit non-zero when a pack threw while it was reading. Off by
   * default, because one bad file in a large tree should not stop a run
   * that is otherwise working; on in CI, where a count that quietly
   * came out short is worse than a failure.
   */
  failOnPackError?: boolean;
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

/** What one language's run of the extract pipeline came back with. */
interface LanguageRun {
  summaries: BehavioralSummary[];
  /** The directory summary paths are written relative to. */
  root: string;
  /** How many source files the adapter was given. */
  filesRead: number;
  timingReport: TimingReport | null;
  cacheDiagnostic: CacheDiagnostic | null;
  extractionReport: ExtractionReport | null;
}

interface LanguageRunOptions {
  options: ExtractOptions;
  /** The directory the command was pointed at. */
  root: string;
}

/**
 * The files a non-TypeScript run reads: the ones named on the command
 * line, or every source file under the directory that belongs to this
 * project.
 *
 * A file somebody asked for by name is read whatever repository it
 * sits in; that is the person saying which files they mean. A walk of
 * the directory is suss choosing, and it chooses this project's own.
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
  const packs = await Promise.all(options.frameworks.map(resolveFramework));

  const extractorOptions =
    options.gaps !== undefined ? { gapHandling: options.gaps } : undefined;

  // Wall-clock breakdown of the extract pipeline. `--timing` swaps the
  // one-line summary for the per-phase view. The cost of always-on
  // instrumentation is one `performance.now()` per phase entry, well
  // under the noise floor of extracting a project.
  let timingReport: TimingReport | null = null;
  let cacheDiagnostic: CacheDiagnostic | null = null;
  let extractionReport: ExtractionReport | null = null;

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

  const summaries =
    options.files !== undefined && options.files.length > 0
      ? await adapter.extractFromFiles(
          options.files.map((f) => path.resolve(f)),
        )
      : await adapter.extractAll();

  return {
    summaries,
    root: source.root,
    filesRead: (extractionReport as ExtractionReport | null)?.filesWalked ?? 0,
    timingReport,
    cacheDiagnostic,
    extractionReport,
  };
}

async function runPython(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const packs = await Promise.all(
    runOptions.options.frameworks.map(resolvePythonPack),
  );
  // A service that imports its shared framework from a submodule
  // resolves those imports only if the submodule is a root too, and the
  // decorator a pack matches on is usually defined in exactly that
  // framework. One that is not checked out resolves to nothing, which
  // is worth saying out loud rather than leaving as a short run.
  const submodules = readSubmodules(runOptions.root);
  process.stderr.write(formatMissingSubmodules(submodules));

  const files = filesToRead(runOptions, findPythonFiles, submodules);
  const roots = [
    runOptions.root,
    ...submodules
      .filter((submodule) => submodule.checkedOut)
      .map((submodule) => submodule.directory),
  ];

  const { summaries } = await extractPythonProject({ files, packs, roots });
  return languageRun(summaries, runOptions.root, files.length);
}

async function runRuby(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const packs = await Promise.all(
    runOptions.options.frameworks.map(resolveRubyPack),
  );
  // findRubyFiles walks the same way findPythonFiles does, skipping a
  // directory named .git without noticing the repository it marks, so
  // the same filter applies.
  const submodules = readSubmodules(runOptions.root);
  process.stderr.write(formatMissingSubmodules(submodules));

  const files = filesToRead(runOptions, findRubyFiles, submodules);
  const { summaries } = await extractRubyProject({ files, packs });
  return languageRun(summaries, runOptions.root, files.length);
}

/**
 * What the Python and Ruby adapters come back with. Neither keeps a
 * cache, times its own phases, or builds the funnel the TypeScript
 * adapter does, so those are absent rather than zeroed: a timing
 * breakdown of nothing would read as a run that took no time.
 */
function languageRun(
  summaries: BehavioralSummary[],
  root: string,
  filesRead: number,
): LanguageRun {
  return {
    summaries,
    root,
    filesRead,
    timingReport: null,
    cacheDiagnostic: null,
    extractionReport: null,
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

/**
 * Which language's adapter reads this run, from what the person said or
 * from what the directory holds.
 *
 * A pack named with -f settles it too: nobody asks for a Ruby pack over
 * a TypeScript project, and a directory of Ruby with a Gemfile nowhere
 * near it would otherwise be unreadable for no good reason.
 */
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

  // Source resolution walks up for the nearest tsconfig and reads the
  // directory as TypeScript when it finds one. Language resolution has
  // to be told about the same tsconfig, or the two disagree about the
  // same directory and a subdirectory of a TypeScript monorepo with one
  // stray script in it stops being readable at all.
  const root = path.resolve(options.dir ?? process.cwd());
  const detected = languageOfProject(root, {
    coveredByTsconfig: findNearestTsconfig(root) !== null,
  });
  if ("cannotTell" in detected) {
    throw new UsageError(detected.cannotTell);
  }
  return detected.language;
}

/** The language of the pack a -f spec names, config path and all. */
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
  const runExtraction = (): Promise<LanguageRun> =>
    RUN_BY_LANGUAGE[language]({ options, root });

  const profiled =
    options.datalogProfile === true
      ? await profileEvaluationAsync(runExtraction)
      : null;
  const run = profiled === null ? await runExtraction() : profiled.result;
  const { summaries, timingReport, cacheDiagnostic, extractionReport } = run;

  // Make file paths relative to the project root so summaries are portable.
  // Absolute paths leak filesystem structure and break on other machines.
  // Stamp the format version at the same time: an artifact that says
  // which format it speaks is one a future reader never has to guess at.
  const projectRoot = run.root;
  for (const summary of summaries) {
    summary.location.file = path.relative(projectRoot, summary.location.file);
    summary.schemaVersion = SUMMARY_SCHEMA_VERSION;
  }

  // Output
  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    await writeJson({ value: summaries, indent: 2, file: outPath });
    await writeIncompleteness({
      outPath,
      projectRoot,
      report: extractionReport,
    });
    // An empty run gets its own line. "Wrote 0 summaries" announces an
    // empty file as if it were an accomplishment, and the funnel that
    // follows explains what actually happened.
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

  // A run that found nothing is the failure worth explaining. Print the
  // funnel unprompted in that case, since the user has no other way to
  // tell "this project has no boundaries" from "the packs never got to
  // look at it". `--explain` prints it either way.
  if (extractionReport !== null) {
    const report = extractionReport as ExtractionReport;
    if (options.explain === true || report.summaries === 0) {
      process.stderr.write(formatExtractionReport(report));
    }

    // A run that produced plenty can still have one pack in it that
    // produced nothing, and that pack is invisible in a total. What
    // the person running this can act on prints whenever it fires;
    // what only a pack's author can fix waits for `--explain`. Neither
    // changes the exit code.
    process.stderr.write(
      formatPackHealth(
        evaluatePackHealth(report),
        options.explain === true ? ["run", "pack"] : ["run"],
      ),
    );

    // Pack health always says a pack threw. This is the caller asking
    // for that to stop the build, which is what CI wants: a count that
    // quietly came out short is worse than a run that failed.
    const threw = report.packs.filter((p) => p.failures.length > 0);
    if (options.failOnPackError === true && threw.length > 0) {
      process.stderr.write(
        `Failing because ${listOf(threw.map((p) => p.pack))} threw while reading (--fail-on-pack-error).\n`,
      );
      process.exitCode = 1;
    }
  }

  // The Python and Ruby adapters build no funnel, so a run of theirs
  // that came back with nothing would otherwise print an empty file and
  // no account of itself.
  if (extractionReport === null && summaries.length === 0) {
    process.stderr.write(
      formatEmptyLanguageRun(language, run.filesRead, options.frameworks),
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
/** Enough unreadable files to see the pattern, not the whole list. */
const UNREADABLE_FILES_SHOWN = 5;

/**
 * Where a run records that it could not read part of the project.
 *
 * Sits beside the summaries under a name derived from theirs, so a job
 * that knows where the summaries went knows where to look. The
 * summaries file itself stays what every reader validates it as, a
 * bare array, which is why this is not a field on it.
 */
export function incompletenessPathFor(summariesPath: string): string {
  const ext = path.extname(summariesPath);
  const base = summariesPath.slice(0, summariesPath.length - ext.length);
  return `${base}.incomplete${ext === "" ? ".json" : ext}`;
}

/**
 * Write down what the run could not read, or remove a note an earlier
 * run left. A stale file saying the last extract was incomplete is
 * worse than none: it fails a job that has since been fixed.
 */
async function writeIncompleteness(args: {
  outPath: string;
  projectRoot: string;
  report: ExtractionReport | null;
}): Promise<void> {
  const notePath = incompletenessPathFor(args.outPath);
  const unreadable = args.report?.filesWithUnreadableExports ?? [];
  if (unreadable.length === 0) {
    fs.rmSync(notePath, { force: true });
    return;
  }

  await writeJson({
    value: {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      filesWithUnreadableExports: unreadable.map((file) =>
        path.relative(args.projectRoot, file),
      ),
    },
    indent: 2,
    file: notePath,
  });
}

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

/**
 * What a Python or Ruby run that found nothing has to say for itself.
 *
 * The file count separates the two things a person needs to tell apart:
 * suss never saw the code, or suss read the code and none of it matched
 * what these packs describe.
 */
export function formatEmptyLanguageRun(
  language: Language,
  filesRead: number,
  packs: ReadonlyArray<string>,
): string {
  const label = LANGUAGE_LABEL[language];
  if (filesRead === 0) {
    return [
      `  suss found no ${label} files to read.`,
      "  Point it at the directory holding the source with --dir, or name the files with --files.",
      "",
    ].join("\n");
  }

  return [
    `  suss read ${filesRead} ${label} ${filesRead === 1 ? "file" : "files"} and recognized no boundaries in them.`,
    `  Either this project declares its boundaries in a shape ${listOf([...packs])} does not describe yet, or the code that does declare them sits somewhere the run did not read.`,
    "",
  ].join("\n");
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

    // A pack made only of recognisers finds no boundary of its own and
    // writes no summary, so the discovery rows below would print three
    // zeros and read as a broken pack. What it contributes is effects
    // attached to units other packs found, which is what to show.
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

  // A file suss could not read the exports of leaves every count above
  // it short by an unknown amount, so it is said plainly rather than
  // left to look like a module that exports nothing.
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

/** One-line cache diagnostic emitted under `--timing`. */
export function formatCacheDiagnostic(diag: CacheDiagnostic): string {
  if (diag.kind === "hit") {
    return "  cache: hit (returned all summaries from manifest)\n";
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
