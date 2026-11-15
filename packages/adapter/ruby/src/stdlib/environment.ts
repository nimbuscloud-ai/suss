/**
 * Ruby's environment as a read chain, which the adapter runs over every
 * body without a pack, since the language provides `ENV`. The spellings
 * of a read of one variable are the chain's data, and the defaulted rule,
 * the helper seeds and the value evaluator read them from here.
 */

import { compile, global, runtimeReads } from "@suss/recognize";

export const RUBY_ENV_RECOGNITION = "ruby-env";

/** `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }`. A fetch with no fallback raises KeyError. */
export const ENVIRONMENT = runtimeReads({
  object: global("ENV"),
  entriesBy: "key",
})
  .entries({}, { reads: "config", callee: "keyed" })
  .getters({
    fetch: {
      key: { at: 0 },
      fallback: [{ at: 1 }, { block: true }],
      raisesWithout: true,
    },
  })
  .writes({}, { changes: "nothing" })
  .throughHelpers()
  .example('ENV.fetch("TABLE_NAME", "accounts")');

/** The chain as the hook the read dispatch hands each site. */
export const environmentReads = compile(
  ENVIRONMENT.declared,
  RUBY_ENV_RECOGNITION,
);
