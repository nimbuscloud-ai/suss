/**
 * Reads each RSpec example as a `test` unit named by its group titles,
 * so a PRD scenario can name the test that covers it with `coveredBy`
 * and `suss check --intent` can check the test still exists, still runs,
 * and still reaches what the scenario is about.
 *
 * Every call listed here is one RSpec defines. The Ruby adapter reads
 * the nesting, the blocks an example runs through, and the mocks. The
 * README says what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
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

export function rspecFramework(options: RspecPackOptions = {}): RubyPack {
  return {
    name: "rspec",
    protocol: "in-process",
    discovery: [],
    tests: [
      {
        filePatterns: ["*_spec.rb"],
        receiver: "RSpec",
        groupNames: ["describe", "context", "feature", "example_group"],
        skippedGroupNames: ["xdescribe", "xcontext", "xfeature"],
        sharedGroupNames: [
          "shared_examples",
          "shared_examples_for",
          "shared_context",
        ],
        exampleNames: ["it", "specify", "example", "scenario", "its"],
        skippedExampleNames: [
          "xit",
          "xspecify",
          "xexample",
          "xscenario",
          "skip",
          "pending",
        ],
        skipStatements: ["skip", "pending"],
        skipMetadata: ["skip"],
        beforeHooks: ["before", "prepend_before", "append_before"],
        lazyValues: ["let"],
        eagerValues: ["let!"],
        subjectNames: { lazy: ["subject"], eager: ["subject!"] },
        subjectReads: ["subject", "is_expected"],
        subjectValue: "subject",
        describedClass: "described_class",
        runnerMethods: RUNNER_METHODS,
        predicateMatcherPrefixes: ["be_", "have_"],
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
        ...(options.files !== undefined ? { files: options.files } : {}),
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
