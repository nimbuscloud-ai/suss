// The correctness bar for deriving these rules on demand.
//
// A caller that reads `wantedResolves` out of a demand-restricted run
// has to see exactly what it would have seen from a run that derived
// everything. There is no partial credit here: an answer that goes
// missing is a boundary suss stops finding, and a corpus is far too big
// to notice it by eye.
//
// So the fact bases are generated rather than written, over a small
// enough universe of values that the graphs come out dense and tangled,
// and both evaluators answer over the same facts. Facts are also fed in
// waves, because the store evaluates after each wave rather than once at
// the end, and a rewrite that is right from cold and wrong on resume
// would pass every other test in this repo.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  clearRelations,
  Database,
  deriveOnDemand,
  evaluate,
  type Tuple,
} from "@suss/datalog";

import {
  ANSWER_RELATIONS,
  RESOLUTION_QUESTIONS,
  RESOLUTION_RULES,
} from "./index.js";

const COMPLETE = [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS];
const PROGRAM = deriveOnDemand(COMPLETE, ANSWER_RELATIONS);
const ON_DEMAND = PROGRAM.rules;

/** What the store takes back once it has read a query's answer. */
const QUERY_FACTS = [...PROGRAM.demandDriven, "wanted", "wantedOrigin"];

/**
 * How wide each base relation is. Every relation an adapter supplies
 * appears, so a generated fact base can exercise any rule.
 */
const ARITY: Record<string, number> = {
  func: 1,
  objectValue: 1,
  writtenValue: 1,
  binds: 2,
  endsHolding: 2,
  readsProperty: 3,
  holdsProperty: 3,
  paramOf: 3,
  returnsValue: 2,
  bodyCalls: 2,
  containsFn: 2,
  call: 2,
  callArg: 3,
  imports: 3,
  exportsAs: 3,
  reExports: 4,
  reExportsAll: 2,
  calleeName: 2,
  calleeOrigin: 2,
  unwrapsByName: 2,
  wrapperModule: 2,
  wanted: 1,
  wantedOrigin: 1,
};

// Few enough values that generated facts join with each other rather
// than describing a forest of disconnected pairs.
const VALUES = ["a", "b", "c", "d", "e", "f"];
const NAMES = ["n", "m"];
const MODULES = ["lib", "app"];
const POSITIONS = ["0", "1"];

/**
 * Which universe each column draws from, so a generated `paramOf` puts a
 * position where a position goes. A relation not named here draws values
 * in every column.
 */
const COLUMNS: Record<string, string[][]> = {
  readsProperty: [VALUES, VALUES, NAMES],
  holdsProperty: [VALUES, NAMES, VALUES],
  paramOf: [VALUES, POSITIONS, VALUES],
  callArg: [VALUES, POSITIONS, VALUES],
  imports: [VALUES, MODULES, NAMES],
  exportsAs: [MODULES, NAMES, VALUES],
  reExports: [MODULES, NAMES, MODULES, NAMES],
  reExportsAll: [MODULES, MODULES],
  calleeName: [VALUES, NAMES],
  calleeOrigin: [VALUES, MODULES],
  unwrapsByName: [NAMES, POSITIONS],
  wrapperModule: [NAMES, MODULES],
};

const universeFor = (relation: string, column: number): string[] =>
  COLUMNS[relation]?.[column] ?? VALUES;

const arbFact = fc
  .constantFrom(...Object.keys(ARITY))
  .chain((relation) =>
    fc
      .tuple(
        ...Array.from({ length: ARITY[relation] as number }, (_, column) =>
          fc.constantFrom(...universeFor(relation, column)),
        ),
      )
      .map((tuple) => [relation, tuple] as [string, Tuple]),
  );

const arbFacts = fc.array(arbFact, { minLength: 5, maxLength: 60 });

const answersFrom = (db: Database): Record<string, string[]> =>
  Object.fromEntries(
    ANSWER_RELATIONS.map((relation) => [
      relation,
      db
        .facts(relation)
        .map((tuple) => tuple.join("|"))
        .sort(),
    ]),
  );

function fill(facts: Array<[string, Tuple]>): Database {
  const db = new Database();
  for (const [relation, tuple] of facts) {
    db.add(relation, tuple);
  }
  return db;
}

/**
 * What a caller reads back after asking one of the two questions about
 * `value`. `wanted` asks what the value is and reads the three answer
 * relations keyed by it; `wantedOrigin` asks where the name came from
 * and reads the imports it carries plus the calls made by whatever it
 * comes to.
 */
