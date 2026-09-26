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
  findNearestTsconfig,
  workspaceRootFor,
} from "@suss/adapter-typescript";
import {
  readWrapperMetadata,
  SUMMARY_SCHEMA_VERSION,
  withRewrittenPaths,
  withWrapperMetadata,
} from "@suss/behavioral-ir";
import { formatProfile, profileEvaluationAsync } from "@suss/datalog";
import { evaluatePackHealth, formatPackHealth } from "@suss/extractor";

import { renderDiagnosis } from "./diagnosis.js";
import {
  filesOutsideNestedRepositories,
  formatMissingSubmodules,
  readSubmodules,
} from "./gitSubmodules.js";
import { writeJson } from "./jsonStream.js";
import { LANGUAGE_LABEL, languageOfProject } from "./language.js";
import { checkOneTsMorph, formatSecondCopies } from "./oneTsMorph.js";
import { formatProjectsBelow, projectsBelow } from "./projectsBelow.js";
import {
  retiredOptionRefusal,
  retiredOptionsUsed,
  retiredOptionWarning,
} from "./retiredOptions.js";
import {
  loadStubs,
  type StubOverlay,
  stubOnlyOptionRefusal,
  stubOnlyOptionsOf,
  stubOverlayOf,
  withStubOptions,
} from "./stubs.js";
import { UsageError } from "./usageError.js";

