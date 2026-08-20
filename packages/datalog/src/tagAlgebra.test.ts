import { describe, expect, it } from "vitest";

import {
  Database,
  deriveOnDemand,
  evaluate,
  lit,
  notLit,
  rule,
  type TagAlgebra,
  variable,
} from "./index.js";

const V = variable;

const pathRules = [
  rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
  rule(
    "path",
    [V("x"), V("z")],
    [lit("path", V("x"), V("y")), lit("edge", V("y"), V("z"))],
  ),
];

/**
 * Derivation cost: every firing adds one to the sum of its body costs,
 * an untagged fact costs nothing, and merge keeps the cheaper
 * derivation. Min over numbers is a bounded meet, so recursive rule
 * sets settle.
 */
const costAlgebra: TagAlgebra<number> = {
  asserted: 0,
  absent: 0,
  combine: (bodyTags) => bodyTags.reduce((sum, tag) => sum + tag, 1),
  merge: (stored, incoming) => (incoming < stored ? incoming : stored),
};

describe("Database tags", () => {
  const min = (stored: unknown, incoming: unknown): unknown =>
    Math.min(stored as number, incoming as number);

  it("answers added, improved, or unchanged", () => {
    const db = new Database();
    expect(db.add("r", ["a"])).toBe("added");
    expect(db.add("r", ["a"])).toBe("unchanged");
    expect(db.add("r", ["b"], 5)).toBe("added");
    expect(db.tagOf("r", ["b"])).toBe(5);
    expect(db.add("r", ["b"], 3, min)).toBe("improved");
    expect(db.tagOf("r", ["b"])).toBe(3);
    expect(db.add("r", ["b"], 7, min)).toBe("unchanged");
    expect(db.tagOf("r", ["b"])).toBe(3);
  });

  it("leaves the stored tag alone when no merge is given", () => {
    const db = new Database();
    db.add("r", ["a"], 5);
    expect(db.add("r", ["a"], 1)).toBe("unchanged");
    expect(db.tagOf("r", ["a"])).toBe(5);
  });

  it("drops tags with the facts they annotate", () => {
    const db = new Database();
    db.add("r", ["a"], 5);
    db.retract("r", [["a"]]);
    expect(db.tagOf("r", ["a"])).toBeUndefined();
    db.add("r", ["a"]);
    expect(db.tagOf("r", ["a"])).toBeUndefined();
  });
});

