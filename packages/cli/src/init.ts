/**
 * `suss init` works out which packs a project needs and prints the
 * commands to run them.
 *
 * Picking packs by hand means reading the pack list, matching it against
 * the project's dependencies, and knowing that a SAM template needs one
 * contract reader while a Prisma schema needs another. Everything needed
 * to decide is already on disk. The dependency manifests list the
 * frameworks and clients, and spec files point to the contract sources.
 *
 * This module writes and installs nothing. Its output is a list of
 * commands, which a user can paste, put in CI, or adapt.
 */

import fs from "node:fs";
import path from "node:path";

import { findNearestTsconfig, TSCONFIG_NAMES } from "@suss/adapter-typescript";
import { describesOperations, describesTypes } from "@suss/contract-graphql";
import { isConfigurationFile } from "@suss/contract-wrangler";
import { commonDirectoryOf } from "@suss/extractor";

import { readContract } from "./contract.js";
import {
  contentByBoundary,
  contractsCoveredByAnother,
} from "./contractCopies.js";
import {
  readPythonDependencies,
  readRubyDependencies,
} from "./dependencyManifests.js";
import { builtinDeclarations } from "./extract.js";
import { readSubmodules } from "./gitSubmodules.js";
import {
  detectLanguages,
  LANGUAGE_LABEL,
  projectFilesOf,
  SKIP_DIRECTORIES,
} from "./language.js";
import {
  extractReadsAnything,
  firstSourceMatching,
  PROJECT_WALK_DEPTH,
  TEST_DIRECTORIES,
} from "./projectSource.js";
import { bold, cyan, dim, green, yellow } from "./style.js";

import type { PackConfiguration, PackDeclaration } from "@suss/ir-core";
import type { ContractSource } from "./contract.js";
import type { ContentByBoundary } from "./contractCopies.js";
import type { UnreadDependencies } from "./dependencyManifests.js";
import type { Language } from "./language.js";

export type { PackConfiguration };

export interface PackSuggestion {
  /** The `-f` name, or the `--from` name for a contract source. */
  name: string;
  /** The npm package to install. */
  packageName: string;
  /** The dependency or file in the project that led to this suggestion. */
  because: string;
  /**
   * What this pack contributes. An `effects` pack recognises calls inside
   * units that another pack found, so run on its own it finds nothing.
   */
  kind: "framework" | "client" | "contract" | "effects";
  /** For a contract source, the file to read. */
  file?: string;
  /** Which language's code this pack reads. Contract sources have none. */
  language?: Language;
  /**
   * True when the pack reads a library that comes with the language.
   * Every project in that language can use it, and none declares it.
   */
  shippedWithLanguage?: boolean;
  /**
   * For a pack that comes with the language, a file that calls the
   * library. With one, the pack is a reason to set the project up.
   */
  calledIn?: string;
  configuration?: PackConfiguration;
}

export interface InitReport {
  root: string;
  /** Null when the project has no tsconfig. */
  tsconfig: string | null;
  suggestions: PackSuggestion[];
  /** Every language suss found source for here. */
  languages?: Language[];
  /** Manifests suss could not read, so the report does not look like a project with no dependencies. */
  unread?: UnreadDependencies[];
  /** Frameworks the project depends on that suss recognises but has no pack for. */
  recognizedWithoutPack?: string[];
  /** Contract files whose reader found nothing in them, so no command reads them. Only `withReadableContracts` fills it. */
  emptyContracts?: EmptyContract[];
  /** Contract files whose every boundary another file here also declares. Only `withReadableContracts` fills it. */
  coveredContracts?: CoveredContract[];
  /** Languages whose extract would have no file to read here, so no command reads them. Only `withReadableCode` fills it. */
  emptyExtracts?: EmptyExtract[];
}

export interface EmptyContract {
  name: string;
  because: string;
  reason: string;
  /** What the reader said while it read, such as a `$ref` it could not follow. */
  warnings: string[];
}

export interface CoveredContract {
  name: string;
  because: string;
  /** The file, relative to the project, whose command reads the same boundaries. */
  coveredBy: string;
}

export interface EmptyExtract {
  language: Language;
  /** The packs the extract would have run. */
  packs: string[];
  reason: string;
}

type Ecosystem = "npm" | "pypi" | "rubygems";

/**
 * Frameworks and clients that no pack reads yet. The report mentions
 * each one the project depends on, including when other packs
 * matched: a Django app whose only match is `requests` would otherwise
 * look fully read (#229).
 */
