/**
 * Reads the .sussignore file for `suss check`.
 *
 * The rule types and the matching are in @suss/checker. This module finds
 * the file, parses its YAML or JSON, and validates it against
 * SuppressionFileSchema. An invalid rule throws, because a malformed rule
 * that is silently skipped leaves the user thinking a finding is
 * suppressed when it is not.
 */

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
 * Every finding kind a rule may target, from both the behavioral and the
 * intent IR. The rule schema accepts any string for `kind`, because the
 * checker cannot depend on the intent IR. The loader rejects unknown
 * kinds, so a misspelled kind throws instead of never matching.
 */
const KNOWN_FINDING_KINDS: ReadonlySet<string> = new Set([
  ...FINDING_KINDS,
  ...IntentFindingKindSchema.options,
]);

/**
 * File names checked in order when no --sussignore is given. The docs
 * call the file `.sussignore`, and that name is parsed as YAML.
 */
export const DEFAULT_SUPPRESSIONS_FILENAMES = [
  ".sussignore",
  ".sussignore.yml",
  ".sussignore.yaml",
  ".sussignore.json",
];

/**
 * The directories to search, nearest first: the starting directory, then
 * each parent up to and including the project root.
 *
 * `suss check --dir summaries/` starts at the summaries folder, and a
 * user who keeps `.sussignore` next to `package.json` expects it to
 * apply, so the search walks up. It stops at the first directory that
 * contains a `package.json` or a `.git`, so a file in a parent project
 * or in the home directory never applies to a run.
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
 * Finds a .sussignore file, starting at `searchDir` and walking up to the
 * project root.
 *
 * @returns the absolute path of the first file found, or null.
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
 * People often leave `version` off when they copy a rule out of the docs,
 * and the schema error for that only prints the expected literal. This
 * check lets the loader print the fix instead.
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
 * Loads, parses and validates a .sussignore file.
 *
 * @throws when the file is malformed, when a rule fails validateRule, or
 * when a rule targets an unknown finding kind.
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
 * Warns when a rule identifies a document by file name alone. Such a
 * rule matches every document of that reader with that file name, while
 * a rule written with the document's path matches only that one. Without
 * the warning, the user would think the rule covers one document.
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
 * Loads the rules from `overridePath` when it is given, or else from the
 * file found by searching up from `searchDir`. Returns [] when there is
 * no override and no file.
 *
 * @throws when `overridePath` does not exist, or when the file is invalid.
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
