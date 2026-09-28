/**
 * Reads each pytest test as a `test` unit named the way pytest's node id
 * writes it, so a PRD scenario can list the test that covers it under
 * `coveredBy` and `suss check --intent` can check the test still exists,
 * still runs, and still reaches what the scenario is about.
 *
 * Every name here is one pytest, unittest or pytest-mock defines. The
 * README says what the pack reads and what it leaves out.
 */

import path from "node:path";

import { z } from "zod";

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z
  .object({
    /**
     * The test files to read, matched on whole path segments from the
     * end. `suss extract --intent` fills it in from the tests the PRDs
     * list, so a run reads those files and no others. Left out, every
     * file pytest would collect is read.
     */
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type PytestPackOptions = z.infer<typeof optionsSchema>;

/** The file whose fixtures apply to every test in its directory and below. */
const SHARED_FIXTURE_FILE = "conftest.py";

export function pytestFramework(options: PytestPackOptions = {}): PythonPack {
  return {
    name: "pytest",
    protocol: "in-process",
    discovery: [],
    // A test's fixtures can come from a conftest.py in any directory
    // above it, so an edit to one has to re-read the tests below it.
    discoveryInputs: (files) =>
      files.filter((file) => path.basename(file) === SHARED_FIXTURE_FILE),
    tests: [
      {
        filePatterns: ["test_*.py", "*_test.py"],
        functionPrefix: "test",
        classPrefix: "Test",
        caseBaseClasses: [
          "unittest.TestCase",
          "unittest.IsolatedAsyncioTestCase",
        ],
        setUp: {
          module: ["setup_module"],
          function: ["setup_function"],
          testClass: ["setup_class", "setup_method"],
          caseClass: ["setUpClass", "setUp", "asyncSetUp"],
        },
        usesFixtureMarkers: ["pytest.mark.usefixtures"],
        fixtureDecorators: ["pytest.fixture"],
        fixtureNameKeyword: "name",
        autouseKeyword: "autouse",
        sharedFixtureFiles: [SHARED_FIXTURE_FILE],
        skipDecorators: [
          "pytest.mark.skip",
          "pytest.mark.skipif",
          "pytest.mark.xfail",
          "unittest.skip",
          "unittest.skipIf",
          "unittest.skipUnless",
          "unittest.expectedFailure",
        ],
        markerVariable: "pytestmark",
        reservedParameters: ["self", "cls", "request"],
        mocks: {
          patchers: [
            "unittest.mock.patch",
            "unittest.mock.patch.object",
            "mock.patch",
            "mock.patch.object",
          ],
          fixturePatchers: [
            { fixture: "mocker", methods: ["patch", "patch.object"] },
            { fixture: "monkeypatch", methods: ["setattr"] },
          ],
        },
        ...(options.files !== undefined ? { files: options.files } : {}),
      },
    ],
  };
}

/**
 * No dependency is listed, so `suss init` does not add this pack to
 * every project that tests with pytest. Run without a file list it
 * reads every test, which can double what an extract walks.
 */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-pytest",
  dependencies: [],
  reads:
    "pytest tests (Python), named by their node ids, so a PRD scenario can say which test covers it.",
};

export default pytestFramework;
