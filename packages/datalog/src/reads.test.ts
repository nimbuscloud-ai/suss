/**
 * A caller keeps an answer while the facts its lookups found are
 * unchanged. The property below asks the same question again after
 * random facts arrive, and whenever the reads say nothing they found
 * has changed, the answer derived again must be the one kept, in the
 * same order. The hand-written cases pin down which facts count as
 * found.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clearRelations,
  constant,
  Database,
  deriveOnDemand,
  evaluate,
  lit,
  noteReads,
  type ReadsNoted,
  type Rule,
  rule,
  type Term,
  type Tuple,
  variable as v,
} from "./index.js";

const PROPERTY_SEED = Number(process.env.SUSS_FUZZ_SEED) || 20260730;

const ARITY: Record<string, number> = { edge: 2, flag: 1, p: 2, q: 2, r: 1 };
const BASE = ["edge", "flag"] as const;
const DERIVED = ["p", "q", "r"] as const;
const NAMES = ["x", "y", "z"];

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

const VALUES = ["a", "b", "c", "d"] as const;

/** A literal's terms, some of them written as a constant when `constants` is set. */
const arbTerms = (names: string[], constants: boolean): fc.Arbitrary<Term[]> =>
  fc.tuple(
    ...names.map((name) =>
      constants
        ? fc.oneof(
            { weight: 3, arbitrary: fc.constant(v(name)) },
            { weight: 1, arbitrary: fc.constantFrom(...VALUES).map(constant) },
          )
        : fc.constant(v(name)),
    ),
  );

