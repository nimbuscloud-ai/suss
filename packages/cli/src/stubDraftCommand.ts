/**
 * `suss infer stub <package>`: turn the project's observed use of a
 * package suss cannot read into a stub skeleton for an author to fill
 * in. TypeScript evidence is every call site attributed to the
 * package, with the argument shapes seen there. Python evidence is
 * every import of the package or a submodule of it, since a Python
 * decorator pattern matches a wrapper module exactly. Ruby evidence is
 * every `require` of the package and every class whose superclass is
 * spelled from it, since graphql-ruby's `baseClassNames` matches a
 * superclass by its literal written name. In every case the semantic
 * blanks are what the author supplies from the package's own source.
 * The output lands in `suss/stubs/`, where the loader already reads.
 */

import fs from "node:fs";
import path from "node:path";

import { pythonImportEvidence } from "@suss/adapter-python";
import { rubyStubEvidence } from "@suss/adapter-ruby";
import { findNearestTsconfig, stubEvidence } from "@suss/adapter-typescript";
import { GRAPHQL_RUBY_ROOT_CLASS_NAMES } from "@suss/packs/graphql-ruby";

import { resolveSource } from "./extract.js";
import { languageOfProject } from "./language.js";
import { UsageError } from "./usageError.js";

import type { PythonImportEvidence } from "@suss/adapter-python";
import type { RubyStubEvidence } from "@suss/adapter-ruby";
import type { StubCallEvidence } from "@suss/adapter-typescript";
import type { EffectArg } from "@suss/extractor";
import type { Language } from "./language.js";

export interface StubDraftOptions {
  package: string;
  tsconfig?: string;
  dir?: string;
  /** Write here instead of `suss/stubs/`; `-` prints to stdout. */
  output?: string;
}

const ARG_RENDERERS: Record<string, (arg: EffectArg) => string> = {
  string: (arg) =>
    arg !== null && arg.kind === "string" ? JSON.stringify(arg.value) : "?",
  number: (arg) =>
    arg !== null && arg.kind === "number" ? String(arg.value) : "?",
  boolean: (arg) =>
    arg !== null && arg.kind === "boolean" ? String(arg.value) : "?",
  object: (arg) =>
    arg !== null && arg.kind === "object"
      ? `{${Object.keys(arg.fields).join(", ")}}`
      : "?",
  array: (arg) =>
    arg !== null && arg.kind === "array" ? `[${arg.items.length} items]` : "?",
  template: (arg) =>
    arg !== null && arg.kind === "template" ? arg.sourceText : "?",
  identifier: (arg) =>
    arg !== null && arg.kind === "identifier" ? arg.name : "?",
  call: (arg) =>
    arg !== null && arg.kind === "call" ? `${arg.callee}(...)` : "?",
};

function renderArg(arg: EffectArg): string {
  if (arg === null) {
    return "?";
  }
  const renderer = ARG_RENDERERS[arg.kind];
  return renderer === undefined ? "?" : renderer(arg);
}

const SITES_SHOWN = 3;

function statementLines(one: StubCallEvidence): string[] {
  const name = one.exportPath.join(".");
  const count = one.calls.length;
  const lines = [
    `  # ${name}: ${count} ${count === 1 ? "call" : "calls"}`,
    ...one.calls.slice(0, SITES_SHOWN).map((call) => {
      const args = call.args.map(renderArg).join(", ");
      return `  #   ${call.file}:${call.line}  (${args})`;
    }),
    "  - kind: performs-call",
    `    export: ${JSON.stringify(name)}`,
    `    system: ""  # what the call reaches: aws.sqs, aws.events, axios`,
    "    spec: {}  # argument meanings, e.g. { subject: { at: 0 }, payload: { at: 1 } }",
  ];
  return lines;
}

export function draftYaml(
  packageName: string,
  evidence: StubCallEvidence[],
): string {
  const sites = evidence.reduce((sum, one) => sum + one.calls.length, 0);
  const header = [
    `# Draft stub for ${packageName}, from ${sites} observed call sites.`,
    `# Fill each blank from the package's own source, then delete the`,
    "# notes. The statement kinds are in design/proposals/dependency-stubs.md.",
    `package: ${JSON.stringify(packageName)}`,
    `authored: ""  # who filled the blanks, e.g. agent`,
    `from: ""  # what the claims were read from, e.g. crate source at 1.4.2`,
    "statements:",
  ];
  return [...header, ...evidence.flatMap(statementLines), ""].join("\n");
}

