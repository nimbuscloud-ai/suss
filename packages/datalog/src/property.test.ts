// Property tests over random rule sets and random fact orders.
//
// The hand-written tests check the cases somebody thought of. These
// check the two claims the evaluator makes that a reader cannot verify
// by inspection: evaluating in pieces gives the same answer as
// evaluating all at once, and the answer does not depend on the order
// facts arrived in. Both are what a caller relies on when it adds facts
// and asks a question over and over, which is how the resolution store
// uses this.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  Database,
  evaluate,
  lit,
  notLit,
  type Rule,
  rule,
  type Tuple,
  variable as v,
} from "./index.js";

// Pinned so a run repeats and a counterexample can be reproduced from
// the seed alone. The nightly fuzz job sets SUSS_FUZZ_SEED from its run
// id, which is where these generators draw anything new.
const PROPERTY_SEED = Number(process.env.SUSS_FUZZ_SEED) || 20260730;

// A fixed schema keeps generated rules meaningful. There are two base
// relations the rules read from, and three derived ones they write to.
const BASE = ["edge", "flag"] as const;
const DERIVED = ["p", "q", "r"] as const;

const ARITY: Record<string, number> = {
  edge: 2,
  flag: 1,
  p: 2,
  q: 2,
  r: 1,
};

const NAMES = ["x", "y", "z"];

/** Variable patterns for a literal of the given arity. */
function termPatterns(arity: number): string[][] {
  if (arity === 1) {
    return NAMES.map((n) => [n]);
  }
  const pairs: string[][] = [];
  for (const first of NAMES) {
    for (const second of NAMES) {
      pairs.push([first, second]);
    }
  }
  return pairs;
}

const litFor = (relation: string, names: string[]) =>
  lit(relation, ...names.map((n) => v(n)));

/**
 * Rules for one derived relation. Positive body literals may reference
 * base relations, earlier derived relations, or this one (recursion).
 * A negated literal may only reference a strictly earlier derived
 * relation, which is what keeps every generated rule set stratifiable.
 */
function arbRuleFor(index: number, allowNegation = true): fc.Arbitrary<Rule> {
  const head = DERIVED[index] as string;
  const positiveSources = [...BASE, ...DERIVED.slice(0, index + 1)];
  const negatableSources = allowNegation ? DERIVED.slice(0, index) : [];

  const arbLiteral = fc
    .constantFrom(...positiveSources)
    .chain((relation) =>
      fc
        .constantFrom(...termPatterns(ARITY[relation] as number))
        .map((names) => litFor(relation, names)),
    );

  return fc
    .tuple(
      fc.array(arbLiteral, { minLength: 1, maxLength: 3 }),
      negatableSources.length === 0
        ? fc.constant(null)
        : fc.option(fc.constantFrom(...negatableSources), { nil: null }),
    )
    .map(([body, negatedRelation]) => {
      // Every head variable has to come from a positive literal, and so
      // does every variable under a negation.
      const bound = new Set(
        body.flatMap((l) =>
          l.terms.map((t) => (t.type === "variable" ? t.name : "")),
        ),
      );
      const available = NAMES.filter((n) => bound.has(n));
      const headNames = Array.from(
        { length: ARITY[head] as number },
        (_, i) => available[i % available.length] as string,
      );

      const fullBody =
        negatedRelation === null
          ? body
          : [
              ...body,
              notLit(
                negatedRelation,
                ...Array.from(
                  { length: ARITY[negatedRelation] as number },
                  (_, i) => v(available[i % available.length] as string),
                ),
              ),
            ];

      return rule(
        head,
        headNames.map((n) => v(n)),
        fullBody,
      );
    });
}

const rulesFrom = (allowNegation: boolean): fc.Arbitrary<Rule[]> =>
  fc
    .tuple(
      arbRuleFor(0, allowNegation),
      arbRuleFor(1, allowNegation),
      arbRuleFor(2, allowNegation),
    )
    .chain((rules) => fc.subarray(rules, { minLength: 1 }));

const arbRules = rulesFrom(true);
const arbPositiveRules = rulesFrom(false);

const arbFacts: fc.Arbitrary<Array<[string, Tuple]>> = fc.array(
  fc.oneof(
    fc
      .tuple(fc.constantFrom("a", "b", "c"), fc.constantFrom("a", "b", "c"))
      .map(([from, to]) => ["edge", [from, to]] as [string, Tuple]),
    fc
      .constantFrom("a", "b", "c")
      .map((node) => ["flag", [node]] as [string, Tuple]),
  ),
  { minLength: 1, maxLength: 12 },
);

/** Every derived relation's contents, sorted, so two runs can be compared. */
function model(db: Database): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of DERIVED) {
    out[name] = db
      .facts(name)
      .map((tuple) => tuple.join(","))
      .sort();
  }
  return out;
}

function evaluatedInOneGo(
  facts: Array<[string, Tuple]>,
  rules: Rule[],
): Database {
  const db = new Database();
  for (const [relation, tuple] of facts) {
    db.add(relation, tuple);
  }
  return evaluate(db, rules);
}

describe("evaluate holds up under random rule sets", () => {
  it("gives the same answer in pieces as in one go", () => {
    fc.assert(
      fc.property(
        arbRules,
        arbFacts,
        fc.integer({ min: 1, max: 5 }),
        (rules, facts, batches) => {
          const incremental = new Database();
          const perBatch = Math.ceil(facts.length / batches);
          for (let start = 0; start < facts.length; start += perBatch) {
            for (const [relation, tuple] of facts.slice(
              start,
              start + perBatch,
            )) {
              incremental.add(relation, tuple);
            }
            evaluate(incremental, rules);
          }

          expect(model(incremental)).toEqual(
            model(evaluatedInOneGo(facts, rules)),
          );
        },
      ),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });

  it("does not depend on the order facts arrived in", () => {
    fc.assert(
      fc.property(arbRules, arbFacts, (rules, facts) => {
        const reversed = [...facts].reverse();

        expect(model(evaluatedInOneGo(facts, rules))).toEqual(
          model(evaluatedInOneGo(reversed, rules)),
        );
      }),
      { numRuns: 200, seed: PROPERTY_SEED },
    );
  });

  it("answers for the facts a database holds, whatever ran before", () => {
    // Anything left over from the earlier run is a bug. Positive rules
    // only: with negation the second run retracts what the first derived,
    // and the fresh database it is compared against has nothing to retract.
    fc.assert(
      fc.property(
        arbPositiveRules,
        arbPositiveRules,
        arbFacts,
        (first, second, facts) => {
          const carriedOver = evaluatedInOneGo(facts, first);

          const reference = new Database();
          for (const name of [...BASE, ...DERIVED]) {
            for (const tuple of carriedOver.facts(name)) {
              reference.add(name, tuple);
            }
          }

          evaluate(carriedOver, second);
          evaluate(reference, second);

          expect(model(carriedOver)).toEqual(model(reference));
        },
      ),
      { numRuns: 200, seed: PROPERTY_SEED },
    );
  });
});
