/**
 * Reads each Minitest test, and each Rails test case's test, as a `test`
 * unit named by its class and the method the runner gives it, so a PRD
 * scenario can list the test that covers it with `coveredBy` and `suss
 * check --intent` can check it still exists, still runs, and still
 * reaches what the scenario is about.
 *
 * Every name here is one Minitest, Rails or mocha defines. The README
 * says what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z
  .object({
    /**
     * The test files to read, matched on whole path segments from the
     * end. `suss extract --intent` fills it in from the tests the PRDs
     * list, so a run reads those files and no others. Left out, every
     * `*_test.rb` file is read.
     */
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type MinitestPackOptions = z.infer<typeof optionsSchema>;

/** Minitest's own test class, and the test cases Rails builds on it. */
const TEST_CASE_CLASSES = [
  "Minitest::Test",
  "ActiveSupport::TestCase",
  "ActionDispatch::IntegrationTest",
  "ActionDispatch::SystemTestCase",
  "ActionController::TestCase",
  "ActionMailer::TestCase",
  "ActionView::TestCase",
  "ActiveJob::TestCase",
  "ActionCable::TestCase",
  "ActionCable::Channel::TestCase",
  "ActionCable::Connection::TestCase",
  "Rails::Generators::TestCase",
];

export function minitestFramework(options: MinitestPackOptions = {}): RubyPack {
  return {
    name: "minitest",
    protocol: "in-process",
    discovery: [],
    testClasses: [
      {
        filePatterns: ["*_test.rb"],
        baseClassNames: TEST_CASE_CLASSES,
        testMethodPrefix: "test_",
        testBlockMethods: ["test"],
        blockTestName: { prefix: "test_", spacesAs: "_" },
        setupBlockMethods: ["setup"],
        setupMethodNames: ["setup", "before_setup"],
        skipStatements: ["skip"],
        assertionPrefixes: ["assert", "refute", "must_", "wont_", "flunk"],
        stubMethods: ["stub", "stubs", "expects"],
        ...(options.files !== undefined ? { files: options.files } : {}),
      },
    ],
  };
}

/**
 * No dependency is listed, so `suss init` does not add this pack to
 * every Rails project. Run without a file list it reads every test,
 * which can double what an extract walks.
 */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-minitest",
  dependencies: [],
  reads:
    "Minitest and Rails test cases (Ruby), named by class and test method, so a PRD scenario can say which test covers it.",
};

export default minitestFramework;