/** `@acme/kit` becomes `acme-kit.yaml`. */
function stubFileName(packageName: string): string {
  return `${packageName.replace(/^@/, "").replace(/\//g, "-")}.yaml`;
}

const FLASK_RESTX_NAMES = new Set([
  "Namespace",
  "Resource",
  "Api",
  "fields",
  "reqparse",
  "abort",
  "marshal_with",
]);
const FASTAPI_NAMES = new Set([
  "APIRouter",
  "FastAPI",
  "Depends",
  "HTTPException",
  "Query",
  "Body",
  "Path",
]);

/** Which of the two Python wrapper packs a module's observed names belong to, or "" when they do not all agree on one. */
function pythonReExportGuess(names: readonly string[]): string {
  if (names.length > 0 && names.every((name) => FLASK_RESTX_NAMES.has(name))) {
    return "flask_restx";
  }
  if (names.length > 0 && names.every((name) => FASTAPI_NAMES.has(name))) {
    return "fastapi";
  }
  return "";
}

function pythonStatementLines(evidence: PythonImportEvidence): string[] {
  const names = [
    ...new Set(
      evidence.sites
        .map((site) => site.name)
        .filter((name): name is string => name !== null),
    ),
  ];
  const guess = pythonReExportGuess(names);
  const count = evidence.sites.length;
  return [
    `  # ${count} ${count === 1 ? "import" : "imports"}`,
    ...evidence.sites
      .slice(0, SITES_SHOWN)
      .map((site) =>
        site.name === null
          ? `  #   ${site.file}:${site.line}`
          : `  #   ${site.file}:${site.line}  (${site.name})`,
      ),
    "  - kind: re-exports",
    guess === ""
      ? '    of: ""  # what this re-exports: fastapi, flask_restx'
      : `    of: ${guess}`,
  ];
}

/** A stub matches this exact module, so one draft file covers one imported module. */
export function draftPythonYaml(
  moduleName: string,
  evidence: PythonImportEvidence,
): string {
  const header = [
    `# Draft stub for ${moduleName}, from ${evidence.sites.length} observed import sites.`,
    "# Fill each blank from the package's own source, then delete the",
    "# notes. The statement kinds are in design/proposals/dependency-stubs.md.",
    `package: ${JSON.stringify(moduleName)}`,
    `authored: ""  # who filled the blanks, e.g. agent`,
    `from: ""  # what the claims were read from, e.g. crate source at 1.4.2`,
    "statements:",
  ];
  return [...header, ...pythonStatementLines(evidence), ""].join("\n");
}

/** `myapp.routing.namespace` becomes `myapp-routing-namespace.yaml`. */
function pythonStubFileName(moduleName: string): string {
  return `${moduleName.replaceAll(".", "-")}.yaml`;
}

const KNOWN_GRAPHQL_BASE_SET = new Set(GRAPHQL_RUBY_ROOT_CLASS_NAMES);

/**
 * The ancestry walk stops at one of graphql-ruby's own root classes
 * without recording an entry for it, so `baseClassNames` can never
 * match one and a stub with it in changes nothing. Only a superclass
 * outside that set, an unread wrapper a project's own classes extend,
 * is worth drafting.
 */
function actionableExtendsSites(
  evidence: RubyStubEvidence,
): RubyStubEvidence["extendsSites"] {
  return evidence.extendsSites.filter(
    (site) => !KNOWN_GRAPHQL_BASE_SET.has(site.superclassName),
  );
}

function rubyBlankStatementLines(evidence: RubyStubEvidence): string[] {
  const direct = evidence.extendsSites.filter((site) =>
    KNOWN_GRAPHQL_BASE_SET.has(site.superclassName),
  );
  const comment =
    direct.length > 0
      ? [
          `  # ${direct.length} ${direct.length === 1 ? "class extends" : "classes extend"} a graphql-ruby base directly, which no stub can add to baseClassNames`,
          ...direct
            .slice(0, SITES_SHOWN)
            .map(
              (site) =>
                `  #   ${site.file}:${site.line}  (${site.className} < ${site.superclassName})`,
            ),
        ]
      : [
          `  # ${evidence.requires.length} ${evidence.requires.length === 1 ? "require" : "requires"}, no class found extending it directly`,
          ...evidence.requires
            .slice(0, SITES_SHOWN)
            .map(
              (site) =>
                `  #   ${site.file}:${site.line}  (require "${site.target}")`,
            ),
        ];
  return [
    ...comment,
    "  - kind: extends-base",
    '    class: ""',
    `    extends: ""  # the graphql-ruby class this ultimately extends: ${GRAPHQL_RUBY_ROOT_CLASS_NAMES.join(", ")}`,
  ];
}

