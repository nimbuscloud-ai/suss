/**
 * Reads each RSpec example as a `test` unit named by its group titles,
 * so a PRD scenario can name the test that covers it with `coveredBy`
 * and `suss check --intent` can check the test still exists, still runs,
 * and still reaches what the scenario is about.
 *
 * Every call listed here is one RSpec defines. `@suss/recognize` reads
 * the groups, examples and shared groups, and the Ruby adapter reads
 * what a `let` gives, the blocks an example runs through, and the
 * mocks. The README says what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { TestCasesMatch } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z
  .object({
    /**
     * The spec files to read, matched on whole path segments from the
     * end. `suss extract --intent` fills it in from the tests the PRDs
     * list, so a run reads those files and no others. Left out, every
     * `*_spec.rb` file is read.
     */
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type RspecPackOptions = z.infer<typeof optionsSchema>;

/** The methods RSpec gives an example for checking and setting up, which call no project code. */
const RUNNER_METHODS = [
  "expect",
  "is_expected",
  "allow",
  "allow_any_instance_of",
  "expect_any_instance_of",
  "receive",
  "receive_messages",
  "have_received",
  "double",
  "instance_double",
  "class_double",
  "object_double",
  "spy",
  "instance_spy",
  "stub_const",
  "eq",
  "eql",
  "equal",
  "be",
  "be_a",
  "be_an",
  "be_nil",
  "be_truthy",
  "be_falsey",
  "be_within",
  "include",
  "match",
  "match_array",
  "contain_exactly",
  "raise_error",
  "change",
  "have_attributes",
  "an_instance_of",
  "a_kind_of",
  "anything",
  "hash_including",
  "satisfy",
  "output",
  "all",
];

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "1";

const EAGER_VALUES = ["let!"];
const EAGER_SUBJECTS = ["subject!"];

/**
 * A group is opened on self or on `RSpec`, and an example is declared in
 * a group with a block. A hook, a `let!` and a `subject!` run before
 * every example in the group they are written in.
 */
function examples(files: readonly string[] | undefined): TestCasesMatch {
  return {
    type: "testCases",
    files: {
      matching: ["*_spec.rb"],
      ...(files === undefined ? {} : { listed: files }),
    },
    calls: {
      from: { origin: "global", paths: ["RSpec"] },
      body: "block",
      groups: {
        names: ["describe", "context", "feature", "example_group"],
        skipped: ["xdescribe", "xcontext", "xfeature"],
      },
      cases: {
        names: ["it", "specify", "example", "scenario", "its"],
        skipped: [
          "xit",
          "xspecify",
          "xexample",
          "xscenario",
          "skip",
          "pending",
        ],
      },
      topLevelCases: false,
      shared: {
        names: ["shared_examples", "shared_examples_for", "shared_context"],
        includes: [
          { method: "it_behaves_like", nestedTitle: "behaves like" },
          {
            method: "it_should_behave_like",
            nestedTitle: "it should behave like",
          },
          { method: "include_examples" },
          { method: "include_context" },
        ],
      },
    },
    before: {
      calls: [
        "before",
        "prepend_before",
        "append_before",
        ...EAGER_VALUES,
        ...EAGER_SUBJECTS,
      ],
    },
    skips: { statements: ["skip", "pending"], metadata: ["skip"] },
  };
}

export function rspecFramework(options: RspecPackOptions = {}): RubyPack {
  return {
    name: "rspec",
    version: VERSION,
    protocol: "in-process",
    discovery: [],
    tests: [
      {
        cases: examples(options.files),
        lazyValues: ["let"],
        eagerValues: EAGER_VALUES,
        subjectNames: { lazy: ["subject"], eager: EAGER_SUBJECTS },
        subjectReads: ["subject", "is_expected"],
        subjectValue: "subject",
        describedClass: "described_class",
        runnerMethods: RUNNER_METHODS,
        predicateMatchers: [
          { prefix: "be_", methodPrefix: "", methodSuffix: "?" },
          { prefix: "have_", methodPrefix: "has_", methodSuffix: "?" },
        ],
        expectations: {
          starts: ["expect"],
          onSubject: "is_expected",
          runs: ["to", "not_to", "to_not"],
        },
        mocks: {
          targets: [
            "allow",
            "expect",
            "allow_any_instance_of",
            "expect_any_instance_of",
          ],
          expectations: ["to", "not_to", "to_not"],
          messages: ["receive", "receive_messages"],
          constantStubs: ["stub_const"],
          doubles: ["instance_double", "class_double"],
          constantDoubleMethod: "as_stubbed_const",
        },
      },
    ],
  };
}

/**
 * No dependency is listed, so `suss init` does not add this pack to
 * every project that tests with RSpec. Run without a file list it
 * reads every spec, which can double what an extract walks.
 */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-rspec",
  dependencies: [],
  reads:
    "RSpec examples, named by their group titles, so a PRD scenario can say which test covers it.",
};

export default rspecFramework;
