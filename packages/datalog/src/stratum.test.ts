import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  lit,
  notLit,
  type Rule,
  rule,
  type Tuple,
  variable as v,
} from "./index.js";
import { planStratum, rulesReading } from "./stratum.js";

// Pinned so a run repeats and a counterexample can be reproduced from
// the seed alone. The nightly fuzz job sets SUSS_FUZZ_SEED from its run
// id, which is where these generators draw anything new.
const PROPERTY_SEED = Number(process.env.SUSS_FUZZ_SEED) || 20260730;

const STRATUM = planStratum([
  rule("reach", [v("x")], [lit("start", v("x"))]),
  rule("reach", [v("y")], [lit("reach", v("x")), lit("edge", v("x"), v("y"))]),
  rule("cut", [v("x")], [lit("node", v("x")), notLit("reach", v("x"))]),
  rule(
    "loop",
    [v("x")],
    [lit("edge", v("x"), v("y")), lit("edge", v("y"), v("x"))],
  ),
]);

const seedOf = (...relations: string[]): Map<string, readonly Tuple[]> =>
  new Map(relations.map((relation) => [relation, [["a"]]]));

describe("planStratum", () => {
  it("lists each rule once under every relation it reads positively", () => {
    expect(STRATUM.readers.get("edge")).toEqual([1, 3]);
    expect(STRATUM.readers.get("reach")).toEqual([1]);
    expect(STRATUM.readers.get("node")).toEqual([2]);
  });

  it("derives the relations its rules have as heads", () => {
    expect([...STRATUM.derived].sort()).toEqual(["cut", "loop", "reach"]);
  });
});

describe("rulesReading", () => {
  it("leaves out a rule that reads a relation with new facts only under a negation", () => {
    expect(rulesReading(STRATUM, seedOf("reach"), false)).toEqual([1]);
  });

  it("gives the rules of several relations once each, in written order", () => {
    expect(
      rulesReading(STRATUM, seedOf("start", "edge", "reach"), false),
    ).toEqual([0, 1, 3]);
  });

  it("skips a relation whose new facts ran out", () => {
    const seed = new Map<string, readonly Tuple[]>([
      ["edge", []],
      ["node", [["a"]]],
    ]);
    expect(rulesReading(STRATUM, seed, false)).toEqual([2]);
  });

  it("ignores a relation the stratum does not derive after the first round", () => {
    expect(rulesReading(STRATUM, seedOf("edge", "reach"), true)).toEqual([1]);
    expect(rulesReading(STRATUM, seedOf("edge"), true)).toEqual([]);
  });

  const RELATIONS = ["p", "q", "r", "s"];

  const arbRule: fc.Arbitrary<Rule> = fc
    .tuple(
      fc.constantFrom(...RELATIONS),
      fc.array(fc.tuple(fc.constantFrom(...RELATIONS), fc.boolean()), {
        maxLength: 4,
      }),
    )
    .map(([head, body]) =>
      rule(
        head,
        [v("x")],
        body.map(([relation, negated]) =>
          negated ? notLit(relation, v("x")) : lit(relation, v("x")),
        ),
      ),
    );

  it("picks the rules a round over every rule would have run", () => {
    fc.assert(
      fc.property(
        fc.array(arbRule, { maxLength: 12 }),
        fc.subarray(RELATIONS),
        fc.subarray(RELATIONS),
        fc.boolean(),
        (rules, filled, emptied, derivedOnly) => {
          const stratum = planStratum(rules);
          const seed = new Map<string, readonly Tuple[]>();
          for (const relation of filled) {
            seed.set(relation, [["a"]]);
          }
          for (const relation of emptied) {
            seed.set(relation, []);
          }
          const hasNewFacts = (relation: string): boolean =>
            (seed.get(relation) ?? []).length > 0 &&
            (!derivedOnly || stratum.derived.has(relation));
          const everyRuleChecked = rules.flatMap((r, at) =>
            r.body.some((l) => !l.negated && hasNewFacts(l.relation))
              ? [at]
              : [],
          );

          expect(rulesReading(stratum, seed, derivedOnly)).toEqual(
            everyRuleChecked,
          );
        },
      ),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });
});