const RECOGNIZED_WITHOUT_A_PACK: Array<{
  ecosystem: Ecosystem;
  dependency: string;
  /** What to call it, when the package name is not what people call it. */
  label?: string;
}> = [
  { ecosystem: "pypi", dependency: "flask" },
  { ecosystem: "pypi", dependency: "quart" },
  { ecosystem: "pypi", dependency: "django" },
  {
    ecosystem: "pypi",
    dependency: "djangorestframework",
    label: "Django REST framework",
  },
  { ecosystem: "pypi", dependency: "bottle" },
  { ecosystem: "npm", dependency: "koa" },
  { ecosystem: "npm", dependency: "@hapi/hapi" },
  { ecosystem: "npm", dependency: "@trpc/server", label: "tRPC" },
  {
    ecosystem: "npm",
    dependency: "@angular/common",
    label: "Angular's HttpClient",
  },
  { ecosystem: "rubygems", dependency: "sinatra" },
  { ecosystem: "rubygems", dependency: "grape" },
];

const BY_FILE: Array<{
  matches: (filename: string, file: string) => boolean;
  name: string;
  packageName: string;
  /** Suggest one command for the directory instead of one per file. */
  perDirectory?: boolean;
  describe: (relativePath: string) => string;
}> = [
  {
    matches: (f) => f === "template.yaml" || f === "template.yml",
    name: "cloudformation",
    packageName: "@suss/contract-cloudformation",
    describe: (p) => `a SAM template at ${p}`,
  },
  {
    matches: (f) => f === "serverless.yml" || f === "serverless.yaml",
    name: "serverless",
    packageName: "@suss/contract-serverless",
    describe: (p) => `a Serverless Framework service at ${p}`,
  },
  {
    matches: (f) => isConfigurationFile(f),
    name: "wrangler",
    packageName: "@suss/contract-wrangler",
    describe: (p) => `a Cloudflare Worker at ${p}`,
  },
  {
    matches: (f) => f === "schema.prisma",
    name: "prisma",
    packageName: "@suss/contract-prisma",
    describe: (p) => `a Prisma schema at ${p}`,
  },
  {
    matches: (f, file) => isGraphqlFile(f) && declaresTypes(file),
    name: "graphql",
    packageName: "@suss/contract-graphql",
    describe: (p) => `a GraphQL schema at ${p}`,
  },
  {
    // Projects write one operations file per screen, so the reader takes
    // the whole directory.
    matches: (f, file) =>
      isGraphqlFile(f) && !declaresTypes(file) && declaresOperations(file),
    name: "graphql-documents",
    packageName: "@suss/contract-graphql",
    perDirectory: true,
    describe: (p) => `GraphQL operations under ${p}`,
  },
  {
    // The OpenAPI reader also reads Swagger 2.0, and a Swagger project
    // usually calls its file swagger.json. A spec named after the product
    // is found by the version line at its top.
    matches: (f, file) =>
      /^(openapi|swagger)\.(ya?ml|json)$/.test(f) ||
      (/\.(ya?ml|json)$/.test(f) && declaresOpenApiVersion(file)),
    name: "openapi",
    packageName: "@suss/contract-openapi",
    describe: (p) => `an OpenAPI document at ${p}`,
  },
  {
    // Projects write one stories file per component, so the reader takes
    // the whole directory.
    matches: (f) => f.endsWith(".stories.tsx") || f.endsWith(".stories.ts"),
    name: "storybook",
    packageName: "@suss/contract-storybook",
    perDirectory: true,
    describe: (p) => `Storybook stories under ${p}`,
  },
];

const isGraphqlFile = (filename: string): boolean =>
  (filename.endsWith(".graphql") || filename.endsWith(".gql")) &&
  !filename.includes(".test.");

/** Tells a schema, which declares types, from a project's operations file, which does not. */
function declaresTypes(file: string): boolean {
  return describesTypes(textOf(file));
}

/**
 * Whether a document contains an operation. A file of fragments alone
 * gets inlined by codegen into the operations that spread them, and
 * reading it by itself does not turn up a boundary.
 */
function declaresOperations(file: string): boolean {
  return describesOperations(textOf(file));
}

/** How much of a JSON or YAML file to read when looking for an OpenAPI version. */
const SPEC_HEAD_BYTES = 4096;

/**
 * Whether the start of a JSON or YAML file says which OpenAPI or Swagger
 * version it follows. Every spec starts with that key or has it near the
 * top, so the rest of the file is not read.
 */