function readableFor(
  db: Database,
  question: string,
  value: string,
): Record<string, string[]> {
  const keyed = (relation: string): string[] =>
    db
      .facts(relation)
      .filter((tuple) => tuple[0] === value)
      .map((tuple) => tuple.join("|"))
      .sort();

  if (question === "wanted") {
    return {
      wantedResolves: keyed("wantedResolves"),
      wantedComesTo: keyed("wantedComesTo"),
      wantedIsWrittenAs: keyed("wantedIsWrittenAs"),
    };
  }

  const targets = new Set(
    db
      .facts("wantedComesTo")
      .filter((tuple) => tuple[0] === value)
      .map((tuple) => tuple[1]),
  );
  return {
    wantedComesFrom: keyed("wantedComesFrom"),
    wantedCallsInto: db
      .facts("wantedCallsInto")
      .filter((tuple) => targets.has(tuple[0]))
      .map((tuple) => tuple.join("|"))
      .sort(),
  };
}

/** Facts in, rules to fixpoint, answers out. */
function answers(
  facts: Array<[string, Tuple]>,
  rules: typeof COMPLETE,
): Record<string, string[]> {
  const db = fill(facts);
  evaluate(db, rules);
  return answersFrom(db);
}

describe("deriving the resolution rules on demand", () => {
  it("answers every question the way deriving everything does", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        expect(answers(facts, ON_DEMAND)).toEqual(answers(facts, COMPLETE));
      }),
      { numRuns: 400 },
    );
  });

  it("answers the same when the facts arrive in waves", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const resumed = new Database();
        for (const [relation, tuple] of facts) {
          resumed.add(relation, tuple);
          evaluate(resumed, ON_DEMAND);
        }
        expect(answersFrom(resumed)).toEqual(answers(facts, COMPLETE));
      }),
      { numRuns: 200 },
    );
  });

  it("answers the same when the questions arrive after the facts", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const asking = facts.filter(
          ([relation]) => relation === "wanted" || relation === "wantedOrigin",
        );
        const rest = facts.filter(
          ([relation]) => relation !== "wanted" && relation !== "wantedOrigin",
        );

        const late = fill(rest);
        evaluate(late, ON_DEMAND);
        for (const [relation, tuple] of asking) {
          late.add(relation, tuple);
        }
        evaluate(late, ON_DEMAND);

        expect(answersFrom(late)).toEqual(answers(facts, COMPLETE));
      }),
      { numRuns: 200 },
    );
  });

  it("answers a question the same whether or not earlier ones were cleared", () => {
    // The store reads an answer and then takes the question back, so
    // what it reads has to match what a database keeping every question
    // ever asked would have told it at that moment.
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const scoped = new Database();
        const keeping = new Database();
        for (const [relation, tuple] of facts) {
          scoped.add(relation, tuple);
          keeping.add(relation, tuple);
          if (relation !== "wanted" && relation !== "wantedOrigin") {
            continue;
          }
          evaluate(scoped, ON_DEMAND);
          evaluate(keeping, ON_DEMAND);
          const asked = String(tuple[0]);
          expect(readableFor(scoped, relation, asked)).toEqual(
            readableFor(keeping, relation, asked),
          );
          clearRelations(scoped, ON_DEMAND, QUERY_FACTS);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("holds nothing about a chain once the question is taken back", () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const db = fill(facts);
        evaluate(db, ON_DEMAND);
        clearRelations(db, ON_DEMAND, QUERY_FACTS);
        for (const relation of QUERY_FACTS) {
          expect(db.size(relation)).toBe(0);
        }
        // Nothing is owed: the rules have seen every fact the database
        // holds and no question is left to derive for.
        evaluate(db, ON_DEMAND);
        for (const relation of QUERY_FACTS) {
          expect(db.size(relation)).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("leaves the chains nobody asked about alone", () => {
    // Two independent alias chains, one of them asked about.
    const facts: Array<[string, Tuple]> = [
      ["func", ["target"]],
      ["binds", ["asked", "target"]],
      ["func", ["other"]],
      ["binds", ["ignored", "other"]],
      ["wanted", ["asked"]],
    ];
    const db = fill(facts);
    evaluate(db, ON_DEMAND);
    expect(db.facts("wantedResolves").map((t) => t.join("|"))).toEqual([
      "asked|target",
    ]);
    expect(
      db
        .facts("comesTo")
        .map((t) => t.join("|"))
        .sort(),
    ).toEqual(["asked|target", "target|target"]);
  });
});