import type { PythonPack, UnreadManifest } from "@suss/adapter-python";
import type { RubyPack } from "@suss/adapter-ruby";
import type {
  BehavioralSummary,
  RenderNode,
  WrapperReference,
} from "@suss/behavioral-ir";
import type {
  CacheDiagnostic,
  EmptyStage,
  ExtractionReport,
  PatternPack,
  TimingReport,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { z } from "zod";
import type { Diagnosis } from "./diagnosis.js";
import type { Submodule } from "./gitSubmodules.js";
import type { Language } from "./language.js";

/** Each pack types its own options, so the CLI keeps them untyped. */
type PackFactory = (...args: never[]) => PatternPack;

/**
 * A loaded pack module. A pack that takes options exports
 * `optionsSchema` beside its factory, and the CLI checks a config file
 * against it. A pack without one gets its options unchecked.
 */
interface PackModule {
  default: PackFactory;
  optionsSchema?: z.ZodObject<z.ZodRawShape>;
}

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

/**
 * Calls a pack's factory and stamps the result with a version for the
 * extraction cache to key on. `T` is the pack type of the pack's
 * language. Each of them declares an optional `version` field for this.
 */
function instantiatePack<T extends { version?: string }>(
  loaded: Pick<LoadedFactory, "factory" | "options" | "handedOver">,
  specifier: string,
  name: string,
): T {
  const pack = callPackFactory<T>(loaded.factory, loaded.handedOver, name);

  // Editing a pack's code or config changes what it reads without bumping
  // its version, so both go into the stamp. The config's directory does
  // not change what it reads, so the digest leaves it out.
  const stamp = [
    pack.version ?? "unset",
    packCodeHash(specifier),
    loaded.options === undefined ? "" : digest(loaded.options),
  ].filter((part) => part.length > 0);
  return { ...pack, version: stamp.join("+") };
}

const packCodeHashes = new Map<string, string>();

/** Empty when the specifier resolves to no file, as when a host bundles the pack. */
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
 * `import.meta.resolve` uses the same export conditions as the import
 * did. Do not fall back to `createRequire`, which can resolve to a
 * different build than the one the run loaded and hash that instead.
 */
function resolvePackFile(specifier: string): string[] {
  try {
    return [fileURLToPath(import.meta.resolve(specifier))];
  } catch {
    return [];
  }
}

/** Ignores key order, so reordering a config's keys keeps the cache entry. */
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
 * What every bundled pack declares about itself: the libraries it reads,
 * and the line the packages page shows. `suss init` matches a project's
 * manifest against these, so it keeps no pack table of its own.
 */
export async function builtinDeclarations(): Promise<
  Array<{ name: string; declares: PackDeclaration }>
> {
  const found: Array<{ name: string; declares: PackDeclaration }> = [];
  for (const [name, specifier] of Object.entries(BUILTIN_FRAMEWORKS)) {
    const mod = (await import(specifier)) as { declares?: PackDeclaration };
    if (mod.declares !== undefined) {
      found.push({ name, declares: mod.declares });
    }
  }
  return found;
}

/**
 * A pack missing from this table still loads through the dynamic import
 * fallback, but the error message's list of packs leaves it out. A test
 * checks that every pack the CLI depends on is here.
 */
export const BUILTIN_FRAMEWORKS: Record<string, string> = {
  "ts-rest": "@suss/packs/ts-rest",
  "react-router": "@suss/packs/react-router",
  express: "@suss/packs/express",
  fastify: "@suss/packs/fastify",
  hono: "@suss/packs/hono",
  nextjs: "@suss/packs/nextjs",
  react: "@suss/packs/react",
  "react-query": "@suss/packs/react-query",
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
  "aws-sns": "@suss/packs/aws-sns",
  "aws-eventbridge": "@suss/packs/aws-eventbridge",
  "aws-dynamodb": "@suss/packs/aws-dynamodb",
  "aws-s3": "@suss/packs/aws-s3",
  "aws-secrets-manager": "@suss/packs/aws-secrets-manager",
  "aws-ssm": "@suss/packs/aws-ssm",
  gcs: "@suss/packs/gcs",
  bigquery: "@suss/packs/bigquery",
  "bigquery-python": "@suss/packs/bigquery-python",
  pg: "@suss/packs/pg",
  redis: "@suss/packs/redis",
  zustand: "@suss/packs/zustand",
  fetch: "@suss/packs/fetch",
  axios: "@suss/packs/axios",
  "apollo-client": "@suss/packs/apollo-client",
  node: "@suss/packs/node",
  "package-exports": "@suss/packs/package-exports",
  fastapi: "@suss/packs/fastapi",
  "flask-restx": "@suss/packs/flask-restx",
  "graphql-ruby": "@suss/packs/graphql-ruby",
  sqlalchemy: "@suss/packs/sqlalchemy",
  sqlmodel: "@suss/packs/sqlmodel",
  activerecord: "@suss/packs/activerecord",
  "bigquery-ruby": "@suss/packs/bigquery-ruby",
  "pg-ruby": "@suss/packs/pg-ruby",
  rails: "@suss/packs/rails",
  requests: "@suss/packs/requests",
  httpx: "@suss/packs/httpx",
  aiohttp: "@suss/packs/aiohttp",
  faraday: "@suss/packs/faraday",
  "net-http": "@suss/packs/net-http",
};

/** Packs that read something other than TypeScript. */
const PACK_LANGUAGE: Record<string, Language> = {
  fastapi: "python",
  "flask-restx": "python",
  "graphql-ruby": "ruby",
  sqlalchemy: "python",
  sqlmodel: "python",
  "bigquery-python": "python",
  activerecord: "ruby",
  "bigquery-ruby": "ruby",
  "pg-ruby": "ruby",
  rails: "ruby",
  requests: "python",
  httpx: "python",
  aiohttp: "python",
  faraday: "ruby",
  "net-http": "ruby",
};

/** Which language's adapter reads the code this pack describes. */
export function languageOfPack(name: string): Language {
  return PACK_LANGUAGE[name] ?? "typescript";
}

/** A `-f` spec split at its `=` into the pack name and the config path. */
function splitSpec(spec: string): { name: string; configPath?: string } {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    return { name: spec };
  }
  return {
    name: spec.slice(0, separator),
    configPath: spec.slice(separator + 1),
  };
}

/**
 * The spec with a relative config path resolved against `base`.
 * parseFrameworkSpec reads a relative path against the working directory,
 * which is what a user typing `-f` expects. A spec written in `suss.json`
 * is relative to the project root, and a run can start anywhere, so it
 * goes through here before it is loaded.
 */