function declaresOpenApiVersion(file: string): boolean {
  const head = headOf(file, SPEC_HEAD_BYTES);
  return (
    /"(openapi"\s*:\s*"3|swagger"\s*:\s*"2)\./.test(head) ||
    /^(openapi:\s*["']?3|swagger:\s*["']?2)\./m.test(head)
  );
}

function headOf(file: string, bytes: number): string {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

function textOf(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const LANGUAGE_OF: Record<Ecosystem, Language> = {
  npm: "typescript",
  pypi: "python",
  rubygems: "ruby",
};

export async function inspectProject(root: string): Promise<InitReport> {
  const resolved = path.resolve(root);
  const packs = await builtinDeclarations();
  const suggestions: PackSuggestion[] = [];
  const seen = new Set<string>();

  const add = (suggestion: PackSuggestion): void => {
    const key = `${suggestion.kind}:${suggestion.name}:${suggestion.file ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    suggestions.push(suggestion);
  };

  const declared = declaredLibraries(resolved);
  for (const library of declared.named) {
    for (const pack of packs) {
      const dependency = pack.declares.dependencies.find(
        (candidate) =>
          candidate.ecosystem === library.ecosystem &&
          candidate.name === library.name,
      );
      if (dependency === undefined) {
        continue;
      }

      add({
        name: pack.name,
        packageName: pack.declares.package,
        because: `${library.name} in ${library.where}`,
        kind: pack.declares.kind,
        language: LANGUAGE_OF[dependency.ecosystem],
        ...(pack.declares.configuration !== undefined
          ? { configuration: pack.declares.configuration }
          : {}),
      });
    }
  }

  const submodules = new Set(
    readSubmodules(resolved).map((submodule) => submodule.directory),
  );
  /** Matched files for each directory-level reader, keyed by reader name. */
  const walked = new Map<string, string[]>();
  for (const file of filesUnder(resolved, submodules)) {
    const relative = path.relative(resolved, file);
    const filename = path.basename(file);
    for (const rule of BY_FILE) {
      if (!rule.matches(filename, file)) {
        continue;
      }

      // A directory-level reader gets one command for all its files. Any
      // other reader gets a command per file, since two SAM templates in
      // one repository are two services.
      if (rule.perDirectory === true) {
        walked.set(rule.name, [...(walked.get(rule.name) ?? []), file]);
        continue;
      }

      add({
        name: rule.name,
        packageName: rule.packageName,
        because: rule.describe(relative),
        kind: "contract",
        file: relative,
      });
    }
  }

  for (const [name, files] of walked) {
    const rule = BY_FILE.find((candidate) => candidate.name === name);
    if (rule === undefined) {
      continue;
    }
    const directory =
      path.relative(resolved, commonDirectoryOf(files) ?? resolved) || ".";

    add({
      name,
      packageName: rule.packageName,
      because: rule.describe(directory),
      kind: "contract",
      file: directory,
    });
  }

  // Net::HTTP comes with Ruby and fetch with the runtime, so no manifest
  // lists them. Their packs are suggested whenever the project has
  // source in that language.
  const languages = detectLanguages(resolved);
  for (const pack of packs) {
    const language = pack.declares.shippedWith;
    if (language === undefined || !languages.includes(language)) {
      continue;
    }

    const calledIn = callOfShippedLibrary(
      resolved,
      language,
      pack.declares,
      suggestions,
    );
    add({
      name: pack.name,
      packageName: pack.declares.package,
      because:
        calledIn === null
          ? `${LANGUAGE_LABEL[language]} sources, and ${pack.name} reads what the language itself ships`
          : `${pack.name} is called in ${calledIn}`,
      kind: pack.declares.kind,
      language,
      shippedWithLanguage: true,
      ...(calledIn === null ? {} : { calledIn }),
    });
  }

  const tsconfig = TSCONFIG_NAMES.map((name) => path.join(resolved, name)).find(
    (candidate) => fs.existsSync(candidate),
  );

  const recognizedWithoutPack = [
    ...new Set(
      declared.named.flatMap((library) => {
        const entry = RECOGNIZED_WITHOUT_A_PACK.find(
          (candidate) =>
            candidate.ecosystem === library.ecosystem &&
            candidate.dependency === library.name,
        );
        return entry === undefined ? [] : [entry.label ?? entry.dependency];
      }),
    ),
  ];

  return {
    root: resolved,
    tsconfig: tsconfig ?? null,
    suggestions: withoutIdleShippedPacks(suggestions),
    languages,
    unread: declared.unread,
    recognizedWithoutPack,
  };
}

/**
 * A pack that comes with the language says nothing about a project in
 * which no pack of that language counts, so it is left out there.
 */
function withoutIdleShippedPacks(
  suggestions: ReadonlyArray<PackSuggestion>,
): PackSuggestion[] {
  const languagesThatCount = new Set(
    suggestions.filter(countsForProject).map(languageOf),
  );
  return suggestions.filter(
    (suggestion) =>
      suggestion.kind === "contract" ||
      languagesThatCount.has(languageOf(suggestion)),
  );
}

/**
 * The report with each contract whose reader finds nothing in its file
 * moved out of the suggestions, with why. The file looked like a contract
 * by its name or first lines, and only the reader can say whether anything
 * in it is readable.
 *
 * Only `init` asks this, because it prints commands for a person to run.
 * A bare `check` and `--out-dir` run the readers anyway and keep to a
 * time budget, so they take the report as `inspectProject` gives it.
 */
export async function withReadableContracts(
  report: InitReport,
): Promise<InitReport> {
  const emptyContracts: EmptyContract[] = [];
  const dropped = new Set<PackSuggestion>();
  const contentRead = new Map<PackSuggestion, ContentByBoundary | null>();
  for (const suggestion of report.suggestions) {
    if (suggestion.kind !== "contract" || suggestion.file === undefined) {
      continue;
    }
    const read = await readForInit(
      suggestion.name as ContractSource,
      path.join(report.root, suggestion.file),
    );
    if ("content" in read) {
      contentRead.set(suggestion, read.content);
      continue;
    }
    dropped.add(suggestion);
    emptyContracts.push({
      name: suggestion.name,
      because: suggestion.because,
      ...read,
    });
  }

  const coveredContracts = contractsCoveredByAnother(report.root, contentRead);
  for (const { suggestion } of coveredContracts) {
    dropped.add(suggestion);
  }
  if (dropped.size === 0) {
    return report;
  }

  return {
    ...report,
    suggestions: withoutIdleShippedPacks(
      report.suggestions.filter((suggestion) => !dropped.has(suggestion)),
    ),
    emptyContracts: [...(report.emptyContracts ?? []), ...emptyContracts],
    coveredContracts: [
      ...(report.coveredContracts ?? []),
      ...coveredContracts.map(({ suggestion, coveredBy }) => ({
        name: suggestion.name,
        because: suggestion.because,
        coveredBy,
      })),
    ],
  };
}

/**
 * What each boundary the reader gives says, or why it gives nothing.
 * What the reader would print on stderr is collected, since it belongs
 * to the `contract` run.
 */
async function readForInit(
  from: ContractSource,
  spec: string,
): Promise<
  { content: ContentByBoundary | null } | { reason: string; warnings: string[] }
> {
  const warnings: string[] = [];
  try {
    const summaries = await readContract({ from, spec, warnings });
    if (summaries.length > 0) {
      return { content: contentByBoundary(summaries) };
    }

    return {
      reason: `the ${from} reader found nothing it reads there`,
      warnings,
    };
  } catch (error) {
    return {
      reason: `the ${from} reader could not read it: ${error instanceof Error ? error.message : String(error)}`,
      warnings,
    };
  }
}

/**
 * The report with each language whose extract wouldn't find a file to
 * read moved out of the suggestions, with why. A folder without a
 * tsconfig of its own is read through the nearest one above it, and when
 * that one leaves the folder out, the extract reads nothing and fails.
 */
export function withReadableCode(report: InitReport): InitReport {
  const code = report.suggestions.filter(
    (suggestion) => suggestion.kind !== "contract",
  );
  const languages = [...new Set(code.filter(countsForProject).map(languageOf))];
  const unreadable = languages.filter(
    (language) => !extractReadsAnything(report.root, language),
  );
  if (unreadable.length === 0) {
    return report;
  }

  return {
    ...report,
    suggestions: report.suggestions.filter(
      (suggestion) =>
        suggestion.kind === "contract" ||
        !unreadable.includes(languageOf(suggestion)),
    ),
    emptyExtracts: [
      ...(report.emptyExtracts ?? []),
      ...unreadable.map((language) => ({
        language,
        packs: code
          .filter((suggestion) => languageOf(suggestion) === language)
          .map((suggestion) => suggestion.name),
        reason: whyNoFileIsRead(report.root, language),
      })),
    ],
  };
}

function whyNoFileIsRead(root: string, language: Language): string {
  const tsconfig = language === "typescript" ? findNearestTsconfig(root) : null;
  if (tsconfig === null) {
    return `there is no ${LANGUAGE_LABEL[language]} source here for an extract to read`;
  }

  if (path.dirname(tsconfig) === root) {
    return `${path.basename(tsconfig)} here doesn't include any source file`;
  }
  return `an extract here reads through ${path.relative(root, tsconfig)}, which doesn't include any file in this folder`;
}

interface DeclaredLibrary {
  ecosystem: Ecosystem;
  name: string;
  /** The manifest or field that listed it. */
  where: string;
}

/**
 * The libraries every manifest in the project declares, and the places
 * suss could not read. A submodule that was never checked out counts as
 * unread, because it hides its dependencies the same way an unreadable
 * manifest does.
 */
function declaredLibraries(root: string): {
  named: DeclaredLibrary[];
  unread: UnreadDependencies[];
} {
  const named: DeclaredLibrary[] = dependenciesOf(root).map(
    ([name, where]) => ({ ecosystem: "npm", name, where }),
  );
  const unread: UnreadDependencies[] = [];

  const python = readPythonDependencies(root);
  for (const dependency of python.named) {
    named.push({ ecosystem: "pypi", ...dependency });
  }
  unread.push(...python.unread);

  const ruby = readRubyDependencies(root);
  for (const dependency of ruby.named) {
    named.push({ ecosystem: "rubygems", ...dependency });
  }
  unread.push(...ruby.unread);

  for (const submodule of readSubmodules(root)) {
    if (!submodule.checkedOut) {
      unread.push({
        where: submodule.declaredPath,
        reason:
          "this submodule is not checked out, so suss can read neither the code in it nor what it depends on. Run `git submodule update --init --recursive`.",
        aboutRepository: true,
      });
    }
  }

  return { named, unread };
}

/**
 * A file in the project that calls a library the language ships, or null.
 * The search only matters when nothing else in that language led to a
 * pack, so it is skipped otherwise, which keeps init fast on a large
 * project that already has its framework's pack.
 */
function callOfShippedLibrary(
  root: string,
  language: Language,
  declares: PackDeclaration,
  suggestions: ReadonlyArray<PackSuggestion>,
): string | null {
  if (declares.sourcePattern === undefined) {
    return null;
  }

  const languageAlreadyCounts = suggestions.some(
    (suggestion) =>
      suggestion.language === language && countsForProject(suggestion),
  );
  if (languageAlreadyCounts) {
    return null;
  }

  return firstSourceMatching(root, language, declares.sourcePattern);
}

/**
 * Follows a dependency that resolves inside this repository into that
 * package's own manifest. A service in a monorepo usually depends on its
 * sibling packages, and those declare the SDKs.
 */
function dependenciesOf(root: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; through: string | null }> = [
    { dir: root, through: null },
  ];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      continue;
    }
    const manifest = path.join(next.dir, "package.json");
    if (seen.has(manifest)) {
      continue;
    }
    seen.add(manifest);

    for (const [name, field] of declaredIn(manifest)) {
      found.push([
        name,
        next.through === null ? field : `${field} of ${next.through}`,
      ]);
      const inside = packageInsideRepository(root, next.dir, name);
      if (inside !== null) {
        queue.push({ dir: inside, through: name });
      }
    }
  }
  return found;
}

function declaredIn(manifest: string): Array<[string, string]> {
  if (!fs.existsSync(manifest)) {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return [];
  }

  const found: Array<[string, string]> = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = parsed[field];
    if (deps === null || typeof deps !== "object") {
      continue;
    }
    for (const name of Object.keys(deps as Record<string, string>)) {
      found.push([name, field]);
    }
  }
  return found;
}

