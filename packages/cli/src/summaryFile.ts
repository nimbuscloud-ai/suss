/** Reads one summaries file, with an error that says what is wrong with it. */

import { JsonFileError, readSummaryFile } from "@suss/behavioral-ir/files";

import { UsageError } from "./usageError.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * How a command words a file that is not summaries. `inspect` and the
 * commands built on it say the file is invalid, and `check` says what the
 * file should have been.
 */
export type SummaryFileWording = "invalid" | "expectedOutput";

const NOT_SUMMARIES: Record<
  SummaryFileWording,
  (file: string, issues: string) => string
> = {
  invalid: (file, issues) => `Invalid summary file ${file}:\n${issues}`,
  expectedOutput: (file, issues) =>
    `suss could not read ${file} as summaries. It should be the output of \`suss extract\` or \`suss contract\`. What did not fit:\n${issues}`,
};

/** Reads and validates a summaries file of any layout, turning a bad file into a `UsageError`. */
export function readSummaries(
  filePath: string,
  wording: SummaryFileWording = "invalid",
): BehavioralSummary[] {
  try {
    return readSummaryFile(filePath);
  } catch (error) {
    if (!(error instanceof JsonFileError)) {
      throw error;
    }
    throw new UsageError(explained(error, wording));
  }
}

function explained(error: JsonFileError, wording: SummaryFileWording): string {
  if (error.problem === "notSummaries") {
    return NOT_SUMMARIES[wording](error.file, formatIssues(error.issues));
  }
  if (error.problem === "notJson" && wording === "invalid") {
    return `${error.file} is not JSON suss can read: ${firstLineOf(error.detail)}`;
  }
  return error.message;
}

function formatIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 10)
    .map((i) => `  - ${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
    .join("\n");
}

/** The first line of an error's message, for a report that lists several. */
export function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}
