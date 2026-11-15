/**
 * Python's environment as a read chain, which the adapter runs over every
 * body without a pack, since the standard library provides `os.environ`.
 * The spellings of a read of one variable are the chain's data, and the
 * defaulted rule, the helper seeds and the value evaluator's rows read
 * them from here.
 */

import { compile, global, runtimeReads } from "@suss/recognize";

import type { EntryMeaning, GetterMeaning } from "@suss/recognize";

export const PYTHON_ENV_RECOGNITION = "python-env";

const CONFIG: EntryMeaning = { reads: "config", callee: "keyed" };
const GET: GetterMeaning = {
  key: { at: 0 },
  fallback: { at: 1, keyword: "default" },
};

/** `os.environ["X"]`, `os.environ.get("X", d)` and `os.getenv("X", d)`. A missing key raises KeyError. */
export const ENVIRONMENT = runtimeReads({
  object: global("os.environ"),
  entriesBy: "key",
  missing: "raises",
})
  .entries({}, CONFIG)
  .getters({ get: GET })
  .functions({ "os.getenv": GET })
  .writes({}, { changes: "nothing" })
  .throughHelpers()
  .example('os.environ.get("TABLE_NAME", "accounts")');

/** The chain as the hook the read dispatch hands each site. */
export const environmentReads = compile(
  ENVIRONMENT.declared,
  PYTHON_ENV_RECOGNITION,
);