export function packSpecFrom(base: string, spec: string): string {
  const { name, configPath } = splitSpec(spec);
  if (configPath === undefined) {
    return spec;
  }
  return `${name}=${path.resolve(base, configPath)}`;
}

export function parseFrameworkSpec(spec: string): {
  name: string;
  options?: unknown;
  /** Absolute path of the file the options came from, when they came from one. */
  configFile?: string;
} {
  const { name, configPath } = splitSpec(spec);
  if (configPath === undefined) {
    return { name };
  }

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
 * Adds `configDirectory` to the options a pack gets. A path option is
 * relative to its config file, or to the directory the run reads when
 * there is no config file. Which options are paths is up to the pack,
 * so it gets the directory and resolves them itself. Resolving against
 * the working directory would fail without an error: the project's routes
 * file would look missing and every field would look unwired.
 */
function optionsForFactory(
  options: unknown,
  configFile: string | undefined,
  projectRoot: string | undefined,
  schema: z.ZodObject<z.ZodRawShape> | undefined,
): unknown {
  const directory =
    configFile !== undefined ? path.dirname(configFile) : projectRoot;
  if (
    directory === undefined ||
    !takesConfigDirectory(schema, configFile) ||
    Array.isArray(options) ||
    (options !== undefined && (options === null || typeof options !== "object"))
  ) {
    return options;
  }
  const given = options as Record<string, unknown> | undefined;
  if (configFile !== undefined && given !== undefined) {
    warnAboutMissingPaths(given, configFile, directory);
  }
  return { ...given, configDirectory: directory };
}

/**
 * Warns about a path option that points at nothing. A relative path in a
 * pack config is read against the config file, so a config kept outside
 * the project points at a directory that is not there. Every class lookup
 * through it then comes back empty, and the run reports gaps for classes
 * the project does have. The warning costs one stat per path option.
 */
function warnAboutMissingPaths(
  options: Record<string, unknown>,
  configFile: string,
  directory: string,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (
      typeof value !== "string" ||
      !/(^|[a-z])(root|file|dir|path)/i.test(key)
    ) {
      continue;
    }

    const resolved = path.isAbsolute(value)
      ? value
      : path.resolve(directory, value);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(
        `${configFile} says ${key} is ${value}, and there is nothing at ${resolved}. A relative path is read against the config file, so a config kept outside the project points at nothing.\n`,
      );
    }
  }
}

/**
 * A pack without a schema does not declare whether it reads the
 * directory. It gets one when there is a config file, and none without
 * one, since a strict factory would refuse the extra key.
 */
function takesConfigDirectory(
  schema: z.ZodObject<z.ZodRawShape> | undefined,
  configFile: string | undefined,
): boolean {
  if (schema === undefined) {
    return configFile !== undefined;
  }
  return "configDirectory" in schema.shape;
}

interface LoadedFactory {
  name: string;
  /** The config file's options, plus any stub statements. The cache key reads these. */
  options: unknown;
  /** The same options, plus `configDirectory` when the pack reads it. The factory gets these. */
  handedOver: unknown;
  factory: PackFactory;
  specifier: string;
}

/**
 * The module specifier each pack in this process was imported from. The
 * ts-morph check uses it to find which copy each pack resolves to. That
 * depends on the run, so it is recorded here, where the imports happen.
 */
const loadedFrom = new Map<string, string>();

export function packsLoadedSoFar(): Array<{
  name: string;
  specifier: string;
}> {
  return [...loadedFrom].map(([name, specifier]) => ({ name, specifier }));
}

/**
 * The config with any retired key removed, after warning about it. suss
 * now reads what those keys stated from the project itself, so the run
 * gives the same answer with or without them and does not need to fail.
 */
function withoutRetired(name: string, options: unknown): unknown {
  if (options === null || typeof options !== "object") {
    return options;
  }
  const entries = Object.entries(options as Record<string, unknown>);
  const used = retiredOptionsUsed(
    name,
    entries.map(([key]) => key),
  );
  if (used.length === 0) {
    return options;
  }
  process.stderr.write(retiredOptionWarning(name, used));
  return Object.fromEntries(entries.filter(([key]) => !used.includes(key)));
}

