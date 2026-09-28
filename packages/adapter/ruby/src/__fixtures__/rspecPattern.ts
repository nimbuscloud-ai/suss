/**
 * An RSpec test pattern for the adapter's own tests. The adapter cannot
 * depend on @suss/framework-rspec, which depends on it, so this is a
 * trimmed copy of that pack's pattern.
 */

import type { RbTestCases, RubyPack } from "../pack.js";

export function rspecPattern(files?: string[]): RbTestCases {
  return {
    filePatterns: ["*_spec.rb"],
    receiver: "RSpec",
    groupNames: ["describe", "context"],
    skippedGroupNames: ["xdescribe", "xcontext"],
    sharedGroupNames: ["shared_examples", "shared_context"],
    sharedIncludes: [
      { method: "it_behaves_like", nestedTitle: "behaves like" },
      { method: "include_examples" },
      { method: "include_context" },
    ],
    exampleNames: ["it", "specify"],
    skippedExampleNames: ["xit", "skip", "pending"],
    skipStatements: ["skip", "pending"],
    skipMetadata: ["skip"],
    beforeHooks: ["before"],
    lazyValues: ["let"],
    eagerValues: ["let!"],
    subjectNames: { lazy: ["subject"], eager: ["subject!"] },
    subjectReads: ["subject", "is_expected"],
    subjectValue: "subject",
    describedClass: "described_class",
    runnerMethods: [
      "expect",
      "is_expected",
      "allow",
      "receive",
      "eq",
      "be",
      "be_nil",
      "stub_const",
    ],
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
      targets: ["allow", "expect", "allow_any_instance_of"],
      expectations: ["to", "not_to"],
      messages: ["receive", "receive_messages"],
      constantStubs: ["stub_const"],
      doubles: ["instance_double", "class_double"],
      constantDoubleMethod: "as_stubbed_const",
    },
    ...(files === undefined ? {} : { files }),
  };
}

export function rspecTestPack(files?: string[]): RubyPack {
  return {
    name: "rspec",
    protocol: "in-process",
    discovery: [],
    tests: [rspecPattern(files)],
  };
}
