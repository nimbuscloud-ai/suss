/**
 * Confidence levels as a tag algebra: how sure the run is of each
 * derived fact, given how sure it is of the facts and rules behind it.
 *
 * A conclusion is only as sure as its weakest premise, so a rule
 * firing takes the minimum level across its body. A fact reached two
 * ways keeps the better level, so a second derivation merges with
 * maximum. Both are idempotent: ten medium steps come out medium, and
 * that is the intended reading rather than a loss of information.
 *
 * A rule can be a heuristic itself, and then its conclusions should
 * not outrank it however sure its premises are. `confidenceWith`
 * takes a level per rule and folds it into the minimum. The plain
 * `confidence` algebra treats every rule as exact.
 *
 * An asserted fact without a tag counts as `"high"`: the caller read
 * it directly from its source. To say less, assert the fact with a
 * level: `db.add(relation, tuple, "medium")`. A matched negation also
 * counts as `"high"`, because negation here is exact over the
 * database as computed, not a guess about the world.
 */

import type { Rule, TagAlgebra } from "./index.js";

/** How sure the run is of one fact. The order is high > medium > low. */
export type ConfidenceLevel = "high" | "medium" | "low";

const RANK: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * The confidence algebra with a level per rule. Rules the callback
 * returns `undefined` for count as exact, so a rule set with one
 * heuristic only has to speak for that one.
 */
export function confidenceWith(
  levelOf: (rule: Rule) => ConfidenceLevel | undefined,
): TagAlgebra<ConfidenceLevel> {
  return {
    asserted: "high",
    absent: "high",
    combine(bodyTags, derivation) {
      let lowest = levelOf(derivation.rule) ?? "high";
      for (const tag of bodyTags) {
        if (RANK[tag] < RANK[lowest]) {
          lowest = tag;
        }
      }
      return lowest;
    },
    merge(stored, incoming) {
      return RANK[incoming] > RANK[stored] ? incoming : stored;
    },
  };
}

/** The confidence algebra with every rule counted as exact. */
export const confidence: TagAlgebra<ConfidenceLevel> = confidenceWith(
  () => undefined,
);
