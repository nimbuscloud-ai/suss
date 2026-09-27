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
  type Atom,
  constant,
  Database,
  evaluate,
  lit,
  notLit,
  type Rule,
  rowBudget,
  rule,
  stratify,
  type Term,
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

const ATOMS = ["a", "b", "c"] as const;

/**
 * A rule with some of its body variables written as constants instead.
 * A head or negated variable no positive literal binds any more becomes
 * a constant too, so the rule stays well-formed.
 */
function withConstants(r: Rule, picks: readonly number[]): Rule {
  let at = 0;
  const pick = (): number => picks[at++ % picks.length] ?? 0;
  const body = r.body.map((literal) =>
    literal.negated
      ? literal
      : {
          ...literal,
          terms: literal.terms.map((term) => {
            const choice = pick();
            return choice < ATOMS.length ? constant(ATOMS[choice]) : term;
          }),
        },
  );
  const bound = new Set(
    body
      .filter((literal) => !literal.negated)
      .flatMap((literal) =>
        literal.terms.map((t) => (t.type === "variable" ? t.name : "")),
      ),
  );
  const grounded = (term: Term): Term =>
    term.type === "variable" && !bound.has(term.name) ? constant("a") : term;
  return {
    head: { ...r.head, terms: r.head.terms.map(grounded) },
    body: body.map((literal) =>
      literal.negated
        ? { ...literal, terms: literal.terms.map(grounded) }
        : literal,
    ),
  };
}

// Picks from 0 to 5: under three is a constant, the rest keep the variable.
const arbConstantRules: fc.Arbitrary<Rule[]> = fc
  .tuple(arbRules, fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1 }))
  .map(([rules, picks]) => rules.map((r) => withConstants(r, picks)));

/**
 * Every derived relation's contents from a fixpoint that tries every
 * binding of every rule, stratum by stratum, in written order. It shares
 * nothing with the engine but `stratify`, so it checks what the joins
 * leave out.
 */