/** A workspace package is a symlink in node_modules, so this follows the link to find where it lives. */
function packageInsideRepository(
  root: string,
  from: string,
  name: string,
): string | null {
  const linked = path.join(from, "node_modules", name);
  const candidates = [linked, path.join(root, "node_modules", name)];
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const withinRoot = resolved.startsWith(
      `${fs.realpathSync(root)}${path.sep}`,
    );
    if (
      withinRoot &&
      !resolved.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      return resolved;
    }
  }
  return null;
}

function* filesUnder(
  dir: string,
  submodules: ReadonlySet<string>,
  depth = 0,
): Generator<string> {
  // Projects keep GraphQL operations next to the screens that send them,
  // well down the tree. A folder with its own package.json or repository
  // is skipped below, so the walk stays inside this project.
  if (depth > PROJECT_WALK_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (TEST_DIRECTORIES.has(entry.name)) {
        continue;
      }

      // A directory with its own package.json is a separate project.
      if (depth > 0 && fs.existsSync(path.join(full, "package.json"))) {
        continue;
      }
      // Skip a nested repository unless .gitmodules lists it. A listed
      // submodule contains code this project imports.
      if (
        depth > 0 &&
        fs.existsSync(path.join(full, ".git")) &&
        !submodules.has(path.resolve(full))
      ) {
        continue;
      }
      yield* filesUnder(full, submodules, depth + 1);
    } else {
      yield full;
    }
  }
}

