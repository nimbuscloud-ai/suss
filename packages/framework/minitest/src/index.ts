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

import { classBody, definesMethod, rubyConstants } from "@suss/recognize";

import type { RubyPack } from "@suss/adapter-ruby";
import type { TestCasesMatch } from "@suss/extractor";
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
const TEST_CASE_CLASSES = rubyConstants(
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
);

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "1";

/** ActiveSupport's `test "cancels twice" do` defines `test_cancels_twice` from its block. */
const TEST_METHODS = classBody({
  in: TEST_CASE_CLASSES,
  calls: {
    test: definesMethod({
      name: { at: 0 },
      body: { block: true },
      kind: "instance",
      naming: { prefix: "test_", spacesAs: "_" },
    }),
  },
});

function tests(files: readonly string[] | undefined): TestCasesMatch {
  return {
    type: "testCases",
    files: {
      matching: ["*_test.rb"],
      ...(files === undefined ? {} : { listed: files }),
    },
    classes: { inherits: TEST_CASE_CLASSES, methods: { pattern: "^test_" } },
    before: { calls: ["setup"], methods: ["setup", "before_setup"] },
    skips: { statements: ["skip"] },
    runner: {
      prefixes: ["assert", "refute", "must_", "wont_", "flunk"],
      names: ["skip"],
    },
    mocks: [
      {
        replacesMember: {
          by: { methods: ["stub", "stubs", "expects"] },
          member: { at: 0 },
          of: "receiver",
        },
      },
    ],
  };
}

export function minitestFramework(options: MinitestPackOptions = {}): RubyPack {
  return {
    name: "minitest",
    version: VERSION,
    protocol: "in-process",
    discovery: [],
    classBodies: [TEST_METHODS],
    testClasses: [{ cases: tests(options.files) }],
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