function naiveModel(
  facts: Array<[string, Tuple]>,
  rules: Rule[],
): Record<string, string[]> {
  const known = new Map<string, Map<string, Tuple>>();
  const add = (relation: string, tuple: Tuple): boolean => {
    const rows = known.get(relation) ?? new Map<string, Tuple>();
    known.set(relation, rows);
    const key = tuple.join(",");
    if (rows.has(key)) {
      return false;
    }
    rows.set(key, tuple);
    return true;
  };
  for (const [relation, tuple] of facts) {
    add(relation, tuple);
  }
  const termValue = (
    term: Term,
    bindings: Map<string, Atom>,
  ): Atom | undefined =>
    term.type === "constant" ? term.value : bindings.get(term.name);
  const bindingsOf = (
    body: Rule["body"],
    bindings: Map<string, Atom>,
  ): Map<string, Atom>[] => {
    const [literal, ...rest] = body;
    if (literal === undefined) {
      return [bindings];
    }
    if (literal.negated) {
      const key = literal.terms.map((t) => termValue(t, bindings)).join(",");
      return known.get(literal.relation)?.has(key)
        ? []
        : bindingsOf(rest, bindings);
    }
    const out: Map<string, Atom>[] = [];
    for (const tuple of known.get(literal.relation)?.values() ?? []) {
      const next = new Map(bindings);
      const fits = literal.terms.every((term, column) => {
        const value = termValue(term, next);
        if (value === undefined && term.type === "variable") {
          next.set(term.name, tuple[column] as Atom);
          return true;
        }
        return value === tuple[column];
      });
      if (fits) {
        out.push(...bindingsOf(rest, next));
      }
    }
    return out;
  };
  for (const stratum of stratify(rules)) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of stratum) {
        for (const bindings of bindingsOf(r.body, new Map())) {
          const tuple = r.head.terms.map(
            (term) => termValue(term, bindings) as Atom,
          );
          changed = add(r.head.relation, tuple) || changed;
        }
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const name of DERIVED) {
    out[name] = [...(known.get(name)?.keys() ?? [])].sort();
  }
  return out;
}

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

  it("derives what trying every binding derives, with constants in the rules", () => {
    fc.assert(
      fc.property(arbConstantRules, arbFacts, (rules, facts) => {
        expect(model(evaluatedInOneGo(facts, rules))).toEqual(
          naiveModel(facts, rules),
        );
      }),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });

  it("derives the same in pieces, with constants in the rules", () => {
    fc.assert(
      fc.property(
        arbConstantRules,
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

          expect(model(incremental)).toEqual(naiveModel(facts, rules));
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

  it("leaves the lookups and joins a rebuild would give after retracting a few facts", () => {
    const atom = fc.constantFrom("a", "b", "c", "d");
    const joinInto = (head: string): Rule[] => [
      rule(
        head,
        [v("x"), v("z")],
        [lit("asked", v("x")), lit("t", v("x"), v("z"), constant("a"))],
      ),
      rule(
        head,
        [v("x"), v("x")],
        [lit("asked", v("x")), lit("t", v("x"), constant("b"), constant("a"))],
      ),
    ];
    const JOIN = joinInto("out");
    const built = (tuples: readonly Tuple[], asked: readonly string[]) => {
      const db = new Database();
      for (const tuple of tuples) {
        db.add("t", tuple);
      }
      for (const one of asked) {
        db.add("asked", [one]);
      }
      evaluate(db, JOIN);
      return db;
    };
    const lookups = (db: Database): string[][] =>
      [0, 1, 2].flatMap((column) =>
        ["a", "b", "c", "d"].map((value) =>
          db.lookup("t", column, value).map((tuple) => tuple.join(",")),
        ),
      );
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(atom, atom, atom), {
          minLength: 16,
          maxLength: 64,
          selector: (tuple) => tuple.join(","),
        }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        (tuples, picks) => {
          const inPlace = built(tuples, ["a", "b"]);
          lookups(inPlace);
          const going = picks.map((i) => [
            ...(tuples[i % tuples.length] ?? []),
          ]);
          const leaving = new Set(going.map((tuple) => tuple.join(",")));
          inPlace.retract("t", going);
          const rebuilt = built(
            tuples.filter((tuple) => !leaving.has(tuple.join(","))),
            ["a", "b"],
          );

          expect(inPlace.facts("t")).toEqual(rebuilt.facts("t"));
          expect(lookups(inPlace)).toEqual(lookups(rebuilt));
          // A rule set neither database has seen starts from nothing on
          // both, so its joins read the indexes in the order they have.
          const fresh = joinInto("again");
          evaluate(inPlace, fresh);
          evaluate(rebuilt, fresh);
          expect(inPlace.facts("again")).toEqual(rebuilt.facts("again"));
        },
      ),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });

  it("empties a relation in one step the way retracting each fact does", () => {
    fc.assert(
      fc.property(
        arbRules,
        arbFacts,
        arbFacts,
        fc.constantFrom(...BASE, ...DERIVED),
        (rules, before, after, emptied) => {
          const byEach = evaluatedInOneGo(before, rules);
          const whole = evaluatedInOneGo(before, rules);

          expect(whole.retractAll(emptied)).toBe(
            byEach.retract(emptied, [...byEach.facts(emptied)]),
          );

          const settle = (db: Database): number => {
            for (const [relation, tuple] of after) {
              db.add(relation, tuple);
            }
            const budget = rowBudget(Number.POSITIVE_INFINITY);
            evaluate(db, rules, undefined, budget);
            return budget.examined;
          };
          expect(settle(whole)).toBe(settle(byEach));
          expect(model(whole)).toEqual(model(byEach));
          expect(whole.lookup(emptied, 0, "a")).toEqual(
            byEach.lookup(emptied, 0, "a"),
          );
        },
      ),
      { numRuns: 200, seed: PROPERTY_SEED },
    );
  });
});
