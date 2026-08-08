// init.ts — work out which packs a project needs, and say so.
//
// Picking packs by hand means reading the pack list, matching it against
// your dependencies, and knowing that a SAM template implies two of them
// while a Prisma schema implies a third. That is a research task before
// anyone has seen a single summary.
//
// Everything needed to answer it is already on disk. Dependencies name
// the frameworks and clients. Files on disk name the contract sources.
// So read both and print the commands.
//
// Nothing is written or installed. The output is a list of commands to
// run, which stays useful whether the reader wants to paste them, put
// them in CI, or read them and do something else.

import fs from "node:fs";
import path from "node:path";

import {
  readPythonDependencies,
  readRubyDependencies,
} from "./dependencyManifests.js";
import { readSubmodules } from "./gitSubmodules.js";
import {
  detectLanguages,
  LANGUAGE_LABEL,
  projectFilesOf,
  SKIP_DIRECTORIES,
} from "./language.js";
import { bold, cyan, dim, green, yellow } from "./style.js";

import type { UnreadDependencies } from "./dependencyManifests.js";
import type { Language } from "./language.js";

/**
 * Per-project values a pack needs before it can read anything, or
 * reads better for having. Every built-in TypeScript pack needs none,
 * because everything they match on is something their library defines.
 * The Python and Ruby packs are the first to need a sentence about this
 * particular project: which module a project re-exports a decorator
 * through, which directory it keeps its classes in.
 */
export interface PackConfiguration {
  /** Where to write it, relative to the project. */
  file: string;
  /** A starting point, with this project's own values to fill in. */
  example: Record<string, unknown>;
  /** Whether the pack refuses to run without it. */
  required: boolean;
  /** What the value is, in a sentence. */
  why: string;
}

/** A pack, and the evidence that suggested it. */
export interface PackSuggestion {
  /** The `-f` name, or the `--from` name for a contract source. */
  name: string;
  /** The npm package to install. */
  packageName: string;
  /** What in the project pointed at it. */
  because: string;
  /**
   * What this pack contributes. An `effects` pack recognises calls
   * inside units some other pack discovered, so it produces nothing on
   * its own and asking for it alone always comes back empty.
   */
  kind: "framework" | "client" | "contract" | "effects";
  /** For a contract source, the file to read. */
  file?: string;
  /** Which language's code this pack reads. Contract sources have none. */
  language?: Language;
  configuration?: PackConfiguration;
}

export interface InitReport {
  root: string;
  /** Null when the project has no tsconfig, which is fine. */
  tsconfig: string | null;
  suggestions: PackSuggestion[];
  /** Every language suss found source for here. */
  languages?: Language[];
  /**
   * Where suss looked for the libraries this project uses and could not
   * read one. A project whose manifest is a program that computes its
   * dependency list is a project suss cannot suggest packs for, and
   * saying that is different from finding nothing.
   */
  unread?: UnreadDependencies[];
}

/** Which package manager names a library, so two ecosystems can share a table. */
type Ecosystem = "npm" | "pypi" | "rubygems";

/**
 * A dependency a project declares, and the pack that reads code using
 * it. One table across all three ecosystems, because the question is
 * the same in each: this library is here, so which pack knows how to
 * read the code that calls it.
 */
