/**
 * Two readings of one project to compare: two summaries files, or the
 * two folders `suss extract --out-dir` wrote before and after a change.
 * `suss inspect --diff` and `suss intent check` both read their two
 * sides through this, so they compare the same summaries.
 */

import fs from "node:fs";
import path from "node:path";

import { parseSummaryFile } from "./summaryFile.js";
import { UsageError } from "./usageError.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** One summaries file, read before and after the change. */
export interface ReadingPair {
  before: readonly BehavioralSummary[];
  after: readonly BehavioralSummary[];
}

/**
 * Two folders pair their files by name, the way `extract --out-dir`
 * writes one file per read. A file on one side only is left out, since
 * every unit in it would look added or removed.
 */
export function readingPairs(before: string, after: string): ReadingPair[] {
  const kinds = [before, after].map(kindOfPath);
  if (kinds[0] !== kinds[1]) {
    throw new UsageError(
      `${before} and ${after} are two folders of summaries or two files, not one of each.`,
    );
  }
  if (kinds[0] === "file") {
    return [{ before: readSummaries(before), after: readSummaries(after) }];
  }
  const later = new Set(jsonFilesIn(after));
  const pairs = jsonFilesIn(before)
    .filter((name) => later.has(name))
    .map((name) => ({
      before: readSummaries(path.join(before, name)),
      after: readSummaries(path.join(after, name)),
    }));
  if (pairs.length === 0) {
    throw new UsageError(
      `${before} and ${after} have no summaries file in common. Pass the folders \`suss extract --out-dir\` wrote before and after the change.`,
    );
  }
  return pairs;
}

/**
 * Every pair's summaries as one reading on each side. A deployable's
 * environment is declared in one file and read in another, so what
 * changed in it only shows when both files are compared together.
 */
export function wholeReadings(pairs: readonly ReadingPair[]): ReadingPair {
  return {
    before: pairs.flatMap((pair) => pair.before),
    after: pairs.flatMap((pair) => pair.after),
  };
}

function kindOfPath(where: string): "folder" | "file" {
  if (!fs.existsSync(where)) {
    throw new UsageError(`Nothing at ${path.resolve(where)}.`);
  }
  return fs.statSync(where).isDirectory() ? "folder" : "file";
}

function jsonFilesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readSummaries(file: string) {
  return parseSummaryFile(file, fs.readFileSync(file, "utf-8"));
}
