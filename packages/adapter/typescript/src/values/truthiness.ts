import {
  everyOption,
  opposite,
  stringIsEmpty,
  truthinessFrom,
} from "@suss/values";

/**
 * JavaScript's rule for what counts as true in a condition: `null`,
 * `undefined`, `false`, `0`, `NaN` and `""` are false, and every object
 * and array is true, an empty one included.
 */
export const javascriptTruthiness = truthinessFrom({
  constant: ({ options }) => everyOption(options, Boolean),
  string: (value) => opposite(stringIsEmpty(value)),
  sequence: () => true,
  unbounded: () => true,
  record: () => true,
  hole: () => null,
  ref: () => null,
  deferred: () => null,
});
