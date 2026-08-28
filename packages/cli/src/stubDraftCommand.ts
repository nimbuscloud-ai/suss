/**
 * `suss stub draft <package>`: turn the project's observed calls into
 * a package suss cannot read into a stub skeleton for an author to
 * fill in. The evidence is every call site attributed to the package,
 * with the argument shapes seen there; the semantic blanks (which
 * system a call reaches, which argument means what) are what the
 * author supplies from the package's own source. The output lands in
 * `suss/stubs/`, where the loader already reads.
 */

import fs from "node:fs";
import path from "node:path";

import { stubEvidence } from "@suss/adapter-typescript";

import { resolveSource } from "./extract.js";
import { UsageError } from "./usageError.js";

import type { StubCallEvidence } from "@suss/adapter-typescript";
import type { EffectArg } from "@suss/extractor";

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
    `    system: ""  # what the call reaches: aws.sqs, aws.events, aws.dynamodb, aws.lambda, axios`,
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

export interface StubDraftResult {
  yaml: string;
  /** Where the draft belongs, under the resolved source root. */
  target: string;
  exports: number;
  sites: number;
}

/** Null when the project never calls the package. */
export function stubDraftResult(
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
    yaml: draftYaml(options.package, evidence),
    target: path.join(
      source.root,
      "suss",
      "stubs",
      stubFileName(options.package),
    ),
    exports: evidence.length,
    sites: evidence.reduce((sum, one) => sum + one.calls.length, 0),
  };
}

export function stubDraft(options: StubDraftOptions): number {
  const result = stubDraftResult(options);
  if (result === null) {
    process.stderr.write(
      `No calls into ${options.package} found. ` +
        "A stub drafts from observed call sites, so there is nothing to draft.\n",
    );
    return 1;
  }

  if (options.output === "-") {
    process.stdout.write(result.yaml);
    return 0;
  }

  const target = options.output ?? result.target;
  if (fs.existsSync(target)) {
    throw new UsageError(
      `${target} already exists. Move it aside, or pass -o for another path.`,
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, result.yaml);

  process.stdout.write(
    `Drafted ${target}: ${result.exports} ${
      result.exports === 1 ? "export" : "exports"
    } from ${result.sites} call sites. Fill the blanks, then re-run extract.\n`,
  );
  return 0;
}
