/**
 * Which summaries describe test code.
 *
 * A test that calls `fetch("https://test.local/")` looks like any other
 * client once it is summarized, and pairing it compares a test double
 * against production code. The checker sees summaries and never the
 * packs that read them, so it goes by the file names test runners look
 * for: `*.test.ts`, `test_*.py`, `*_spec.rb` and the like, anything
 * under `__tests__` or `__mocks__`, and anything under a `test`,
 * `tests`, `spec` or `e2e` folder at the top of the project. Deeper
 * folders with those names are left alone, because an application can
 * serve a route from `app/api/test/route.ts`.
 */

import type { BehavioralSummary } from "@suss/behavioral-ir";

const TEST_FILE_NAMES: readonly RegExp[] = [
  /\.(test|spec|e2e|e2e-spec)\.[cm]?[jt]sx?$/,
  /^test_[^/]*\.py$/,
  /_test\.(py|rb|go)$/,
  /_spec\.rb$/,
  /^conftest\.py$/,
];

const TEST_FOLDERS_ANYWHERE = new Set(["__tests__", "__mocks__"]);

const TEST_FOLDERS_AT_TOP = new Set(["test", "tests", "spec", "e2e"]);

/** Whether a project-relative file is test code by the runners' naming. */
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

/** Whether a summary describes a test case or code in a test file. */
export function isTestCode(summary: BehavioralSummary): boolean {
  return summary.kind === "test" || isTestFile(summary.location.file);
}
