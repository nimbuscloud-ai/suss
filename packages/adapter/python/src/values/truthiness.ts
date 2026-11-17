import {
  everyOption,
  hasNoEntries,
  opposite,
  stringIsEmpty,
  truthinessFrom,
} from "@suss/values";

import type { Constant } from "@suss/values";

/** `None`, `False` and zero are false. A function that ends without a `return` gives `None`, which the engine writes as undefined. */
function constantIsTrue(option: Constant): boolean {
  return (
    option !== null && option !== undefined && option !== false && option !== 0
  );
}

/**
 * Python's rule for what counts as true in a condition: `None`, `False`,
 * zero, and an empty string, dict, list or tuple are false, and the
 * rest is true. A class instance is true unless its class says
 * otherwise, and the evaluator never reads an instance.
 */
export const pythonTruthiness = truthinessFrom({
  constant: ({ options }) => everyOption(options, constantIsTrue),
  string: (value) => opposite(stringIsEmpty(value)),
  sequence: (value) => opposite(hasNoEntries(value)),
  unbounded: () => null,
  record: (value) => opposite(hasNoEntries(value)),
  hole: () => null,
  ref: () => null,
  deferred: () => null,
});
