/**
 * Which summaries describe test code, stories or fixtures.
 *
 * A test that calls `fetch("https://test.local/")`, or a Storybook
 * decorator that mounts a router on `*`, looks like any other client or
 * route once it is summarized, and pairing it compares a stand-in with
 * production code. The checker never sees the packs that read a
 * summary, so it goes by the names test runners and Storybook look for,
 * through `isTestFile`. The pairing README lists them.
 */

import { isTestFile, readStorybookMetadata } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export { isTestFile };

/** Whether a summary is a Storybook story. */
export function isStory(summary: BehavioralSummary): boolean {
  return readStorybookMetadata(summary) !== undefined;
}

/** Whether a summary describes a test case, a story, or code in a test file. */
export function isTestCode(summary: BehavioralSummary): boolean {
  return (
    summary.kind === "test" ||
    isStory(summary) ||
    isTestFile(summary.location.file)
  );
}
