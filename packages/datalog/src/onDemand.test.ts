// What the rewrite has to preserve, over rule sets nobody hand-picked.
//
// Deriving less is only worth something if the answers are the same, so
// the main property here is a differential one: the same facts through
// the plain rules and through the rewritten rules give the same complete
// relations, tuple for tuple. The rest are the cases a reader would want
// spelled out.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clearRelations,
  constant,
  Database,
  deriveOnDemand,
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

// There are two base relations the rules read, three derived ones they
// write, and one more that says which values somebody is asking about.
const ARITY: Record<string, number> = {
  edge: 2,
  flag: 1,
  asked: 1,
  p: 2,
  q: 2,
  r: 1,
};

const BASE = ["edge", "flag"] as const;
const DERIVED = ["p", "q", "r"] as const;
const NAMES = ["x", "y", "z"];

/** The questions asked of every generated rule set. */
const QUESTIONS = [
  rule(
    "answerP",
    [v("x"), v("y")],
    [lit("asked", v("x")), lit("p", v("x"), v("y"))],
  ),
  rule("answerR", [v("x")], [lit("asked", v("x")), lit("r", v("x"))]),
];

const ANSWERS = ["answerP", "answerR"];

function termPatterns(arity: number): string[][] {
  if (arity === 1) {
    return NAMES.map((n) => [n]);
  }
  return NAMES.flatMap((first) => NAMES.map((second) => [first, second]));
}

const litFor = (relation: string, names: string[]) =>
  lit(relation, ...names.map((n) => v(n)));

/**
 * One rule for a derived relation, positive throughout. A body literal
 * may refer to a base relation, an earlier derived relation, or this one, so
 * generated rule sets recurse the way the resolution rules do.
 */
function arbRuleFor(index: number): fc.Arbitrary<Rule> {
  const head = DERIVED[index] as string;
  const sources = [...BASE, ...DERIVED.slice(0, index + 1)];
  const arbLiteral = fc
    .constantFrom(...sources)
    .chain((relation) =>
      fc
        .constantFrom(...termPatterns(ARITY[relation] as number))
        .map((names) => litFor(relation, names)),
    );

  return fc
    .array(arbLiteral, { minLength: 1, maxLength: 3 })
    .map((body) => {
      const bound = new Set(
        body.flatMap((l) =>
          l.terms.map((t) => (t.type === "variable" ? t.name : "")),
        ),
      );
      const headNames = NAMES.filter((n) => bound.has(n));
      return { body, headNames };
    })
    .filter(({ headNames }) => headNames.length >= (ARITY[head] as number))
    .map(({ body, headNames }) =>
      rule(
        head,
        headNames.slice(0, ARITY[head] as number).map((n) => v(n)),
        body,
      ),
    );
}

const arbRules = fc
  .tuple(arbRuleFor(0), arbRuleFor(1), arbRuleFor(2), arbRuleFor(0))
  .map((rules) => rules as Rule[]);

const arbFacts = fc.array(
  fc.constantFrom("edge", "flag", "asked").chain((relation) =>
    fc
      .array(fc.constantFrom("a", "b", "c", "d"), {
        minLength: ARITY[relation] as number,
        maxLength: ARITY[relation] as number,
      })
      .map((tuple) => [relation, tuple] as [string, Tuple]),
  ),
  { minLength: 1, maxLength: 30 },
);

function fill(facts: Array<[string, Tuple]>): Database {
  const db = new Database();
  for (const [relation, tuple] of facts) {
    db.add(relation, tuple);
  }
  return db;
}

/** The answer rows for one value, which is all a caller reads back. */
const answersAbout = (db: Database, value: string): Record<string, string[]> =>
  Object.fromEntries(
    ANSWERS.map((relation) => [
      relation,
      db
        .facts(relation)
        .filter((tuple) => tuple[0] === value)
        .map((t) => t.join("|"))
        .sort(),
    ]),
  );

const answersFrom = (db: Database): Record<string, string[]> =>
  Object.fromEntries(
    ANSWERS.map((relation) => [
      relation,
      db
        .facts(relation)
        .map((t) => t.join("|"))
        .sort(),
    ]),
  );