/**
 * Refuses a config the pack could not read, before the factory runs.
 * Otherwise a misspelled key is dropped, the run exits 0, and the only
 * sign is a boundary that never appears.
 */
function assertOptionsArePackable(
  name: string,
  mod: PackModule,
  options: unknown,
  configFile: string | undefined,
): void {
  const declared = mod.optionsSchema;
  if (declared === undefined || options === undefined) {
    return;
  }

  const schema = whatAConfigFileMaySay(name, declared);
  const parsed = schema.safeParse(withoutRetired(name, options));
  if (parsed.success) {
    return;
  }

  throw new UsageError(
    [
      `The ${name} pack cannot read ${configFile ?? `the config given to -f ${name}`}:`,
      ...parsed.error.issues.flatMap((issue) =>
        optionProblems(name, issue).map((line) => `  ${line}`),
      ),
      whatThePackTakes(name, schema),
    ].join("\n"),
  );
}

/**
 * The pack's schema without the keys a config file may not set (#673).
 * Stubs write the stub-only keys into the options the factory gets, and
 * the CLI adds `configDirectory` itself. The factory's schema declares
 * both so it can read them, and this schema refuses them in a project's
 * own config file.
 */
function whatAConfigFileMaySay(
  name: string,
  declared: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  const supplied = [...stubOnlyOptionsOf(name), "configDirectory"].filter(
    (key) => key in declared.shape,
  );
  if (supplied.length === 0) {
    return declared;
  }
  return declared.omit(Object.fromEntries(supplied.map((key) => [key, true])));
}

function whatThePackTakes(
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
): string {
  const keys = Object.keys(schema.shape);
  if (keys.length === 0) {
    return `The ${name} pack does not take any option from a config file.`;
  }
  return `The ${name} pack takes: ${keys.join(", ")}.`;
}

/** One line per problem, starting with the key the user has to fix. */
function optionProblems(name: string, issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") {
    const stubOnly = new Set(stubOnlyOptionsOf(name));
    const routed = issue.keys.filter((key) => stubOnly.has(key));
    const retired = retiredOptionsUsed(name, issue.keys);
    const unknown = issue.keys.filter(
      (key) => !stubOnly.has(key) && !retired.includes(key),
    );
    return [
      ...(routed.length > 0 ? [stubOnlyOptionRefusal(routed, name)] : []),
      ...retiredOptionRefusal(name, retired),
      ...(unknown.length > 0 ? [unknownKeys(unknown)] : []),
    ];
  }

  const at = issue.path.length === 0 ? "the config" : issue.path.join(".");
  if (issue.code === "invalid_value") {
    const allowed = issue.values.map((value) => JSON.stringify(value));
    return [`${at} has to be one of ${allowed.join(", ")}.`];
  }

  return [`${at}: ${issue.message}`];
}

function unknownKeys(keys: readonly string[]): string {
  const quoted = keys.map((key) => `"${key}"`).join(", ");
  if (keys.length > 1) {
    return `${quoted} are not options this pack takes.`;
  }
  return `${quoted} is not an option this pack takes.`;
}