const BY_DEPENDENCY: Array<{
  ecosystem: Ecosystem;
  dependency: string;
  name: string;
  packageName: string;
  kind: PackSuggestion["kind"];
  language: Language;
  configuration?: PackConfiguration;
}> = [
  {
    ecosystem: "npm",
    dependency: "hono",
    name: "hono",
    packageName: "@suss/framework-hono",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "next",
    name: "nextjs",
    packageName: "@suss/framework-nextjs",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "express",
    name: "express",
    packageName: "@suss/framework-express",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "fastify",
    name: "fastify",
    packageName: "@suss/framework-fastify",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@ts-rest/core",
    name: "ts-rest",
    packageName: "@suss/framework-ts-rest",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@nestjs/common",
    name: "nestjs-rest",
    packageName: "@suss/framework-nestjs-rest",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@nestjs/graphql",
    name: "nestjs-graphql",
    packageName: "@suss/framework-nestjs-graphql",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@apollo/server",
    name: "apollo",
    packageName: "@suss/framework-apollo",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "react-router",
    name: "react-router",
    packageName: "@suss/framework-react-router",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "react-router-dom",
    name: "react-router",
    packageName: "@suss/framework-react-router",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "react",
    name: "react",
    packageName: "@suss/framework-react",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@types/aws-lambda",
    name: "aws-lambda",
    packageName: "@suss/framework-aws-lambda",
    kind: "framework",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@prisma/client",
    name: "prisma",
    packageName: "@suss/framework-prisma",
    kind: "effects",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "drizzle-orm",
    name: "drizzle",
    packageName: "@suss/framework-drizzle",
    kind: "effects",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@aws-sdk/client-sqs",
    name: "aws-sqs",
    packageName: "@suss/framework-aws-sqs",
    kind: "effects",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@aws-sdk/client-eventbridge",
    name: "aws-eventbridge",
    packageName: "@suss/framework-aws-eventbridge",
    kind: "effects",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "@apollo/client",
    name: "apollo-client",
    packageName: "@suss/client-apollo",
    kind: "client",
    language: "typescript",
  },
  {
    ecosystem: "npm",
    dependency: "axios",
    name: "axios",
    packageName: "@suss/client-axios",
    kind: "client",
    language: "typescript",
  },
  {
    ecosystem: "pypi",
    dependency: "fastapi",
    name: "fastapi",
    packageName: "@suss/framework-fastapi",
    kind: "framework",
    language: "python",
    configuration: {
      file: "suss.fastapi.json",
      example: { wrapperModules: ["myapp.wrappers.api"] },
      required: false,
      why: "the modules your own code re-exports the router and app constructors from. FastAPI's own module is always read, so leave this out if your routes import from it directly.",
    },
  },
  {
    ecosystem: "pypi",
    dependency: "flask-restx",
    name: "flask-restx",
    packageName: "@suss/framework-flask-restx",
    kind: "framework",
    language: "python",
    configuration: {
      file: "suss.flask-restx.json",
      example: { wrapperModules: ["myapp.wrappers.restx"] },
      required: false,
      why: "the modules your own code re-exports the route decorator from. The library's own module is always read, so leave this out if your resources import from it directly.",
    },
  },
  {
    ecosystem: "rubygems",
    dependency: "graphql",
    name: "graphql-ruby",
    packageName: "@suss/framework-graphql-ruby",
    kind: "framework",
    language: "ruby",
    configuration: {
      file: "suss.graphql-ruby.json",
      example: { root: "app/graphql" },
      required: true,
      why: "the directory a field's wired class is looked up under, read relative to this file. A Rails app generated by the library keeps its types and mutations under app/graphql.",
    },
  },
];

/**
 * A file on disk, and the contract reader that understands it. The
 * matcher takes a filename so a glob-ish check stays in one place.
 */
const BY_FILE: Array<{
  matches: (filename: string) => boolean;
  name: string;
  packageName: string;
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
    matches: (f) => f === "schema.prisma",
    name: "prisma",
    packageName: "@suss/contract-prisma",
    describe: (p) => `a Prisma schema at ${p}`,
  },
  {
    matches: (f) => f.endsWith(".graphql") && !f.includes(".test."),
    name: "graphql",
    packageName: "@suss/contract-graphql",
    describe: (p) => `a GraphQL schema at ${p}`,
  },
  {
    matches: (f) => /^openapi\.(ya?ml|json)$/.test(f),
    name: "openapi",
    packageName: "@suss/contract-openapi",
    describe: (p) => `an OpenAPI document at ${p}`,
  },
  {
    matches: (f) => f.endsWith(".stories.tsx") || f.endsWith(".stories.ts"),
    name: "storybook",
    packageName: "@suss/contract-storybook",
    describe: (p) => `Storybook stories, the first at ${p}`,
  },
];

