/**
 * Which files are test, story or fixture code, by the names test runners
 * and Storybook look for.
 *
 * The checker leaves those out of pairing, and an adapter leaves them out
 * when it works out what a parameter of production code can be, so a
 * test that calls `authorize(id, "https://test.com")` never decides the
 * host production code calls. A `test`, `tests`, `spec` or `e2e` folder
 * counts only at the top of the project, because an application can
 * serve a route from `app/api/test/route.ts`. An absolute path has no top
 * folder, so only the other rules apply to one.
 */

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

/** Whether a file is test, story or fixture code by its name. */
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