function rubyExtendsStatementLines(
  superclassName: string,
  sites: RubyStubEvidence["extendsSites"],
): string[] {
  const count = sites.length;
  return [
    `  # ${count} ${count === 1 ? "class" : "classes"} extending ${superclassName}`,
    ...sites
      .slice(0, SITES_SHOWN)
      .map((site) => `  #   ${site.file}:${site.line}  (${site.className})`),
    "  - kind: extends-base",
    `    class: ""  # the package's own class that extends it, from its source`,
    `    extends: ${JSON.stringify(superclassName)}`,
  ];
}

function rubyStatementLines(evidence: RubyStubEvidence): string[] {
  const bySuperclass = new Map<string, RubyStubEvidence["extendsSites"]>();
  for (const site of actionableExtendsSites(evidence)) {
    const sites = bySuperclass.get(site.superclassName) ?? [];
    sites.push(site);
    bySuperclass.set(site.superclassName, sites);
  }
  if (bySuperclass.size === 0) {
    return rubyBlankStatementLines(evidence);
  }
  return [...bySuperclass.entries()].flatMap(([superclassName, sites]) =>
    rubyExtendsStatementLines(superclassName, sites),
  );
}

export function draftRubyYaml(
  packageName: string,
  evidence: RubyStubEvidence,
): string {
  const sites = evidence.extendsSites.length + evidence.requires.length;
  const header = [
    `# Draft stub for ${packageName}, from ${sites} observed sites.`,
    "# Fill each blank from the package's own source, then delete the",
    "# notes. The statement kinds are in design/proposals/dependency-stubs.md.",
    `package: ${JSON.stringify(packageName)}`,
    `authored: ""  # who filled the blanks, e.g. agent`,
    `from: ""  # what the claims were read from, e.g. crate source at 1.4.2`,
    "statements:",
  ];
  return [...header, ...rubyStatementLines(evidence), ""].join("\n");
}

function rubyStubFileName(packageName: string): string {
  return `${packageName.replaceAll("_", "-")}.yaml`;
}

export interface StubDraft {
  yaml: string;
  /** Where the draft belongs, under the resolved source root. */
  target: string;
}

export interface StubDraftResult {
  language: Language;
  drafts: StubDraft[];
  /** Exports covered for TypeScript, imported modules for Python, distinct superclasses for Ruby. */
  exports: number;
  sites: number;
}

function detectStubLanguage(
  options: Pick<StubDraftOptions, "tsconfig" | "dir">,
): Language {
  if (options.tsconfig !== undefined) {
    return "typescript";
  }
  const root = path.resolve(options.dir ?? process.cwd());
  const detected = languageOfProject(root, {
    coveredByTsconfig: findNearestTsconfig(root) !== null,
  });
  if ("cannotTell" in detected) {
    throw new UsageError(detected.cannotTell);
  }
  return detected.language;
}

function typeScriptDraftResult(
  options: Pick<StubDraftOptions, "package" | "tsconfig" | "dir">,
): StubDraftResult | null {
  const source = resolveSource(options);
  const evidence = stubEvidence({
    packageName: options.package,
    ...(source.kind === "tsconfig"
      ? { tsConfigFilePath: source.path }
      : { directory: source.root }),
  });
  if (evidence.length === 0) {
    return null;
  }

  return {
    language: "typescript",
    drafts: [
      {
        yaml: draftYaml(options.package, evidence),
        target: path.join(
          source.root,
          "suss",
          "stubs",
          stubFileName(options.package),
        ),
      },
    ],
    exports: evidence.length,
    sites: evidence.reduce((sum, one) => sum + one.calls.length, 0),
  };
}

async function pythonDraftResult(
  options: Pick<StubDraftOptions, "package" | "dir">,
): Promise<StubDraftResult | null> {
  const root = path.resolve(options.dir ?? process.cwd());
  const evidence = await pythonImportEvidence({
    packageName: options.package,
    directory: root,
  });
  if (evidence.length === 0) {
    return null;
  }

  return {
    language: "python",
    drafts: evidence.map((one) => ({
      yaml: draftPythonYaml(one.module, one),
      target: path.join(root, "suss", "stubs", pythonStubFileName(one.module)),
    })),
    exports: evidence.length,
    sites: evidence.reduce((sum, one) => sum + one.sites.length, 0),
  };
}

