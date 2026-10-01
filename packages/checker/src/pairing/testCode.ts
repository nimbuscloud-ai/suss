/**
 * Which summaries describe test code, stories or fixtures.
 *
 * A test that calls `fetch("https://test.local/")`, or a Storybook
 * decorator that mounts a router on `*`, looks like any other client or
 * route once it is summarized, and pairing it compares a stand-in with
 * production code. The checker never sees the packs that read a
 * summary, so it goes by the names test runners and Storybook look for.
 * The pairing README lists them. A `test`, `tests`, `spec` or `e2e`
 * folder counts only at the top of the project, because an application
 * can serve a route from `app/api/test/route.ts`.
 */

import { readStorybookMetadata } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const TEST_FILE_NAMES: readonly RegExp[] = [
  /\.(test|spec|e2e|e2e-spec|stories|story|fixture|fixtures|mock)\.[cm]?[jt]sx?$/,
  /^test_[^/]*\.py$/,
  /_test\.(py|rb|go)$/,
  /_spec\.rb$/,
  /^conftest\.py$/,
];

const TEST_FOLDERS_ANYWHERE = new Set([
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "__stories__",
  ".storybook",
  "testing",
  "stories",
]);

const TEST_FOLDERS_AT_TOP = new Set(["test", "tests", "spec", "e2e"]);

/** Whether a project-relative file is test, story or fixture code by its name. */
export function isTestFile(file: string): boolean {
  const segments = file.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  const base = segments.pop() ?? "";
  if (TEST_FILE_NAMES.some((pattern) => pattern.test(base))) {
    return true;
  }

  if (segments.some((segment) => TEST_FOLDERS_ANYWHERE.has(segment))) {
    return true;
  }

  return TEST_FOLDERS_AT_TOP.has(segments[0] ?? "");
}

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
