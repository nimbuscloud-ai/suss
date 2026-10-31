/**
 * Reads each vitest case as a `test` unit named by its title path, so a
 * PRD scenario can name the test that covers it with `coveredBy` and
 * `suss check --intent` can check the test still exists, still runs,
 * and still reaches what the scenario is about.
 *
 * A test is no boundary, so its unit pairs with nothing. The README
 * says what the pack reads and what it leaves out.
 */

import { z } from "zod";

import { configInputs, configSetsGlobals } from "./config.js";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z
  .object({
    /**
     * The test files to read, matched on whole path segments from the
     * end. `suss extract --intent` fills it in from the tests the PRDs
     * name, so a run reads those files and no others. Left out, every
     * file that imports vitest is read.
     */
    files: z.array(z.string().min(1)).optional(),
    /**
     * Whether tests call vitest's functions without importing them, as
     * `test.globals` in the vitest config allows. Left out, the pack
     * reads that setting from the config in `configDirectory`.
     */
    globals: z.boolean().optional(),
    /** Where the run reads from. The CLI fills it in. */
    configDirectory: z.string().optional(),
  })
  .strict();

export type VitestPackOptions = z.infer<typeof optionsSchema>;

/** The files vitest runs by default, where its globals are in scope. */
const TEST_FILE_NAMES = ["*.test.*", "*.spec.*"];

export function vitestFramework(options: VitestPackOptions = {}): PatternPack {
  const { configDirectory } = options;
  const globals =
    options.globals ??
    (configDirectory !== undefined && configSetsGlobals(configDirectory));
  return {
    name: "vitest",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    ...(configDirectory === undefined
      ? {}
      : { discoveryInputs: () => configInputs(configDirectory) }),

    discovery: [
      {
        kind: "test",
        match: {
          type: "testCase",
          style: "block",
          importModule: "vitest",
          suiteNames: ["describe", "suite"],
          caseNames: ["it", "test"],
          skipModifiers: ["skip", "todo"],
          argumentModifiers: ["skipIf", "runIf"],
          rowModifiers: ["each", "for"],
          mocks: {
            object: "vi",
            moduleMethods: ["mock", "doMock"],
            memberMethods: ["spyOn"],
          },
          ...(options.files !== undefined ? { files: options.files } : {}),
          ...(globals ? { globalsIn: TEST_FILE_NAMES } : {}),
        },
        requiresImport: ["vitest"],
      },
    ],

    // What a test returns does not matter. Every way out of the body is
    // a terminal so the calls on each path are recorded.
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],

    inputMapping: { type: "allPositional" },
  };
}

/**
 * No dependency is listed, so `suss init` does not add this pack to
 * every project that tests with vitest. Run without a file list it
 * reads every test, which can double what an extract walks.
 */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-vitest",
  dependencies: [],
  reads:
    "vitest cases, named by their titles, so a PRD scenario can say which test covers it.",
};

export default vitestFramework;
