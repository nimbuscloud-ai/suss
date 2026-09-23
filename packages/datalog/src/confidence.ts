/**
 * Confidence levels as a tag algebra: how sure the run is of each
 * derived fact, given how sure it is of the facts and rules behind it.
 *
 * A rule firing takes the minimum level across its body, and a fact
 * reached two ways keeps the better level. Both are idempotent, so ten
 * medium steps come out medium. A rule that is itself a heuristic caps
 * its conclusions through `confidenceWith`.
 *
 * An asserted fact without a tag counts as `"high"`; assert it with a
 * level, as in `db.add(relation, tuple, "medium")`, to say less. A
 * matched negation also counts as `"high"`, because negation is exact
 * over the database as computed. DESIGN.md has a worked example.
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
