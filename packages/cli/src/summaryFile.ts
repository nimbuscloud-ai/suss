/** Reads one summaries file, with an error that says what is wrong with it. */

import { safeParseSummaries } from "@suss/behavioral-ir";

import { UsageError } from "./usageError.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export function parseSummaryFile(
  filePath: string,
  content: string,
): BehavioralSummary[] {
  let json: unknown;
  try {
    json = JSON.parse(content) as unknown;
  } catch (error) {
    throw new UsageError(
      `${filePath} is not JSON suss can read: ${firstLineOf(error)}`,
    );
  }
  const result = safeParseSummaries(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new UsageError(`Invalid summary file ${filePath}:\n${issues}`);
  }
  return result.data;
}

/** The first line of an error's message, for a report that lists several. */
export function firstLineOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
