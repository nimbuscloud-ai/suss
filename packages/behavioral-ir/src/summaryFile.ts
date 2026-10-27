/**
 * Reads and writes a summaries file. The layout and the atomic write
 * come from the document module. This adds the summary schema, applied
 * one element at a time, so a large file never has its unvalidated copy
 * in memory all at once.
 */

import path from "node:path";

import {
  JsonFileError,
  type JsonFileIssue,
  openJsonFile,
  writeFileAtomically,
} from "./documentFile.js";
import { normalizeOne } from "./legacy.js";
import {
  BehavioralSummaryArraySchema,
  BehavioralSummarySchema,
} from "./schemas.js";
import { SharedValueReader, sharedSummaryLines } from "./sharedValues.js";
import { disambiguateSummaryIds } from "./summaryId.js";

import type { BehavioralSummary } from "./index.js";

/** Enough issues to show what is wrong, without keeping one per element of a file that is not summaries at all. */
const ISSUES_KEPT = 50;

/** How many issues the error message lists. */
const ISSUES_SHOWN = 10;

/**
 * Reads and validates a summaries file of either layout. The result is
 * what `parseSummaries` gives for the same JSON. Throws `JsonFileError`
 * when the file cannot be read, is not JSON, or is not summaries.
 */
export function readSummaryFile(file: string): BehavioralSummary[] {
  const resolved = path.resolve(file);
  const document = openJsonFile(resolved);
  if (document.kind === "value") {
    const result = BehavioralSummaryArraySchema.safeParse(document.value);
    throw notSummaries(resolved, result.success ? [] : result.error.issues);
  }
  return validatedElements(resolved, document.elements);
}

/**
 * The text of a summaries file: one summary per line, with each value
 * the file repeats written once.
 */
export function* summaryFilePieces(
  summaries: readonly BehavioralSummary[],
): Generator<string> {
  if (summaries.length === 0) {
    yield "[]\n";
    return;
  }
  yield "[\n";
  let separator = "";
  for (const line of sharedSummaryLines(summaries)) {
    yield `${separator}${line}`;
    separator = ",\n";
  }
  yield "\n]\n";
}

/** Writes `summaries` one per line, through a temporary file renamed over `file`. */
export function writeSummaryFile(
  file: string,
  summaries: readonly BehavioralSummary[],
): void {
  writeFileAtomically(file, summaryFilePieces(summaries));
}

function validatedElements(
  file: string,
  elements: Iterable<unknown>,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const issues: JsonFileIssue[] = [];
  const shared = new SharedValueReader();
  let anyIdBackfilled = false;
  let index = 0;
  for (const element of elements) {
    const { value, idBackfilled } = normalizeOne(shared.expand(element));
    anyIdBackfilled = anyIdBackfilled || idBackfilled;
    const result = BehavioralSummarySchema.safeParse(value);
    if (result.success) {
      summaries.push(result.data);
    } else {
      for (const issue of result.error.issues.slice(
        0,
        ISSUES_KEPT - issues.length,
      )) {
        issues.push({ path: [index, ...issue.path], message: issue.message });
      }
    }
    index++;
  }
  if (issues.length > 0) {
    throw notSummaries(file, issues);
  }
  // A per-summary backfill can give two summaries one id, so collisions
  // are settled across the file, as `parseSummaries` does.
  if (anyIdBackfilled) {
    disambiguateSummaryIds(summaries);
  }
  return summaries;
}

function notSummaries(
  file: string,
  issues: readonly JsonFileIssue[],
): JsonFileError {
  const listed = issues
    .slice(0, ISSUES_SHOWN)
    .map(
      (issue) =>
        `  - ${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("\n");
  return new JsonFileError({
    file,
    problem: "notSummaries",
    detail: `\n${listed}`,
    issues: issues.map((issue) => ({
      path: [...issue.path],
      message: issue.message,
    })),
  });
}