/**
 * The output name for one contract command. When one reader gets several
 * files, each output name includes its source file, so the second
 * command does not overwrite the first command's output.
 */
function contractOutput(
  item: PackSuggestion,
  contracts: ReadonlyArray<PackSuggestion>,
): string {
  const sameReader = contracts.filter(
    (other) => other.name === item.name,
  ).length;
  if (sameReader < 2 || item.file === undefined) {
    return item.name;
  }
  return `${item.name}-${slugOf(item.file.replace(/\.[^./]+$/, ""))}`;
}

/**
 * Whether a pack is a reason to set the project up. A pack for a library
 * that comes with the language fits every project in it, so it counts
 * only once a file in the project calls that library.
 */
export function countsForProject(suggestion: PackSuggestion): boolean {
  return (
    suggestion.shippedWithLanguage !== true || suggestion.calledIn !== undefined
  );
}

/** The packs that something in this project led to. */
export function declaredPacks(report: InitReport): PackSuggestion[] {
  return report.suggestions.filter(countsForProject);
}

/** One `suss` command init prints and the guided form runs, from the directory init ran in. */
export interface ReadCommand {
  /** The arguments after `suss`. */
  args: string[];
  /** For an extract, the language it reads. */
  language?: Language;
  /**
   * True when every pack in an extract reads calls inside units that
   * another pack finds first, so run on its own it comes back empty.
   */
  effectsOnly: boolean;
  /** Config files, from the directory init ran in, that a pack here cannot run without. */
  needsConfig: string[];
}

/**
 * The extract and contract commands for one project, written to run from
 * the directory init ran in: `directory` is where the project is from
 * there. Every output goes into one `summaries/` folder, named for the
 * project, so one `check` over that folder sees every side.
 */