describe("answering the same questions from less", () => {
  it("gives the complete relations the plain rules give", () => {
    fc.assert(
      fc.property(arbRules, arbFacts, (rules, facts) => {
        const whole = [...rules, ...QUESTIONS];
        const plain = evaluate(fill(facts), whole);
        const onDemand = evaluate(
          fill(facts),
          deriveOnDemand(whole, ANSWERS).rules,
        );
        expect(answersFrom(onDemand)).toEqual(answersFrom(plain));
      }),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });

  it("gives the same answers when the facts arrive in waves", () => {
    fc.assert(
      fc.property(arbRules, arbFacts, (rules, facts) => {
        const whole = [...rules, ...QUESTIONS];
        const rewritten = deriveOnDemand(whole, ANSWERS).rules;

        const inOneGo = evaluate(fill(facts), rewritten);
        const resumed = new Database();
        for (const [relation, tuple] of facts) {
          resumed.add(relation, tuple);
          evaluate(resumed, rewritten);
        }
        expect(answersFrom(resumed)).toEqual(answersFrom(inOneGo));
      }),
      { numRuns: 200, seed: PROPERTY_SEED },
    );
  });

  it("answers a question the same whether or not earlier ones were cleared", () => {
    fc.assert(
      fc.property(arbRules, arbFacts, (rules, facts) => {
        const whole = [...rules, ...QUESTIONS];
        const program = deriveOnDemand(whole, ANSWERS);
        const scope = [...program.demandDriven, "asked"];

        const scoped = new Database();
        const keeping = new Database();
        for (const [relation, tuple] of facts) {
          scoped.add(relation, tuple);
          keeping.add(relation, tuple);
          if (relation !== "asked") {
            continue;
          }
          evaluate(scoped, program.rules);
          evaluate(keeping, whole);
          const asked = String(tuple[0]);
          expect(answersAbout(scoped, asked)).toEqual(
            answersAbout(keeping, asked),
          );
          clearRelations(scoped, program.rules, scope);
        }
      }),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });

  it("derives no more of a complete relation than it has to", () => {
    fc.assert(
      fc.property(arbRules, arbFacts, (rules, facts) => {
        const whole = [...rules, ...QUESTIONS];
        const plain = evaluate(fill(facts), whole);
        const onDemand = evaluate(
          fill(facts),
          deriveOnDemand(whole, ANSWERS).rules,
        );
        for (const relation of DERIVED) {
          expect(onDemand.size(relation)).toBeLessThanOrEqual(
            plain.size(relation),
          );
        }
      }),
      { numRuns: 200, seed: PROPERTY_SEED },
    );
  });
});

describe("the rewrite itself", () => {
  const chain = [
    rule("reaches", [v("x"), v("y")], [lit("edge", v("x"), v("y"))]),
    rule(
      "reaches",
      [v("x"), v("z")],
      [lit("edge", v("x"), v("y")), lit("reaches", v("y"), v("z"))],
    ),
    rule(
      "answer",
      [v("x"), v("y")],
      [lit("asked", v("x")), lit("reaches", v("x"), v("y"))],
    ),
  ];

  const reached = (db: Database, relation: string): string[] =>
    db
      .facts(relation)
      .map((t) => t.join("|"))
      .sort();

  it("follows a chain from the value somebody asked about", () => {
    const db = new Database();
    for (const [from, to] of [
      ["a", "b"],
      ["b", "c"],
      ["m", "n"],
      ["n", "o"],
    ]) {
      db.add("edge", [from, to]);
    }
    db.add("asked", ["a"]);

    evaluate(db, deriveOnDemand(chain, ["answer"]).rules);
    expect(reached(db, "answer")).toEqual(["a|b", "a|c"]);
    // The chain nobody asked about is not walked at all.
    expect(reached(db, "reaches")).toEqual(["a|b", "a|c", "b|c"]);
  });

  it("walks a chain that a later question reaches into", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, deriveOnDemand(chain, ["answer"]).rules);
    expect(reached(db, "answer")).toEqual([]);

    db.add("asked", ["a"]);
    evaluate(db, deriveOnDemand(chain, ["answer"]).rules);
    expect(reached(db, "answer")).toEqual(["a|b", "a|c"]);
  });

  it("costs a second question nothing for the first one's chain", () => {
    const program = deriveOnDemand(chain, ["answer"]);
    const scope = [...program.demandDriven, "asked"];
    const db = new Database();
    for (const [from, to] of [
      ["a", "b"],
      ["b", "c"],
      ["m", "n"],
      ["n", "o"],
    ]) {
      db.add("edge", [from, to]);
    }

    db.add("asked", ["a"]);
    evaluate(db, program.rules);
    expect(reached(db, "answer")).toEqual(["a|b", "a|c"]);
    clearRelations(db, program.rules, scope);

    db.add("asked", ["m"]);
    evaluate(db, program.rules);
    // Only the chain the second question walks, and the answers the
    // first question already gave.
    expect(reached(db, "reaches")).toEqual(["m|n", "m|o", "n|o"]);
    expect(reached(db, "answer")).toEqual(["a|b", "a|c", "m|n", "m|o"]);
  });

  it("keeps a constant in a rule head as a constant to match", () => {
    const rules = [
      rule("kind", [v("x"), constant("leaf")], [lit("flag", v("x"))]),
      rule(
        "answer",
        [v("x"), v("k")],
        [lit("asked", v("x")), lit("kind", v("x"), v("k"))],
      ),
    ];
    const db = new Database();
    db.add("flag", ["a"]);
    db.add("flag", ["b"]);
    db.add("asked", ["a"]);
    evaluate(db, deriveOnDemand(rules, ["answer"]).rules);
    expect(reached(db, "answer")).toEqual(["a|leaf"]);
  });

  it("tells apart two relations asked for different ways", () => {
    const rules = [
      rule("pair", [v("x"), v("y")], [lit("edge", v("x"), v("y"))]),
      rule(
        "leftOf",
        [v("x"), v("y")],
        [lit("asked", v("x")), lit("pair", v("x"), v("y"))],
      ),
      rule(
        "rightOf",
        [v("x"), v("y")],
        [lit("flag", v("y")), lit("pair", v("x"), v("y"))],
      ),
    ];
    const rewritten = deriveOnDemand(rules, ["leftOf", "rightOf"]).rules;
    const heads = new Set(rewritten.map((r) => r.head.relation));
    expect(heads.has("pair:bf")).toBe(true);
    expect(heads.has("pair:fb")).toBe(true);

    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["c", "d"]);
    db.add("asked", ["a"]);
    db.add("flag", ["d"]);
    evaluate(db, rewritten);
    expect(reached(db, "leftOf")).toEqual(["a|b"]);
    expect(reached(db, "rightOf")).toEqual(["c|d"]);
  });

  it("sends demand through the literal the head already binds", () => {
    // Asked with the value bound, written order would bind the module
    // and name off every re-export first and then want the recursive
    // literal with all three columns bound.
    const rules = [
      rule(
        "moduleExport",
        [v("m"), v("n"), v("value")],
        [lit("exportsAs", v("m"), v("n"), v("value"))],
      ),
      rule(
        "moduleExport",
        [v("m"), v("n"), v("value")],
        [
          lit("reExports", v("m"), v("n"), v("m2"), v("n2")),
          lit("moduleExport", v("m2"), v("n2"), v("value")),
        ],
      ),
      rule(
        "exporters",
        [v("m"), v("value")],
        [
          lit("asked", v("value")),
          lit("moduleExport", v("m"), v("n"), v("value")),
        ],
      ),
    ];
    const { rules: rewritten, demandDriven } = deriveOnDemand(rules, [
      "exporters",
    ]);
    expect(demandDriven).not.toContain("wanted:moduleExport:bbb");
    const recursive = rewritten.find(
      (r) => r.head.relation === "moduleExport" && r.body.length === 3,
    );
    expect(recursive?.body.map((l) => l.relation)).toEqual([
      "wanted:moduleExport",
      "moduleExport",
      "reExports",
    ]);
    // A rule saying the value is wanted because it is wanted is left out.
    expect(
      rewritten.filter((r) => r.head.relation === "wanted:moduleExport"),
    ).toHaveLength(1);

    const db = new Database();
    db.add("exportsAs", ["lib", "impl", "fn"]);
    db.add("reExports", ["barrel", "fn", "lib", "impl"]);
    db.add("reExports", ["other", "x", "lib", "x"]);
    db.add("asked", ["fn"]);
    evaluate(db, rewritten);
    expect(reached(db, "exporters")).toEqual(["barrel|fn", "lib|fn"]);
  });

  it("refuses a rule set that uses negation", () => {
    const rules = [
      rule(
        "answer",
        [v("x")],
        [lit("flag", v("x")), notLit("edge", v("x"), v("x"))],
      ),
    ];
    expect(() => deriveOnDemand(rules, ["answer"])).toThrow(/negation/);
  });

  it("refuses to answer a relation no rule derives", () => {
    expect(() => deriveOnDemand(chain, ["edge"])).toThrow(/no rule derives/);
  });
});
