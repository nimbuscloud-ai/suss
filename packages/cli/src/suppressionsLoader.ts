// suppressions-loader.ts: read .sussignore from disk for `suss check`.
//
// Checker owns the rule types and matching; this module is just I/O:
// find the right file, parse YAML or JSON, and validate against
// SuppressionFileSchema. Invalid rules fail loud: silent malformed
// suppressions are the worst kind.

import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

import { FINDING_KINDS, namesDocumentByFileName } from "@suss/behavioral-ir";
import {
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  validateRule,
} from "@suss/checker";
import { IntentFindingKindSchema } from "@suss/intent-ir";

/**
 * Every kind a rule may target: behavioural finding kinds plus intent
 * finding kinds. The rule schema keeps `kind` open (it lives below
 * both IRs); the loader owns typo rejection so a misspelled kind fails
 * loud instead of silently never matching.
 */
const KNOWN_FINDING_KINDS: ReadonlySet<string> = new Set([
  ...FINDING_KINDS,
  ...IntentFindingKindSchema.options,
]);

/** Candidate filenames checked in order when no --sussignore is given. */
export const DEFAULT_SUPPRESSIONS_FILENAMES = [
  ".sussignore.yml",
  ".sussignore.yaml",
  ".sussignore.json",
];

/**
 * The directories a search covers, nearest first: the starting
 * directory, then each parent up to and including the project root.
 *
 * `suss check --dir summaries/` starts at the summaries folder, and a
 * reader who keeps their `.sussignore` beside `package.json` expects it
 * to apply. Walking up finds both. The walk stops at the first
 * directory that contains a `package.json` or a `.git`, so a file in a
 * parent project or in the home directory never reaches a run.
 */
export function suppressionsSearchDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    dirs.push(dir);
    if (isProjectRoot(dir)) {
      return dirs;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return dirs;
    }
    dir = parent;
  }
}

function isProjectRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, ".git"))
  );
}

/**
 * Locate a .sussignore file, starting at the given directory and
 * walking up to the project root. Returns the absolute path to the
 * first matching file, or null if none found.
 */
export function findSuppressionsFile(searchDir: string): string | null {
  for (const dir of suppressionsSearchDirs(searchDir)) {
    for (const name of DEFAULT_SUPPRESSIONS_FILENAMES) {
      const candidate = path.resolve(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Leaving `version` off is the mistake people make copying a rule out
 * of the docs, and the schema error for it gives a literal rather than
 * the fix.
 */
function isMissingVersion(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    !("version" in raw) &&
    "rules" in raw
  );
}

/**
 * Load, parse, and validate a .sussignore file. Throws with a clear
 * message if the file is malformed or contains rules that don't
 * satisfy validateRule.
 */
export function loadSuppressions(filePath: string): SuppressionRule[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  const raw = ext === ".json" ? JSON.parse(content) : yaml.parse(content);

  if (isMissingVersion(raw)) {
    throw new Error(
      `${filePath} has no version. Add \`version: 1\` above the rules; every suppressions file starts with it.`,
    );
  }

  const parsed = SuppressionFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid suppressions file ${filePath}:\n${issues}`);
  }

  const file: SuppressionFile = parsed.data;
  const problems: string[] = [];
  file.rules.forEach((rule, idx) => {
    const err = validateRule(rule);
    if (err !== null) {
      problems.push(`  - rules[${idx}] (${rule.reason}): ${err}`);
    }
    if (rule.kind !== undefined && !KNOWN_FINDING_KINDS.has(rule.kind)) {
      problems.push(
        `  - rules[${idx}] (${rule.reason}): unknown finding kind "${rule.kind}"`,
      );
    }
  });
  if (problems.length > 0) {
    throw new Error(`Invalid rules in ${filePath}:\n${problems.join("\n")}`);
  }
  reportDocumentsNamedByFileName(filePath, file.rules);
  return file.rules;
}

/**
 * Warn when a rule identifies a document the way readers used to label
 * them, by file name alone. Such a rule still matches every document of
 * that reader with that name. suss now records where the document
 * lives, and writing the path pins the rule to one of them. Say nothing
 * and the rule looks pinned when it is not.
 */
function reportDocumentsNamedByFileName(
  filePath: string,
  rules: SuppressionRule[],
): void {
  const named = new Set<string>();
  for (const rule of rules) {
    for (const side of [rule.consumer, rule.provider]) {
      const summary = side?.summary;
      if (summary === undefined) {
        continue;
      }

      const [document] = summary.split("::");
      if (document !== undefined && namesDocumentByFileName(document)) {
        named.add(document);
      }
    }
  }

  for (const document of [...named].sort()) {
    process.stderr.write(
      `[suss] ${filePath}: a rule names ${document}, which suss now records with the path the document sits at. The rule still matches every document of that reader with that file name; write the path to pin it to one.\n`,
    );
  }
}

/**
 * Highest-level entry point used by the CLI: given an optional override
 * path and a search directory, return rules if a file was found (or
 * override was provided). Returns [] when no file exists and no
 * override was given.
 */
export function loadSuppressionsOrEmpty(opts: {
  overridePath?: string | undefined;
  searchDir: string;
}): SuppressionRule[] {
  if (opts.overridePath !== undefined) {
    const resolved = path.resolve(opts.overridePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Suppressions file not found: ${resolved}`);
    }
    return loadSuppressions(resolved);
  }
  const auto = findSuppressionsFile(opts.searchDir);
  return auto === null ? [] : loadSuppressions(auto);
}