export function readCommands(
  report: InitReport,
  directory = ".",
): ReadCommand[] {
  const prefix = directory === "." ? "" : `${slugOf(directory)}-`;
  const code = inReportOrder(
    report.suggestions.filter((s) => s.kind !== "contract"),
  );
  // A language gets a command once one of its packs counts. The other
  // packs in that language come along, since they read the same files.
  const languages = [...new Set(code.filter(countsForProject).map(languageOf))];
  const mixed = languages.length > 1 || (report.languages ?? []).length > 1;

  const extracts = languages.map((language): ReadCommand => {
    const items = code.filter((item) => languageOf(item) === language);
    const args = ["extract"];
    if (directory !== ".") {
      args.push("--dir", directory);
    }
    // A directory with more than one language is read as whichever its
    // manifest says, so each command says which one it wants.
    if (language !== "typescript" || mixed) {
      args.push("--lang", language);
    }
    for (const item of items) {
      args.push(
        "-f",
        item.configuration === undefined
          ? item.name
          : `${item.name}=${path.join(directory, item.configuration.file)}`,
      );
    }
    const name = languages.length === 1 ? "code" : language;
    args.push("-o", `summaries/${prefix}${name}.json`);

    return {
      args,
      language,
      effectsOnly: !items.some(
        (item) => countsForProject(item) && item.kind !== "effects",
      ),
      needsConfig: items
        .filter((item) => item.configuration?.required === true)
        .map((item) => path.join(directory, item.configuration?.file ?? "")),
    };
  });

  const contracts = report.suggestions.filter((s) => s.kind === "contract");
  const contractCommands = contracts.flatMap((item): ReadCommand[] =>
    item.file === undefined
      ? []
      : [
          {
            args: [
              "contract",
              "--from",
              item.name,
              path.join(directory, item.file),
              "-o",
              `summaries/${prefix}${contractOutput(item, contracts)}.json`,
            ],
            effectsOnly: false,
            needsConfig: [],
          },
        ],
  );

  return [...extracts, ...contractCommands];
}

const KIND_ORDER: Record<PackSuggestion["kind"], number> = {
  framework: 0,
  client: 1,
  effects: 2,
  contract: 3,
};

/** The packs in the order the report lists them, so a command reads in the same order as the groups above it. */
function inReportOrder(
  suggestions: ReadonlyArray<PackSuggestion>,
): PackSuggestion[] {
  return [...suggestions].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
}

