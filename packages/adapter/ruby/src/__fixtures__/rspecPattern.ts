/**
 * An RSpec test pattern for the adapter's own tests. The adapter cannot
 * depend on @suss/framework-rspec, which depends on it, so this is a
 * trimmed copy of that pack's pattern.
 */

import type { RbTestCases, RubyPack } from "../pack.js";

const PREDICATE_MATCHERS = [
  { prefix: "be_", methodPrefix: "", methodSuffix: "?" },
  { prefix: "have_", methodPrefix: "has_", methodSuffix: "?" },
];

export function rspecPattern(files?: string[]): RbTestCases {
  return {
    cases: {
      type: "testCases",
      files: {
        matching: ["*_spec.rb"],
        ...(files === undefined ? {} : { listed: files }),
      },
      calls: {
        from: { origin: "global", paths: ["RSpec"] },
        body: "block",
        groups: {
          names: ["describe", "context"],
          skipped: ["xdescribe", "xcontext"],
        },
        cases: {
          names: ["it", "specify"],
          skipped: ["xit", "skip", "pending"],
        },
        topLevelCases: false,
        shared: {
          names: ["shared_examples", "shared_context"],
          includes: [
            { method: "it_behaves_like", nestedTitle: "behaves like" },
            { method: "include_examples" },
            { method: "include_context" },
          ],
        },
      },
      before: { calls: ["before", "let!", "subject!"] },
      skips: { statements: ["skip", "pending"], metadata: ["skip"] },
      runner: {
        names: [
          "expect",
          "is_expected",
          "allow",
          "receive",
          "eq",
          "be",
          "be_nil",
          "stub_const",
        ],
        prefixes: PREDICATE_MATCHERS.map((one) => one.prefix),
        chains: true,
      },
      mocks: [
        {
          replacesMessages: {
            by: { methods: ["to", "not_to"] },
            targets: ["allow", "expect", "allow_any_instance_of"],
            messages: ["receive", "receive_messages"],
            of: { at: 0 },
          },
        },
        {
          replacesConstant: {
            by: { methods: ["stub_const"] },
            name: { at: 0 },
          },
        },
        {
          standsIn: {
            by: { methods: ["instance_double", "class_double"] },
            of: { at: 0 },
            becomes: "as_stubbed_const",
          },
        },
      ],
    },
    lazyValues: ["let"],
    eagerValues: ["let!"],
    subjectNames: { lazy: ["subject"], eager: ["subject!"] },
    subjectReads: ["subject", "is_expected"],
    subjectValue: "subject",
    describedClass: "described_class",
    predicateMatchers: PREDICATE_MATCHERS,
    expectations: {
      starts: ["expect"],
      onSubject: "is_expected",
      runs: ["to", "not_to", "to_not"],
    },
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