/** Read the project and work out which packs apply. */
export function inspectProject(root: string): InitReport {
  const resolved = path.resolve(root);
  const suggestions: PackSuggestion[] = [];
  const seen = new Set<string>();

  const add = (suggestion: PackSuggestion): void => {
    const key = `${suggestion.kind}:${suggestion.name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    suggestions.push(suggestion);
  };

  const declared = declaredLibraries(resolved);
  for (const library of declared.named) {
    const match = BY_DEPENDENCY.find(
      (d) => d.ecosystem === library.ecosystem && d.dependency === library.name,
    );
    if (match !== undefined) {
      add({
        name: match.name,
        packageName: match.packageName,
        because: `${library.name} in ${library.where}`,
        kind: match.kind,
        language: match.language,
        ...(match.configuration !== undefined
          ? { configuration: match.configuration }
          : {}),
      });
    }
  }

  const submodules = new Set(
    readSubmodules(resolved).map((submodule) => submodule.directory),
  );
  for (const file of filesUnder(resolved, submodules)) {
    const relative = path.relative(resolved, file);
    const filename = path.basename(file);
    for (const rule of BY_FILE) {
      if (rule.matches(filename)) {
        add({
          name: rule.name,
          packageName: rule.packageName,
          because: rule.describe(relative),
          kind: "contract",
          file: relative,
        });
      }
    }
  }

  const tsconfig = ["tsconfig.json", "jsconfig.json"]
    .map((name) => path.join(resolved, name))
    .find((candidate) => fs.existsSync(candidate));

  return {
    root: resolved,
    tsconfig: tsconfig ?? null,
    suggestions,
    languages: detectLanguages(resolved),
    unread: declared.unread,
  };
}

/** One library this project depends on, and which ecosystem names it. */
interface DeclaredLibrary {
  ecosystem: Ecosystem;
  name: string;
  /** The manifest or field that named it. */
  where: string;
}

/**
 * Every library this project says it depends on, whichever language
 * declared it, plus everywhere suss looked and could not tell.
 *
 * A submodule nobody checked out lands in the same place: its code is
 * part of this project, so a missing one hides whatever it would have
 * named the same way an unreadable manifest does.
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
      });
    }
  }

  return { named, unread };
}

/** Every dependency name in package.json, with which field it came from. */
/**
 * Every library this project reaches, and where it was named.
 *
 * A service in a monorepo names its own packages and lets those bring in
 * the SDKs, so its manifest says nothing about the queue it sends to.
 * Reading only the manifest in front of us meant no pack for that queue,
 * nobody looking for the sends, and a run that came back clean because
 * it had not been asked the question.
 *
 * So a dependency that resolves to a package inside this repository is
 * followed into that package's own manifest. A dependency that resolves
 * outside it is a published library and stops here, because whatever it
 * depends on is its business rather than this project's.
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

/** The dependency names one manifest declares, with the field naming each. */
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

/**
 * Where a dependency lives when it lives in this repository, or null.
 *
 * A workspace is linked into node_modules, so the link's target is the
 * answer and no workspace globs have to be read. A package resolving
 * outside the tree we were pointed at is somebody else's.
 */
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
  // A SAM template or a schema sits near the top of a service, so going
  // deeper finds mostly source files, which the dependency scan already
  // covers. Pointed at a home directory, a deeper walk also starts
  // reporting other people's projects as if they were this one.
  if (depth > 3) {
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
      // A directory with its own package.json is its own project. Its
      // schemas belong to it, so stop rather than claim them here.
      if (depth > 0 && fs.existsSync(path.join(full, "package.json"))) {
        continue;
      }
      // Same for a repository checked out inside this one that this
      // project never asked for. A submodule is the opposite case: this
      // project's own .gitmodules names it, its code is code this
      // project imports, so the walk carries on into it.
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
 * What was found, what to install, and what to run.
 *
 * Written to be read top to bottom and stopped at any point: the
 * evidence first, so a wrong guess is visible, then the commands.
 */
export function formatInitReport(report: InitReport): string {
  const lines: string[] = [];
  const { suggestions } = report;

  if (suggestions.length === 0) {
    lines.push(`${yellow("!")} Nothing in ${report.root} matched a pack.`);
    lines.push("");
    lines.push(
      dim(
        "  suss reads code through a pack per framework, client, or schema it",
      ),
    );
    lines.push(
      dim("  recognizes, and this project's dependencies name none of them."),
    );
    lines.push(dim("  Run `suss --help` for the built-in list."));
    lines.push(...unreadLines(report));
    lines.push(...unnamedLanguageLines(report));
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

  lines.push(bold("1. Install the packs"));
  lines.push("");
  lines.push(
    `   npm install --save-dev @suss/cli ${suggestions.map((s) => s.packageName).join(" ")}`,
  );
  lines.push("");

  lines.push(bold("2. Read each side into one folder"));
  lines.push("");
  const code = [...frameworks, ...clients];
  if (code.length > 0) {
    lines.push(...configurationLines([...code, ...effects]));
    // One pass over the project reads every pack, so one command does,
    // and a project written in two languages gets one command each: a
    // pack is written against one language's adapter. The effects packs
    // ride along: each one recognises calls inside units the others
    // found, so they add to a command and cannot be the whole of one.
    lines.push(...extractCommands([...code, ...effects]));
  } else if (effects.length > 0) {
    // Asking for these alone gives an empty file and a message about
    // the code, which reads as though the code were at fault.
    lines.push(
      `   ${dim(`suss extract ${effects.map((e) => `-f ${e.name}`).join(" ")} ...`)}`,
    );
    lines.push("");
    lines.push(
      `   ${yellow("!")} ${listOfNames(effects)} ${effects.length === 1 ? "reads calls" : "read calls"} inside handlers and`,
    );
    lines.push(
      "     components that another pack finds first, so on its own it comes",
    );
    lines.push(
      "     back empty. Add the pack for whatever serves this project, and",
    );
    lines.push("     see `suss --help` for the built-in list.");
  }
  for (const item of contracts) {
    lines.push(
      `   suss contract --from ${item.name} ${item.file ?? "<path>"} -o summaries/${item.name}.json`,
    );
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

  if (report.tsconfig === null && readsTypeScript(suggestions)) {
    lines.push("");
    lines.push(
      dim(
        "   No tsconfig here, so suss reads the directory. Pass -p to point it",
      ),
    );
    lines.push(dim("   at a particular one instead."));
  }

  lines.push(...unreadLines(report));
  lines.push(...unnamedLanguageLines(report));

  return `${lines.join("\n")}\n`;
}

const readsTypeScript = (suggestions: ReadonlyArray<PackSuggestion>): boolean =>
  suggestions.some((s) => (s.language ?? "typescript") === "typescript");

/** The language a pack reads, with TypeScript as what a pack reads by default. */
const languageOf = (suggestion: PackSuggestion): Language =>
  suggestion.language ?? "typescript";

/**
 * One extract command per language, since a pack is written against one
 * language's adapter and a run reads one language at a time.
 */
function extractCommands(items: ReadonlyArray<PackSuggestion>): string[] {
  const languages = [...new Set(items.map(languageOf))];
  return languages.map((language) => {
    const flags = items
      .filter((item) => languageOf(item) === language)
      .map((item) =>
        item.configuration === undefined
          ? `-f ${item.name}`
          : `-f ${item.name}=${item.configuration.file}`,
      )
      .join(" ");
    const output =
      languages.length === 1
        ? "summaries/code.json"
        : `summaries/${language}.json`;
    const reading = language === "typescript" ? "" : ` --lang ${language}`;
    return `   suss extract${reading} ${flags} -o ${output}`;
  });
}

/**
 * The file each pack that needs one reads its per-project values from.
 *
 * A pack that cannot run without one says so and stops, so this is the
 * difference between a working command and a puzzling error.
 */
function configurationLines(items: ReadonlyArray<PackSuggestion>): string[] {
  const configured = items.filter((item) => item.configuration !== undefined);
  if (configured.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const item of configured) {
    const configuration = item.configuration;
    if (configuration === undefined) {
      continue;
    }
    const needs = configuration.required
      ? "reads nothing until you tell it"
      : "reads more if you tell it";
    lines.push(`   ${cyan(item.name)} ${needs} ${configuration.why}`);
    lines.push(dim(`   Write that to ${configuration.file}:`));
    lines.push(dim(`     ${JSON.stringify(configuration.example)}`));
    lines.push("");
  }
  return lines;
}

/** What suss looked at and could not read, so nobody mistakes it for nothing to read. */
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

/**
 * A language whose source is here and whose libraries suss could not
 * place. Not knowing which packs apply is worth saying; suggesting
 * nothing and looking confident is not.
 */
export function unnamedLanguages(report: InitReport): Language[] {
  const languages = report.languages ?? [];
  const covered = new Set(report.suggestions.map(languageOf));
  return languages.filter(
    (language) =>
      !covered.has(language) &&
      // A stray script in another language is not a project in that
      // language. What makes it one is a file saying so, or being the
      // only language here.
      (languages.length === 1 ||
        projectFilesOf(report.root, language).length > 0),
  );
}

/** What `unnamedLanguages` says, in the printed report. */
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

/** A few pack names, as somebody would say them aloud. */
function listOfNames(items: ReadonlyArray<PackSuggestion>): string {
  const names = items.map((item) => cyan(item.name));
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