describe("evaluate with a tag algebra", () => {
  it("stores no tags when no algebra is supplied", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, pathRules);
    expect(db.has("path", ["a", "c"])).toBe(true);
    expect(db.tagOf("path", ["a", "c"])).toBeUndefined();
  });

  it("hands combine the body tags in rule-body order", () => {
    const db = new Database();
    db.add("a", ["x"], "A");
    db.add("b", ["x", "y"], "B");

    const combines: string[][] = [];
    const algebra: TagAlgebra<string> = {
      asserted: "base",
      absent: "gap",
      combine: (bodyTags) => {
        combines.push([...bodyTags]);
        return bodyTags.join("+");
      },
      merge: (stored) => stored,
    };
    evaluate(
      db,
      [
        rule(
          "r",
          [V("x"), V("y")],
          [lit("a", V("x")), lit("b", V("x"), V("y"))],
        ),
      ],
      algebra,
    );

    expect(combines).toEqual([["A", "B"]]);
    expect(db.tagOf("r", ["x", "y"])).toBe("A+B");
  });

  it("reads an untagged fact as asserted and a matched negation as absent", () => {
    const db = new Database();
    db.add("node", ["x"]);

    const combines: string[][] = [];
    const algebra: TagAlgebra<string> = {
      asserted: "base",
      absent: "gap",
      combine: (bodyTags) => {
        combines.push([...bodyTags]);
        return bodyTags.join("+");
      },
      merge: (stored) => stored,
    };
    evaluate(
      db,
      [
        rule(
          "lonely",
          [V("n")],
          [lit("node", V("n")), notLit("edge", V("n"), V("n"))],
        ),
      ],
      algebra,
    );

    expect(combines).toEqual([["base", "gap"]]);
    expect(db.tagOf("lonely", ["x"])).toBe("base+gap");
  });

  it("merges a repeat derivation and stores what merge returns", () => {
    const db = new Database();
    db.add("a", ["x"], "A");
    db.add("b", ["x"], "B");

    const merges: [string, string][] = [];
    const algebra: TagAlgebra<string> = {
      asserted: "base",
      absent: "gap",
      combine: (bodyTags) => bodyTags.join("+"),
      merge: (stored, incoming) => {
        merges.push([stored, incoming]);
        return `${stored}|${incoming}`;
      },
    };
    evaluate(
      db,
      [
        rule("p", [V("x")], [lit("a", V("x"))]),
        rule("p", [V("x")], [lit("b", V("x"))]),
      ],
      algebra,
    );

    expect(merges).toEqual([["A", "B"]]);
    expect(db.tagOf("p", ["x"])).toBe("A|B");
  });

  it("re-seeds the delta when a merge improves a tag, and downstream recomputes", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    db.add("edge", ["c", "d"]);
    // The costly direct edge makes path(a,c) start at 11, so the 2-hop
    // derivation must improve it, and path(a,d), first derived through
    // the 11, must recompute down to 3.
    db.add("edge", ["a", "c"], 10);

    evaluate(db, pathRules, costAlgebra);

    expect(db.tagOf("path", ["a", "c"])).toBe(2);
    expect(db.tagOf("path", ["a", "d"])).toBe(3);
  });

  it("reaches a fixpoint on a cycle under a bounded meet", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "a"]);

    evaluate(db, pathRules, costAlgebra);

    expect(db.tagOf("path", ["a", "b"])).toBe(1);
    expect(db.tagOf("path", ["a", "a"])).toBe(2);
    expect(db.tagOf("path", ["b", "b"])).toBe(2);
  });

  it("terminates on a cycle when merge never improves", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "a"]);

    const firstWins: TagAlgebra<number> = {
      ...costAlgebra,
      merge: (stored) => stored,
    };
    evaluate(db, pathRules, firstWins);

    expect(db.has("path", ["a", "a"])).toBe(true);
    expect(db.tagOf("path", ["a", "b"])).toBe(1);
  });

  it("does not store a merge that settles on asserted for an untagged fact", () => {
    const db = new Database();
    db.add("a", ["x"]);
    // The caller already asserted the conclusion, untagged. Re-deriving
    // it merges onto asserted and changes nothing, so nothing is stored.
    db.add("p", ["x"]);

    const algebra: TagAlgebra<string> = {
      asserted: "base",
      absent: "gap",
      combine: () => "base",
      merge: (stored) => stored,
    };
    evaluate(db, [rule("p", [V("x")], [lit("a", V("x"))])], algebra);

    expect(db.tagOf("p", ["x"])).toBeUndefined();
  });

  it("tags stratum by stratum, so a later stratum reads final tags", () => {
    const db = new Database();
    db.add("entry", ["a"], 5);
    db.add("entry", ["b"]);
    db.add("edge", ["b", "a"]);

    const log: string[] = [];
    const logged: TagAlgebra<number> = {
      asserted: 0,
      absent: -100,
      combine: (bodyTags) => {
        log.push(bodyTags.join(","));
        return bodyTags.reduce((sum, tag) => sum + tag, 1);
      },
      merge: costAlgebra.merge,
    };
    evaluate(
      db,
      [
        rule("reach", [V("x")], [lit("entry", V("x"))]),
        rule(
          "reach",
          [V("y")],
          [lit("reach", V("x")), lit("edge", V("x"), V("y"))],
        ),
        // blocked is derived, so the negation pushes ranked up a stratum.
        rule("blocked", [V("x")], [lit("flagged", V("x"))]),
        rule(
          "ranked",
          [V("x")],
          [lit("reach", V("x")), notLit("blocked", V("x"))],
        ),
      ],
      logged,
    );

    // reach(a) starts at 6 and merges down to 2 inside its own stratum,
    // so the ranked combines (the ones seeing absent) come after every
    // reach combine and read the 2, never the 6.
    const rankedCombines = log.filter((entry) => entry.includes("-100"));
    expect([...rankedCombines].sort()).toEqual(["1,-100", "2,-100"]);
    expect(log.slice(-2).sort()).toEqual([...rankedCombines].sort());
    expect(db.tagOf("ranked", ["a"])).toBe(2 - 100 + 1);
  });

  it("refuses an algebra over demand-rewritten rules", () => {
    const rules = [
      rule(
        "answer",
        [V("x"), V("z")],
        [lit("asked", V("x")), lit("path", V("x"), V("z"))],
      ),
      ...pathRules,
    ];
    const onDemand = deriveOnDemand(rules, ["answer"]);

    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("asked", ["a"]);

    expect(() => evaluate(db, onDemand.rules, costAlgebra)).toThrow(
      /demand-rewritten/,
    );

    evaluate(db, onDemand.rules);
    expect(db.has("answer", ["a", "b"])).toBe(true);
  });
});