async function rubyDraftResult(
  options: Pick<StubDraftOptions, "package" | "dir">,
): Promise<StubDraftResult | null> {
  const root = path.resolve(options.dir ?? process.cwd());
  const evidence = await rubyStubEvidence({
    packageName: options.package,
    directory: root,
  });
  if (evidence.requires.length === 0 && evidence.extendsSites.length === 0) {
    return null;
  }

  const distinctSuperclasses = new Set(
    actionableExtendsSites(evidence).map((site) => site.superclassName),
  );
  return {
    language: "ruby",
    drafts: [
      {
        yaml: draftRubyYaml(options.package, evidence),
        target: path.join(
          root,
          "suss",
          "stubs",
          rubyStubFileName(options.package),
        ),
      },
    ],
    exports: Math.max(1, distinctSuperclasses.size),
    sites: evidence.requires.length + evidence.extendsSites.length,
  };
}

const DRAFT_BY_LANGUAGE: Record<
  Language,
  (
    options: Pick<StubDraftOptions, "package" | "tsconfig" | "dir">,
  ) => Promise<StubDraftResult | null> | StubDraftResult | null
> = {
  typescript: typeScriptDraftResult,
  python: pythonDraftResult,
  ruby: rubyDraftResult,
};

/** Null when the project has no evidence for the package: no calls into it, no imports of it, no class extending it. */
export async function stubDraftResult(
  options: Pick<StubDraftOptions, "package" | "tsconfig" | "dir">,
): Promise<StubDraftResult | null> {
  const language = detectStubLanguage(options);
  return DRAFT_BY_LANGUAGE[language](options);
}

const NO_EVIDENCE_MESSAGE: Record<Language, (packageName: string) => string> = {
  typescript: (packageName) =>
    `No calls into ${packageName} found. ` +
    "A stub drafts from observed call sites, so there is nothing to draft.\n",
  python: (packageName) =>
    `No imports of ${packageName} found. ` +
    "A stub drafts from observed import sites, so there is nothing to draft.\n",
  ruby: (packageName) =>
    `No require of ${packageName}, and no class extending it, found. ` +
    "A stub drafts from those, so there is nothing to draft.\n",
};

const SUMMARY_LINE: Record<
  Language,
  (result: StubDraftResult, targets: string[]) => string
> = {
  typescript: (result, targets) =>
    `Drafted ${targets[0]}: ${result.exports} ${
      result.exports === 1 ? "export" : "exports"
    } from ${result.sites} call sites. Fill the blanks, then re-run extract.\n`,
  python: (result, targets) =>
    `Drafted ${targets.join(", ")}: ${result.exports} imported ${
      result.exports === 1 ? "module" : "modules"
    } from ${result.sites} import sites. Fill the blanks, then re-run extract.\n`,
  ruby: (result, targets) =>
    `Drafted ${targets[0]}: ${result.sites} observed ${
      result.sites === 1 ? "site" : "sites"
    }. Fill the blanks, then re-run extract.\n`,
};

export async function stubDraft(options: StubDraftOptions): Promise<number> {
  const result = await stubDraftResult(options);
  if (result === null) {
    process.stderr.write(
      NO_EVIDENCE_MESSAGE[detectStubLanguage(options)](options.package),
    );
    return 1;
  }

  if (options.output === "-") {
    process.stdout.write(
      result.drafts
        .map((draft) =>
          result.drafts.length > 1
            ? `# ${draft.target}\n${draft.yaml}`
            : draft.yaml,
        )
        .join("\n"),
    );
    return 0;
  }

  if (options.output !== undefined && result.drafts.length > 1) {
    throw new UsageError(
      `${options.package} drafts ${result.drafts.length} stub files, one per imported module, so -o cannot point at a single path. Drop -o to write them under suss/stubs/.`,
    );
  }

  const targets: string[] = [];
  for (const draft of result.drafts) {
    const target = options.output ?? draft.target;
    if (fs.existsSync(target)) {
      throw new UsageError(
        `${target} already exists. Move it aside, or pass -o for another path.`,
      );
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, draft.yaml);
    targets.push(target);
  }

  process.stdout.write(SUMMARY_LINE[result.language](result, targets));
  return 0;
}