function arbRuleFor(index: number, constants = false): fc.Arbitrary<Rule> {
  const head = DERIVED[index] as string;
  const sources = [...BASE, ...DERIVED.slice(0, index + 1)];
  const arbLiteral = fc.constantFrom(...sources).chain((relation) =>
    fc
      .constantFrom(...termPatterns(ARITY[relation] as number))
      .chain((names) => arbTerms(names, constants))
      .map((terms) => lit(relation, ...terms)),
  );
  return fc
    .array(arbLiteral, { minLength: 1, maxLength: 3 })
    .map((body) => {
      const bound = new Set(
        body.flatMap((l) =>
          l.terms.map((t) => (t.type === "variable" ? t.name : "")),
        ),
      );
      return { body, headNames: NAMES.filter((n) => bound.has(n)) };
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

const arbRulesWith = (constants: boolean): fc.Arbitrary<Rule[]> =>
  fc
    .tuple(
      arbRuleFor(0, constants),
      arbRuleFor(1, constants),
      arbRuleFor(2, constants),
      arbRuleFor(0, constants),
    )
    .map((rules) => rules as Rule[]);

const arbRules = arbRulesWith(false);

const arbBaseFact = fc.constantFrom(...BASE).chain((relation) =>
  fc
    .array(fc.constantFrom(...VALUES), {
      minLength: ARITY[relation] as number,
      maxLength: ARITY[relation] as number,
    })
    .map((tuple) => [relation, tuple] as [string, Tuple]),
);

/** A fact extracted by other work, which a store usually clears up after. */
type Event = { asked: string } | { fact: [string, Tuple]; cleared: boolean };

const arbEvents: fc.Arbitrary<Event[]> = fc.array(
  fc.oneof(
    fc.constantFrom(...VALUES).map((asked) => ({ asked })),
    fc.record({ fact: arbBaseFact, cleared: fc.boolean() }),
  ),
  { minLength: 1, maxLength: 30 },
);

/** The facts in the files a question about each value reads, the same every time it is asked. */
const arbFilesUpTo = (facts: number) =>
  fc.tuple(...VALUES.map(() => fc.array(arbBaseFact, { maxLength: facts })));

const arbFiles = arbFilesUpTo(3);

/** The answer rows for one value, in the order the relation has them. */
const answersAbout = (db: Database, value: string): string[] =>
  ANSWERS.flatMap((relation) =>
    db.lookup(relation, 0, value).map((t) => `${relation}:${t.join("|")}`),
  );

/**
 * Run the events the way a store does, checking every answer the reads
 * vouch for. Returns how many they vouched for.
 */
function vouchedAnswers(
  rules: Rule[],
  complete: readonly string[],
  files: [string, Tuple][][],
  events: Event[],
): number {
  const program = deriveOnDemand([...rules, ...QUESTIONS], complete);
  const scope = [...program.demandDriven, "asked"];
  const skipped = new Set(scope);
  const db = new Database();
  const kept = new Map<
    string,
    { answer: string[]; reads: ReadsNoted | null }
  >();
  let vouched = 0;
  for (const event of events) {
    if ("fact" in event) {
      db.add(event.fact[0], event.fact[1]);
      evaluate(db, program.rules);
      if (event.cleared) {
        clearRelations(db, program.rules, scope);
      }
      continue;
    }
    const before = kept.get(event.asked);
    const unchanged = before?.reads?.unchangedIn(db) ?? false;
    const { value, reads } = noteReads(db, skipped, () => {
      db.add("asked", [event.asked]);
      evaluate(db, program.rules);
      for (const [relation, tuple] of files[
        VALUES.indexOf(event.asked as (typeof VALUES)[number])
      ] ?? []) {
        db.add(relation, tuple);
      }
      evaluate(db, program.rules);
      return answersAbout(db, event.asked);
    });
    clearRelations(db, program.rules, scope);
    if (unchanged) {
      vouched++;
      expect(value).toEqual(before?.answer);
    }
    kept.set(event.asked, { answer: value, reads });
  }
  return vouched;
}

describe("keeping an answer while its reads find the same facts", () => {
  it("never keeps an answer that deriving again would change", () => {
    let vouched = 0;
    fc.assert(
      fc.property(arbRules, arbFiles, arbEvents, (rules, files, events) => {
        vouched += vouchedAnswers(rules, ANSWERS, files, events);
      }),
      { numRuns: 400, seed: PROPERTY_SEED },
    );
    expect(vouched).toBeGreaterThan(100);
  });

  it("never keeps one when the rules read a relation kept between questions", () => {
    let vouched = 0;
    fc.assert(
      fc.property(arbRules, arbFiles, arbEvents, (rules, files, events) => {
        vouched += vouchedAnswers(rules, [...ANSWERS, "q"], files, events);
      }),
      { numRuns: 400, seed: PROPERTY_SEED },
    );
    expect(vouched).toBeGreaterThan(100);
  });

  it("never keeps one with constants in the rules and many facts to a file", () => {
    let vouched = 0;
    fc.assert(
      fc.property(
        arbRulesWith(true),
        arbFilesUpTo(12),
        arbEvents,
        (rules, files, events) => {
          vouched += vouchedAnswers(rules, [...ANSWERS, "q"], files, events);
        },
      ),
      { numRuns: 400, seed: PROPERTY_SEED },
    );
    expect(vouched).toBeGreaterThan(100);
  });
});

describe("what a read finds", () => {
  const rules = [
    rule(
      "answer",
      [v("x"), v("y")],
      [lit("asked", v("x")), lit("edge", v("x"), v("y"))],
    ),
  ];
  const program = deriveOnDemand(rules, ["answer"]);
  const scope = [...program.demandDriven, "asked"];

  function askedAbout(db: Database, value: string): ReadsNoted {
    const { reads } = noteReads(db, new Set(scope), () => {
      db.add("asked", [value]);
      evaluate(db, program.rules);
      return db.lookup("answer", 0, value);
    });
    clearRelations(db, program.rules, scope);
    if (reads === null) {
      throw new Error("a question asked on cleared relations gave no reads");
    }
    return reads;
  }

  it("gives no reads for a question asked on facts a skipped relation kept", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("asked", ["b"]);
    const { reads } = noteReads(db, new Set(scope), () => {
      db.add("asked", ["a"]);
      evaluate(db, program.rules);
    });
    expect(reads).toBeNull();
  });

  it("changes while a skipped relation has facts", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const reads = askedAbout(db, "a");
    db.add("asked", ["b"]);
    expect(reads.unchangedIn(db)).toBe(false);
  });

  it("is unchanged by a fact under a value the join never looked up", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const reads = askedAbout(db, "a");
    db.add("edge", ["c", "d"]);
    expect(reads.unchangedIn(db)).toBe(true);
  });

  it("changes with a fact under a value the join looked up", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const reads = askedAbout(db, "a");
    db.add("edge", ["a", "c"]);
    expect(reads.unchangedIn(db)).toBe(false);
  });

  it("changes when a relation found empty gets its first fact", () => {
    const db = new Database();
    db.add("flag", ["z"]);
    const reads = askedAbout(db, "a");
    db.add("edge", ["c", "d"]);
    expect(reads.unchangedIn(db)).toBe(false);
  });

  it("changes when a fact it found is taken back, even if another arrives", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const reads = askedAbout(db, "a");
    db.retract("edge", [["a", "b"]]);
    db.add("edge", ["a", "c"]);
    expect(reads.unchangedIn(db)).toBe(false);
  });

  it("notes the variable's column over a constant's", () => {
    const kinds = [
      rule(
        "answer",
        [v("x")],
        [lit("asked", v("x")), lit("kind", v("x"), constant("function"))],
      ),
    ];
    const byKind = deriveOnDemand(kinds, ["answer"]);
    const cleared = [...byKind.demandDriven, "asked"];
    const db = new Database();
    db.add("kind", ["a", "function"]);
    // The first evaluation reads everything; a question resumes from it.
    evaluate(db, byKind.rules);
    const { reads } = noteReads(db, new Set(cleared), () => {
      db.add("asked", ["a"]);
      evaluate(db, byKind.rules);
      return db.lookup("answer", 0, "a");
    });
    clearRelations(db, byKind.rules, cleared);
    db.add("kind", ["b", "function"]);
    expect(reads?.unchangedIn(db)).toBe(true);
    db.add("kind", ["a", "class"]);
    expect(reads?.unchangedIn(db)).toBe(false);
  });

  it("passes an inner question's reads to the one asking it", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const { reads } = noteReads(db, new Set(scope), () => askedAbout(db, "a"));
    db.add("edge", ["a", "c"]);
    expect(reads?.unchangedIn(db)).toBe(false);
  });

  it("notes a check for a fact with no columns as a read of the whole relation", () => {
    const db = new Database();
    const { reads } = noteReads(db, new Set(scope), () => db.has("ready", []));
    db.add("ready", []);
    expect(reads?.unchangedIn(db)).toBe(false);
  });

  it("passes on a relation an inner question read whole", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const { reads } = noteReads(db, new Set(scope), () =>
      noteReads(db, new Set(scope), () => db.facts("edge")),
    );
    db.add("edge", ["m", "n"]);
    expect(reads?.unchangedIn(db)).toBe(false);
  });
});
