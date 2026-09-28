/**
 * How a PRD scenario spells the test that covers it, the way the test
 * runner prints it. vitest and RSpec write the file, each describe or
 * context title, then the test's own title, joined with ` > `. pytest
 * prints a node id, the file, any class, then the test function, joined
 * with `::`. Both come apart into the same file and title path, and a
 * test unit's name is that title path joined with ` > `, so one lookup
 * serves every runner.
 */

import { TEST_TITLE_SEPARATOR } from "@suss/ir-core";

export { TEST_TITLE_SEPARATOR };

/** What separates the file, a class and a test function in a pytest node id. */
export const NODE_ID_SEPARATOR = "::";

/** One `coveredBy` entry, split into the test file and its title path. */
export interface CoveringTestSpelling {
  /** The entry as the author wrote it. */
  spelledAs: string;
  /** The test file, with the workspace in front when the author wrote one. */
  file: string;
  /** The suite titles, outermost first, then the test's own title. Empty when the entry has none. */
  titles: string[];
}

export function toCoveringTest(spelledAs: string): CoveringTestSpelling {
  if (!spelledAs.includes(TEST_TITLE_SEPARATOR)) {
    return nodeIdSpelling(spelledAs);
  }
  const [file, ...titles] = spelledAs.split(TEST_TITLE_SEPARATOR);
  return { spelledAs, file: file.trim(), titles };
}

/**
 * A pytest node id, `tests/test_orders.py::TestCancel::test_twice`. A
 * class or function name has no dot or slash in it, so the file is the
 * last part that does, and a workspace written in front of it,
 * `orders::tests/test_orders.py::test_twice`, stays with the file. A
 * parametrized id such as `test_twice[case-1]` means the function
 * `test_twice`.
 */
function nodeIdSpelling(spelledAs: string): CoveringTestSpelling {
  const parts = spelledAs.trim().split(NODE_ID_SEPARATOR);
  const last = parts.length - 1;
  parts[last] = parts[last].replace(/\[.*\]$/, "");
  let fileAt = last;
  while (fileAt >= 0 && !/[./]/.test(parts[fileAt])) {
    fileAt -= 1;
  }
  if (fileAt < 0) {
    return { spelledAs, file: spelledAs.trim(), titles: [] };
  }
  return {
    spelledAs,
    file: parts.slice(0, fileAt + 1).join(NODE_ID_SEPARATOR),
    titles: parts.slice(fileAt + 1),
  };
}
