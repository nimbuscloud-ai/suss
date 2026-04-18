// suppressions-loader.ts — read .sussignore from disk for `suss check`.
//
// Checker owns the rule types and matching; this module is just I/O:
// find the right file, parse YAML or JSON, and validate against
// SuppressionFileSchema. Invalid rules fail loud — silent malformed
// suppressions are the worst kind.

import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

import {
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  validateRule,
} from "@suss/checker";

/** Candidate filenames checked in order when no --sussignore is given. */
export const DEFAULT_SUPPRESSIONS_FILENAMES = [
  ".sussignore.yml",
  ".sussignore.yaml",
  ".sussignore.json",
];

/**
 * Locate a .sussignore file in the given search directory. Returns the
 * absolute path to the first matching file, or null if none found.
 */
export function findSuppressionsFile(searchDir: string): string | null {
  for (const name of DEFAULT_SUPPRESSIONS_FILENAMES) {
    const candidate = path.resolve(searchDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
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
  });
  if (problems.length > 0) {
    throw new Error(`Invalid rules in ${filePath}:\n${problems.join("\n")}`);
  }
  return file.rules;
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