function slugOf(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The printed report for one project. `directory` is where the project
 * is from the directory init ran in, and every path in the commands
 * starts from there, so a user can paste them without changing folder.
 */
export function formatInitReport(report: InitReport, directory = "."): string {
  const lines: string[] = [];
  const { suggestions } = report;

  if (declaredPacks(report).length === 0) {
    lines.push(...nothingToReadLines(report));
    lines.push(...notReadLines(report));
    return `${lines.join("\n")}\n`;
  }

  const frameworks = suggestions.filter((s) => s.kind === "framework");
  const clients = suggestions.filter((s) => s.kind === "client");
  const contracts = suggestions.filter((s) => s.kind === "contract");
  const effects = suggestions.filter((s) => s.kind === "effects");

  lines.push(
    `${green("✓")} Found ${bold(describeCount(suggestions.length, "thing"))} to read in ${report.root}`,
  );
  lines.push("");
  for (const group of [
    { label: "Your code", items: [...frameworks, ...clients] },
    { label: "What your code reaches", items: effects },
    { label: "Declared contracts", items: contracts },
  ]) {
    if (group.items.length === 0) {
      continue;
    }
    lines.push(`  ${bold(group.label)}`);
    for (const item of group.items) {
      lines.push(`    ${cyan(item.name.padEnd(16))} ${dim(item.because)}`);
    }
    lines.push("");
  }

  // The packs ship inside @suss/cli, so the CLI is the only install.
  // Step 2 gives the pack names to pass.
  lines.push(bold("1. Install suss"));
  lines.push("");
  lines.push("   npm install --save-dev @suss/cli");
  lines.push("");

  lines.push(bold("2. Read each side into one folder"));
  lines.push("");
  const commands = readCommands(report, directory);
  const runnable = commands.filter((command) => !command.effectsOnly);
  if (runnable.some((command) => command.args[0] === "extract")) {
    lines.push(
      ...configurationLines(
        [...frameworks, ...clients, ...effects],
        report.root,
        directory,
      ),
    );
  }
  // One extract per language, because each pack works with one
  // language's adapter.
  for (const command of runnable) {
    lines.push(`   suss ${command.args.join(" ")}`);
  }
  for (const command of commands.filter((one) => one.effectsOnly)) {
    lines.push(...effectsOnlyLines(command, effects));
  }
  lines.push("");

  lines.push(bold("3. Compare them"));
  lines.push("");
  lines.push("   suss check --dir summaries/");
  lines.push("");

  lines.push(bold("4. Decide what to do about the findings"));
  lines.push("");
  lines.push(
    dim(
      "   Anything you have reviewed and accepted goes in .sussignore at the",
    ),
  );
  lines.push(
    dim(
      "   repo root, with a reason, so the next person knows it was a choice:",
    ),
  );
  lines.push("");
  lines.push(dim('   { "version": 1,'));
  lines.push(dim('     "rules": [{ "kind": "unhandledProviderCase",'));
  lines.push(
    dim('                 "boundary": "GET /legacy/*", "effect": "hide",'),
  );
  lines.push(
    dim('                 "reason": "legacy route, retiring in Q3" }] }'),
  );
  lines.push("");

  lines.push(bold("5. Run it on every change"));
  lines.push("");
  lines.push(
    dim(
      "   `check` exits non-zero on an error, so the two commands above work",
    ),
  );
  lines.push(
    dim("   as a CI step unchanged. Add --fail-on warning to gate harder."),
  );

  const readsTypeScript = runnable.some(
    (command) => command.language === "typescript",
  );
  if (report.tsconfig === null && readsTypeScript) {
    lines.push("");
    lines.push(
      dim(
        "   No tsconfig here, so suss reads the directory. Pass -p to point it",
      ),
    );
    lines.push(dim("   at a particular one instead."));
  }

  lines.push(...notReadLines(report));

  return `${lines.join("\n")}\n`;
}

/** The opening of a report with no command to print. */
function nothingToReadLines(report: InitReport): string[] {
  if ((report.emptyExtracts ?? []).length > 0) {
    return [
      `${yellow("!")} Packs matched in ${report.root}, but an extract there wouldn't find a file to read.`,
    ];
  }

  return [
    `${yellow("!")} Nothing in ${report.root} matched a pack.`,
    "",
    dim("  suss reads code through a pack per framework, client, or schema it"),
    dim("  recognizes, and this project's dependencies name none of them."),
    dim("  Run `suss --help` for the built-in list."),
  ];
}

/** Everything init found and prints no command for, with why. */
function notReadLines(report: InitReport): string[] {
  return [
    ...recognizedWithoutPackLines(report),
    ...unreadLines(report),
    ...emptyExtractLines(report),
    ...emptyContractLines(report),
    ...coveredContractLines(report),
    ...unnamedLanguageLines(report),
  ];
}

/** A suggestion's language, with TypeScript for a contract, which has none. */
export const languageOf = (suggestion: PackSuggestion): Language =>
  suggestion.language ?? "typescript";

/**
 * An effects pack run alone writes an empty file, so the report prints
 * the command unfinished with a warning in place of a runnable one.
 */
function effectsOnlyLines(
  command: ReadCommand,
  effects: ReadonlyArray<PackSuggestion>,
): string[] {
  const output = command.args.indexOf("-o");
  const unfinished =
    output === -1 ? command.args : command.args.slice(0, output);
  const named = effects.filter((item) => languageOf(item) === command.language);
  return [
    `   ${dim(`suss ${unfinished.join(" ")} ...`)}`,
    "",
    `   ${yellow("!")} ${listOfNames(named)} ${named.length === 1 ? "reads calls" : "read calls"} inside handlers and`,
    "     components that another pack finds first, so on its own it comes",
    "     back empty. Add the pack for whatever serves this project, and",
    "     see `suss --help` for the built-in list.",
  ];
}

/**
 * For each pack that takes config, the config `init --write` would write.
 * When the project does not say and the pack has no defaults, what the
 * pack needs and an example to fill in instead.
 */
function configurationLines(
  items: ReadonlyArray<PackSuggestion>,
  projectRoot: string,
  directory: string,
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const configuration = item.configuration;
    if (configuration === undefined) {
      continue;
    }

    lines.push(
      ...packConfigurationLines(
        item.name,
        configuration,
        projectRoot,
        path.join(directory, configuration.file),
      ),
    );
    lines.push("");
  }
  return lines;
}

function packConfigurationLines(
  pack: string,
  configuration: PackConfiguration,
  projectRoot: string,
  shown: string,
): string[] {
  if (fs.existsSync(path.join(projectRoot, configuration.file))) {
    return [`   ${cyan(pack)} reads ${shown}, which is already here.`];
  }

  const values = valuesFor(configuration, projectRoot);
  if (values !== null) {
    return [
      `   ${cyan(pack)} reads ${shown}, and \`suss init --write\` writes this to it:`,
      dim(`     ${JSON.stringify(values)}`),
    ];
  }

  return [
    `   ${cyan(pack)} ${configurationNeed(configuration)} ${configuration.why}`,
    dim(`   Write that to ${shown}:`),
    dim(`     ${JSON.stringify(configuration.example)}`),
  ];
}

/**
 * The values init writes for a pack: what the project says, over the
 * pack's defaults. Null when there is neither.
 */
export function valuesFor(
  configuration: PackConfiguration,
  projectRoot: string,
): Record<string, unknown> | null {
  const read = configuration.readFromProject?.(projectRoot) ?? null;
  if (read === null && configuration.defaults === undefined) {
    return null;
  }
  return { ...configuration.defaults, ...read };
}