async function loadPackFactory(
  spec: string,
  projectRoot?: string,
): Promise<LoadedFactory> {
  const { name, options, configFile } = parseFrameworkSpec(spec);
  const loaded = (mod: PackModule, specifier: string): LoadedFactory => {
    assertOptionsArePackable(name, mod, options, configFile);
    loadedFrom.set(name, specifier);
    return {
      name,
      options,
      handedOver: optionsForFactory(
        options,
        configFile,
        projectRoot,
        mod.optionsSchema,
      ),
      factory: mod.default,
      specifier,
    };
  };

  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    return loaded((await import(builtin)) as PackModule, builtin);
  }

  const candidates = looksLikeAPackage(name)
    ? [name]
    : [`@suss/packs/${name}`, `@suss/framework-${name}`, `@suss/${name}`];
  for (const specifier of candidates) {
    const mod = await importPack(specifier);
    if (mod !== null) {
      return loaded(mod, specifier);
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

/**
 * Loads a TypeScript pack from its `-f` spec. `projectRoot` is the
 * directory the run reads. When the options did not come from a config
 * file, a pack resolves a relative path option against that directory.
 */
export async function resolveFramework(
  spec: string,
  stubOverlay?: StubOverlay,
  projectRoot?: string,
): Promise<PatternPack> {
  const loaded = await loadPackFactory(spec, projectRoot);
  assertPackLanguage(loaded.name, "typescript");
  return instantiatePack<PatternPack>(
    withStubbedOptions(loaded, stubOverlay),
    loaded.specifier,
    loaded.name,
  );
}

/**
 * The loaded factory with stub statements added to both copies of its
 * options. The factory needs them in `handedOver`, and the cache digest
 * needs them in `options` so that editing a stub invalidates the cache.
 */
function withStubbedOptions(
  loaded: LoadedFactory,
  overlay: StubOverlay | undefined,
): LoadedFactory {
  if (overlay === undefined || !overlay.has(loaded.name)) {
    return loaded;
  }
  return {
    ...loaded,
    options: withStubOptions(loaded.name, loaded.options, overlay),
    handedOver: withStubOptions(loaded.name, loaded.handedOver, overlay),
  };
}

export async function resolvePythonPack(
  spec: string,
  stubOverlay?: StubOverlay,
  projectRoot?: string,
): Promise<PythonPack> {
  const loaded = withStubbedOptions(
    await loadPackFactory(spec, projectRoot),
    stubOverlay,
  );
  assertPackLanguage(loaded.name, "python");
  return instantiatePack<PythonPack>(loaded, loaded.specifier, loaded.name);
}

export async function resolveRubyPack(
  spec: string,
  stubOverlay?: StubOverlay,
  projectRoot?: string,
): Promise<RubyPack> {
  const loaded = withStubbedOptions(
    await loadPackFactory(spec, projectRoot),
    stubOverlay,
  );
  assertPackLanguage(loaded.name, "ruby");
  return instantiatePack<RubyPack>(loaded, loaded.specifier, loaded.name);
}

/** A scoped name or a path is a package specifier. Anything else is a pack's short name. */
const looksLikeAPackage = (name: string): boolean =>
  name.startsWith("@") || name.includes("/");

async function importPack(specifier: string): Promise<PackModule | null> {
  try {
    return (await import(specifier)) as PackModule;
  } catch {
    return null;
  }
}

export interface ExtractOptions {
  /**
   * Path to the tsconfig covering the code to read. Without one, suss
   * uses the nearest tsconfig or jsconfig above the working directory,
   * or reads the directory itself when there is none.
   */
  tsconfig?: string;
  /** Directory to read when no tsconfig is given. Defaults to cwd. */
  dir?: string;
  /** The language to read. When left out, suss detects it from the directory. */
  lang?: Language;
  frameworks: string[];
  files?: string[];
  output?: string;
  /**
   * What to do with gaps. `permissive` (the default) and `strict` record
   * the same gaps, and `strict` also exits non-zero when there are any.
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
  /**
   * Let a run that produced no summaries exit 0. Without it, the run
   * fails. Set this when an empty run is expected.
   */
  allowEmpty?: boolean;
  /** Exit non-zero when a pack threw while it was reading. */
  failOnPackError?: boolean;
}

/** Where the code to read comes from. A tsconfig is preferred when one exists, because it has the path aliases. */
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
   * and none of them discovers boundaries, so the run cannot produce a
   * summary whatever the code does.
   */
  recognizersOnly: boolean;
  /**
   * True when the run read only the files passed with --files instead of
   * walking the project. Such a run builds no extraction funnel, so a
   * missing funnel does not mean the result came from the cache.
   */
  explicitFiles: boolean;
}

interface LanguageRunOptions {
  options: ExtractOptions;
  /** The directory the command was pointed at. */
  root: string;
  submodules: readonly Submodule[];
}

/**
 * A file given on the command line is read whatever repository it is in.
 * A walk of the directory keeps only this project's own files.
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
  // Ids and the written summaries' paths are both relative to this root,
  // so a reader can rebuild an id from a summary's own fields.
  const runRoot = workspaceRootFor(source.root);
  const stubOverlay = stubOverlayOf(loadStubs(runRoot));
  const packs = await Promise.all(
    options.frameworks.map((one) =>
      resolveFramework(one, stubOverlay, runRoot),
    ),
  );
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

  const namedFiles = options.files ?? [];
  const explicitFiles = namedFiles.length > 0;
  const summaries = explicitFiles
    ? await adapter.extractFromFiles(namedFiles.map((f) => path.resolve(f)))
    : await adapter.extractAll();

  // extractFromFiles builds no extraction report and so no walked count.
  // The length of the given list is the number of files read.
  return {
    summaries,
    root: runRoot,
    filesRead: explicitFiles
      ? namedFiles.length
      : ((extractionReport as ExtractionReport | null)?.filesWalked ?? 0),
    timingReport,
    cacheDiagnostic,
    extractionReport,
    recognizersOnly:
      packs.length > 0 &&
      packs.every(
        (p) => p.discovery.length === 0 && p.discoverUnits === undefined,
      ),
    explicitFiles,
  };
}

async function runPython(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const stubOverlay = pythonStubOverlay(runOptions);
  const packs = await Promise.all(
    runOptions.options.frameworks.map((one) =>
      resolvePythonPack(one, stubOverlay, runOptions.root),
    ),
  );
  // Each checked-out submodule becomes an import root, or imports into
  // the shared framework inside it do not resolve.
  const submodules = runOptions.submodules;
  const files = filesToRead(runOptions, findPythonFiles, submodules);

  let timingReport: TimingReport | null = null;
  let extractionReport: ExtractionReport | null = null;
  let cacheDiagnostic: CacheDiagnostic | null = null;
  const { summaries, roots, unreadManifests } = await extractPythonProject({
    files,
    packs,
    additionalRoots: submodules
      .filter((submodule) => submodule.checkedOut)
      .map((submodule) => submodule.directory),
    projectRoot: runOptions.root,
    ...(runOptions.options.gaps !== undefined
      ? { gapHandling: runOptions.options.gaps }
      : {}),
    ...(runOptions.options.noCache === true ? { cacheDir: null } : {}),
    onTiming: (report) => {
      timingReport = report;
    },
    onExtractionReport: (report) => {
      extractionReport = report;
    },
    onCacheDiagnostic: (diagnostic) => {
      cacheDiagnostic = diagnostic;
    },
  });
  process.stderr.write(
    formatUnreadManifests(unreadManifests, runOptions.root, roots),
  );
  return languageRun(
    summaries,
    runOptions.root,
    files.length,
    packs.length > 0 && packs.every((p) => p.discovery.length === 0),
    timingReport,
    extractionReport,
    cacheDiagnostic,
  );
}

/** Empty when every manifest was read. */
export function formatUnreadManifests(
  unread: readonly UnreadManifest[],
  projectRoot: string,
  roots: readonly string[],
): string {
  const searched = roots
    .map((dir) => path.relative(projectRoot, dir) || ".")
    .join(", ");
  return unread
    .map(
      ({ where, reason }) =>
        `[suss] Could not read ${where} to find where the Python sources are, because ${reason}.\n[suss] Absolute imports resolve against ${searched}.\n`,
    )
    .join("");
}

async function runRuby(runOptions: LanguageRunOptions): Promise<LanguageRun> {
  const stubOverlay = pythonStubOverlay(runOptions);
  const packs = await Promise.all(
    runOptions.options.frameworks.map((one) =>
      resolveRubyPack(one, stubOverlay, runOptions.root),
    ),
  );
  // findRubyFiles skips .git directories but still walks the rest of a
  // nested repository, so filesToRead drops those files.
  const files = filesToRead(runOptions, findRubyFiles, runOptions.submodules);
  let timingReport: TimingReport | null = null;
  let extractionReport: ExtractionReport | null = null;
  let cacheDiagnostic: CacheDiagnostic | null = null;
  const { summaries } = await extractRubyProject({
    files,
    packs,
    projectRoot: runOptions.root,
    ...(runOptions.options.gaps !== undefined
      ? { gapHandling: runOptions.options.gaps }
      : {}),
    ...(runOptions.options.noCache === true ? { cacheDir: null } : {}),
    onTiming: (report) => {
      timingReport = report;
    },
    onExtractionReport: (report) => {
      extractionReport = report;
    },
    onCacheDiagnostic: (diagnostic) => {
      cacheDiagnostic = diagnostic;
    },
  });
  return languageRun(
    summaries,
    runOptions.root,
    files.length,
    packs.length > 0 && packs.every((p) => p.discovery.length === 0),
    timingReport,
    extractionReport,
    cacheDiagnostic,
  );
}

function languageRun(
  summaries: BehavioralSummary[],
  root: string,
  filesRead: number,
  recognizersOnly: boolean,
  timingReport: TimingReport | null,
  extractionReport: ExtractionReport | null,
  cacheDiagnostic: CacheDiagnostic | null,
): LanguageRun {
  return {
    summaries,
    root,
    filesRead,
    timingReport,
    cacheDiagnostic,
    extractionReport,
    recognizersOnly,
    // Python and Ruby build a report even with --files, so downstream
    // code has no reason to tell the two kinds of run apart.
    explicitFiles: false,
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

  // resolveSource reads a directory as TypeScript when a tsconfig is
  // above it, so detection has to take that same tsconfig into account.
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
  return languageOfPack(splitSpec(spec).name);
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

  // Skip the warning about projects below when a tsconfig says what to
  // read, since that was the user's choice. Python and Ruby have no such
  // file and always read the whole directory.
  if (
    language !== "typescript" ||
    resolveSource(options).kind === "directory"
  ) {
    process.stderr.write(
      formatProjectsBelow(projectsBelow(root, language), language),
    );
  }

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
    relativizeSummaryPaths(summary, projectRoot);
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
      run.explicitFiles
        ? "--files reads exactly the files it was given, so there is no funnel breakdown to show. Drop --files to walk the project and see where each pack stood.\n"
        : "These summaries came back from the cache, so there is no breakdown of where they came from. Run this again with --no-cache to walk the files and get one.\n",
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

    // Problems the user can fix always print. Problems only a pack's
    // author can fix print with `--explain`.
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

  if (options.allowEmpty !== true && summaries.length === 0) {
    process.stderr.write(
      "Failing because the extract produced no summaries. Pass --allow-empty when that is expected.\n",
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

/** Enough unreadable files for the user to see the pattern. */
const UNREADABLE_FILES_SHOWN = 5;

/**
 * The incompleteness note goes in its own file beside the summaries,
 * because every reader of the summaries expects a bare array.
 */
export function incompletenessPathFor(summariesPath: string): string {
  const ext = path.extname(summariesPath);
  const base = summariesPath.slice(0, summariesPath.length - ext.length);
  return `${base}.incomplete${ext === "" ? ".json" : ext}`;
}

/**
 * Writes the incompleteness note, or deletes one an earlier run left
 * when this run read everything, so a stale note cannot fail a job that
 * has since been fixed.
 */
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
      "suss follows the project's own imports to get there, through a barrel or a module that builds the client, and into a directory the library's generator wrote. So either this project does not use it, or the code reaches it some way no import shows.",
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
 * Replaces the discovery-stage message when no pack in the run can
 * discover boundaries. The default message blames the code, but here the
 * code is fine: a recognizer-only pack reads what happens inside a
 * boundary that another pack has to find first. `packSpecs` are the
 * user's -f flags, so the suggested command is theirs with one pack added.
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

/** A pack per language that discovers boundaries, used in the suggested command. */
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

    // A pack made only of recognizers discovers no boundary. The rows
    // below would print three zeros for it and make it look broken.
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

/**
 * Rewrites a summary's paths relative to the project root. The adapter
 * writes every path absolute, and the written summaries are relative, so
 * every field that contains a path is rewritten here: the unit's file, the
 * boundary binding, render targets, module imports, wrappers and type refs.
 */
export function relativizeSummaryPaths(
  summary: BehavioralSummary,
  projectRoot: string,
): void {
  summary.location.file = path.relative(projectRoot, summary.location.file);
  const binding = summary.identity.boundaryBinding;
  if (binding !== null && binding !== undefined) {
    summary.identity.boundaryBinding = withRewrittenPaths(binding, (one) =>
      path.isAbsolute(one) ? path.relative(projectRoot, one) : one,
    );
  }
  for (const transition of summary.transitions) {
    if (transition.output.type === "render" && transition.output.root) {
      relativizeRenderTargets(transition.output.root, projectRoot);
    }
  }
  const moduleImports = summary.metadata?.moduleImports;
  if (Array.isArray(moduleImports)) {
    summary.metadata = {
      ...summary.metadata,
      moduleImports: moduleImports.map((file) =>
        typeof file === "string" ? path.relative(projectRoot, file) : file,
      ),
    };
  }
  relativizeWrapperPaths(summary, projectRoot);
  relativizeTypeRefs(summary, projectRoot);
}

/**
 * A ref type records the file its type is declared in. Types appear in a
 * dozen places in a summary, such as inputs and effect payloads, so this
 * walks the whole summary instead of listing them.
 */
function relativizeTypeRefs(value: unknown, projectRoot: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      relativizeTypeRefs(item, projectRoot);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === "ref" &&
    typeof record.from === "string" &&
    path.isAbsolute(record.from)
  ) {
    record.from = path.relative(projectRoot, record.from);
  }
  for (const child of Object.values(record)) {
    relativizeTypeRefs(child, projectRoot);
  }
}

/** Rewrites the file of each wrapper around this unit, both on the unit and on the transitions a wrapper contributed. */
function relativizeWrapperPaths(
  summary: BehavioralSummary,
  projectRoot: string,
): void {
  const wrappers = readWrapperMetadata(summary);
  const applied = wrappers?.applied ?? [];
  if (applied.length > 0) {
    summary.metadata = withWrapperMetadata(summary.metadata, {
      applied: applied.map((wrapper) =>
        relativizeWrapper(wrapper, projectRoot),
      ),
    });
  }
  for (const transition of summary.transitions) {
    const from = readWrapperMetadata(transition)?.from;
    if (from === undefined) {
      continue;
    }
    transition.metadata = withWrapperMetadata(transition.metadata, {
      from: relativizeWrapper(from, projectRoot),
    });
  }
}

function relativizeWrapper(
  wrapper: WrapperReference,
  projectRoot: string,
): WrapperReference {
  return {
    ...wrapper,
    file: path.isAbsolute(wrapper.file)
      ? path.relative(projectRoot, wrapper.file)
      : wrapper.file,
  };
}

export function relativizeRenderTargets(
  root: RenderNode,
  projectRoot: string,
): void {
  if (root.type === "conditional") {
    relativizeRenderTargets(root.whenTrue, projectRoot);
    if (root.whenFalse !== null) {
      relativizeRenderTargets(root.whenFalse, projectRoot);
    }
    return;
  }
  if (root.type !== "element") {
    return;
  }
  if (root.target !== undefined) {
    root.target.file = path.relative(projectRoot, root.target.file);
  }
  for (const child of root.children) {
    relativizeRenderTargets(child, projectRoot);
  }
}

/** The stub overlay for a Python or Ruby run, loaded from the run's root. */
function pythonStubOverlay(runOptions: LanguageRunOptions): StubOverlay {
  return stubOverlayOf(loadStubs(runOptions.root));
}
