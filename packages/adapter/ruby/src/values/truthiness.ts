import { everyOption, truthinessFrom } from "@suss/values";

/**
 * Ruby's rule for what counts as true in a condition: `nil` and `false`
 * are false, and everything else is true, `0` and `""` included. A method
 * that ends without a value gives `nil`, which the engine writes as
 * undefined.
 */
export const rubyTruthiness = truthinessFrom({
  constant: ({ options }) =>
    everyOption(
      options,
      (option) => option !== null && option !== undefined && option !== false,
    ),
  string: () => true,
  sequence: () => true,
  unbounded: () => true,
  record: () => true,
  hole: () => null,
  ref: () => null,
  deferred: () => null,
});