/** How much a pack reads without its config, as the start of a sentence that `why` finishes. */
export function configurationNeed(configuration: PackConfiguration): string {
  return configuration.required
    ? "reads nothing until you tell it"
    : "reads more if you tell it";
}

function unreadLines(report: InitReport): string[] {
  const unread = report.unread ?? [];
  if (unread.length === 0) {
    return [];
  }

  const lines = ["", `  ${yellow("!")} ${bold("What suss could not read")}`];
  for (const entry of unread) {
    lines.push(`    ${cyan(entry.where)}  ${dim(entry.reason)}`);
  }
  lines.push(
    dim(
      "    A library named only in one of these is a pack suss cannot suggest.",
    ),
  );
  return lines;
}

/** A skipped contract's reader warnings past this many are counted rather than listed. */
const WARNINGS_SHOWN = 3;

function emptyContractLines(report: InitReport): string[] {
  const empty = report.emptyContracts ?? [];
  if (empty.length === 0) {
    return [];
  }

  const lines = [
    "",
    `  ${yellow("!")} ${bold("Contracts with nothing to read")}`,
  ];
  const indent = `    ${"".padEnd(16)} `;
  for (const entry of empty) {
    lines.push(`    ${cyan(entry.name.padEnd(16))} ${dim(entry.because)}`);
    lines.push(`${indent}${dim(entry.reason)}`);
    for (const warning of entry.warnings.slice(0, WARNINGS_SHOWN)) {
      lines.push(`${indent}${dim(`  ${warning}`)}`);
    }
    const more = entry.warnings.length - WARNINGS_SHOWN;
    if (more > 0) {
      lines.push(`${indent}${dim(`  and ${more} more`)}`);
    }
  }
  lines.push(
    dim("    suss prints no command for these, since each would read nothing."),
  );
  return lines;
}

function coveredContractLines(report: InitReport): string[] {
  const covered = report.coveredContracts ?? [];
  if (covered.length === 0) {
    return [];
  }

  const lines = [
    "",
    `  ${yellow("!")} ${bold("Contracts another file already declares")}`,
  ];
  const indent = `    ${"".padEnd(16)} `;
  for (const entry of covered) {
    lines.push(`    ${cyan(entry.name.padEnd(16))} ${dim(entry.because)}`);
    lines.push(
      `${indent}${dim(`${entry.coveredBy} describes every boundary in it the same way`)}`,
    );
  }
  lines.push(
    dim(
      "    suss prints no command for these, since reading both would report each finding twice.",
    ),
  );
  return lines;
}

function emptyExtractLines(report: InitReport): string[] {
  const empty = report.emptyExtracts ?? [];
  if (empty.length === 0) {
    return [];
  }

  const lines = ["", `  ${yellow("!")} ${bold("Code with nothing to read")}`];
  const indent = `    ${"".padEnd(16)} `;
  for (const entry of empty) {
    lines.push(
      `    ${cyan(LANGUAGE_LABEL[entry.language].padEnd(16))} ${dim(`would run ${entry.packs.join(", ")}`)}`,
    );
    lines.push(`${indent}${dim(entry.reason)}`);
  }
  lines.push(
    dim("    suss prints no extract for these, since each would read nothing."),
  );
  return lines;
}

/** Languages with source in the project that no suggested pack reads. */
export function unnamedLanguages(report: InitReport): Language[] {
  const languages = report.languages ?? [];
  const covered = new Set([
    ...report.suggestions.map(languageOf),
    ...(report.emptyExtracts ?? []).map((entry) => entry.language),
  ]);
  return languages.filter(
    (language) =>
      !covered.has(language) &&
      // Ignore a stray script. A language counts when it has a project
      // file, or when it is the only language here.
      (languages.length === 1 ||
        projectFilesOf(report.root, language).length > 0),
  );
}

export function recognizedWithoutPackSentence(name: string): string {
  return `This project depends on ${name}, which suss knows and has no pack for yet, so the code built on it is not read.`;
}

function recognizedWithoutPackLines(report: InitReport): string[] {
  return (report.recognizedWithoutPack ?? []).flatMap((name) => [
    "",
    `${yellow("!")} ${recognizedWithoutPackSentence(name)}`,
  ]);
}

export function unnamedLanguageSentence(language: Language): string {
  return `There is ${LANGUAGE_LABEL[language]} code here and suss could not tell which packs read it.`;
}

function unnamedLanguageLines(report: InitReport): string[] {
  const uncovered = unnamedLanguages(report);
  if (uncovered.length === 0) {
    return [];
  }

  const lines = [""];
  for (const language of uncovered) {
    lines.push(`  ${yellow("!")} ${unnamedLanguageSentence(language)}`);
  }
  lines.push(
    dim("    Name one yourself with -f, and `suss --help` lists them all."),
  );
  return lines;
}

function describeCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function listOfNames(items: ReadonlyArray<PackSuggestion>): string {
  const names = items.map((item) => cyan(item.name));
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
