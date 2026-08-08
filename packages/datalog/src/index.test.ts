import { describe, expect, it } from "vitest";

import {
  constant,
  Database,
  evaluate,
  lit,
  notLit,
  rule,
  stratify,
  tupleKey,
  tupleKeyParts,
  variable,
} from "./index.js";

const V = variable;

const sorted = (tuples: readonly (readonly (string | number)[])[]): string[] =>
  tuples.map((t) => t.join(",")).sort();

describe("Database", () => {
  it("deduplicates facts and distinguishes value types", () => {
    const db = new Database();
    expect(db.add("r", ["a", 1])).toBe(true);
    expect(db.add("r", ["a", 1])).toBe(false);
    // "1" (string) and 1 (number) are different atoms.
    expect(db.add("r", ["a", "1"])).toBe(true);
    expect(db.size("r")).toBe(2);
    expect(db.has("r", ["a", 1])).toBe(true);
    expect(db.has("missing", ["a"])).toBe(false);
  });

  it("keeps tuples apart when a value looks like the key encoding", () => {
    const db = new Database();
    // Every pair here would collide under a scheme that joins the
    // columns on some character and trusts values not to contain it.
    const pairs: [string | number, string][] = [
      ["a\u0000sb", "c"],
      ["a", "b\u0000sc"],
      ["a:b", "c"],
      ["a", "b:c"],
      ["3:a:b", "c"],
      ["ab", "c"],
      ["a", "bc"],
      [1, "x"],
      ["1", "x"],
    ];
    for (const pair of pairs) {
      expect(db.add("r", pair)).toBe(true);
    }

    expect(db.size("r")).toBe(pairs.length);
  });
});

describe("evaluate — positive rules", () => {
  it("computes transitive closure over a chain", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    db.add("edge", ["c", "d"]);

    evaluate(db, [
      rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
      rule(
        "path",
        [V("x"), V("z")],
        [lit("path", V("x"), V("y")), lit("edge", V("y"), V("z"))],
      ),
    ]);

    expect(sorted(db.facts("path"))).toEqual([
      "a,b",
      "a,c",
      "a,d",
      "b,c",
      "b,d",
      "c,d",
    ]);
  });

  it("terminates on cyclic graphs", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "a"]);

    evaluate(db, [
      rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
      rule(
        "path",
        [V("x"), V("z")],
        [lit("path", V("x"), V("y")), lit("path", V("y"), V("z"))],
      ),
    ]);

    expect(sorted(db.facts("path"))).toEqual(["a,a", "a,b", "b,a", "b,b"]);
  });

  it("computes reachability from marked entry points", () => {
    const db = new Database();
    db.add("entry", ["main"]);
    db.add("calls", ["main", "helper"]);
    db.add("calls", ["helper", "util"]);
    db.add("calls", ["orphan", "util"]);

    evaluate(db, [
      rule("reachable", [V("f")], [lit("entry", V("f"))]),
      rule(
        "reachable",
        [V("g")],
        [lit("reachable", V("f")), lit("calls", V("f"), V("g"))],
      ),
    ]);

    expect(sorted(db.facts("reachable"))).toEqual(["helper", "main", "util"]);
  });

  it("matches constants in body literals and emits constants in heads", () => {
    const db = new Database();
    db.add("status", ["t1", 200]);
    db.add("status", ["t2", 404]);

    evaluate(db, [
      rule(
        "isSuccess",
        [V("t"), constant("yes")],
        [lit("status", V("t"), constant(200))],
      ),
    ]);

    expect(sorted(db.facts("isSuccess"))).toEqual(["t1,yes"]);
  });

  it("handles mutual recursion within one stratum", () => {
    const db = new Database();
    db.add("succ", [0, 1]);
    db.add("succ", [1, 2]);
    db.add("succ", [2, 3]);
    db.add("succ", [3, 4]);

    evaluate(db, [
      rule("even", [constant(0)], [lit("succ", constant(0), V("_"))]),
      rule("odd", [V("m")], [lit("even", V("n")), lit("succ", V("n"), V("m"))]),
      rule("even", [V("m")], [lit("odd", V("n")), lit("succ", V("n"), V("m"))]),
    ]);

    expect(sorted(db.facts("even"))).toEqual(["0", "2", "4"]);
    expect(sorted(db.facts("odd"))).toEqual(["1", "3"]);
  });
});

describe("evaluate — stratified negation", () => {
  it("derives complements once the positive stratum is complete", () => {
    const db = new Database();
    db.add("node", ["a"]);
    db.add("node", ["b"]);
    db.add("node", ["c"]);
    db.add("entry", ["a"]);
    db.add("edge", ["a", "b"]);

    evaluate(db, [
      rule("reachable", [V("n")], [lit("entry", V("n"))]),
      rule(
        "reachable",
        [V("m")],
        [lit("reachable", V("n")), lit("edge", V("n"), V("m"))],
      ),
      rule(
        "unreachable",
        [V("n")],
        [lit("node", V("n")), notLit("reachable", V("n"))],
      ),
    ]);

    expect(sorted(db.facts("unreachable"))).toEqual(["c"]);
  });

  it("supports negation over base relations", () => {
    const db = new Database();
    db.add("calls", ["a", "b"]);
    db.add("calls", ["b", "c"]);
    db.add("handles", ["a", "b"]);

    // Throw propagation blocked by a handler on the edge.
    evaluate(db, [
      rule("mayThrow", [constant("c")], [lit("calls", V("_"), constant("c"))]),
      rule(
        "mayThrow",
        [V("caller")],
        [
          lit("calls", V("caller"), V("callee")),
          lit("mayThrow", V("callee")),
          notLit("handles", V("caller"), V("callee")),
        ],
      ),
    ]);

    // c throws; b propagates (no handler); a does NOT (handles a→b).
    expect(sorted(db.facts("mayThrow"))).toEqual(["b", "c"]);
  });

  it("rejects negation cycles as unstratifiable", () => {
    const db = new Database();
    db.add("thing", ["x"]);
    expect(() =>
      evaluate(db, [
        rule("p", [V("x")], [lit("thing", V("x")), notLit("q", V("x"))]),
        rule("q", [V("x")], [lit("thing", V("x")), notLit("p", V("x"))]),
      ]),
    ).toThrow(/not stratifiable/);
  });

  it("rejects unbound variables in negated literals", () => {
    const db = new Database();
    db.add("thing", ["x"]);
    expect(() =>
      evaluate(db, [
        rule("p", [V("x")], [lit("thing", V("x")), notLit("q", V("y"))]),
      ]),
    ).toThrow(/unbound variable "y"/);
  });
});

describe("stratify", () => {
  it("orders negative dependencies into later strata", () => {
    const rules = [
      rule("reach", [V("n")], [lit("edge", V("s"), V("n"))]),
      rule("dead", [V("n")], [lit("node", V("n")), notLit("reach", V("n"))]),
      rule("report", [V("n")], [lit("dead", V("n"))]),
    ];
    const strata = stratify(rules);
    expect(strata).toHaveLength(2);
    expect(strata[0].map((r) => r.head.relation)).toEqual(["reach"]);
    expect(strata[1].map((r) => r.head.relation).sort()).toEqual([
      "dead",
      "report",
    ]);
  });
});

describe("evaluate — scale sanity", () => {
  it("closes a 500-node chain promptly", () => {
    const db = new Database();
    for (let i = 0; i < 500; i++) {
      db.add("edge", [i, i + 1]);
    }
    db.add("entry", [0]);
    const start = performance.now();
    evaluate(db, [
      rule("reachable", [V("n")], [lit("entry", V("n"))]),
      rule(
        "reachable",
        [V("m")],
        [lit("reachable", V("n")), lit("edge", V("n"), V("m"))],
      ),
    ]);
    const elapsed = performance.now() - start;
    expect(db.size("reachable")).toBe(501);
    // Semi-naïve means linear rounds with per-round work proportional
    // to the delta; a quadratic-blowup regression would take seconds.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("Database.lookup", () => {
  it("returns the facts holding a value at a column", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["a", "c"]);
    db.add("edge", ["b", "c"]);

    expect(sorted(db.lookup("edge", 0, "a"))).toEqual(["a,b", "a,c"]);
    expect(sorted(db.lookup("edge", 1, "c"))).toEqual(["a,c", "b,c"]);
    expect(db.lookup("edge", 0, "z")).toEqual([]);
    expect(db.lookup("absent", 0, "a")).toEqual([]);
  });

  it("keeps an index current as facts arrive after it is built", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    expect(sorted(db.lookup("edge", 0, "a"))).toEqual(["a,b"]);

    db.add("edge", ["a", "c"]);
    expect(sorted(db.lookup("edge", 0, "a"))).toEqual(["a,b", "a,c"]);
  });

  it("does not confuse a number with the string that spells it", () => {
    const db = new Database();
    db.add("r", [1, "one"]);
    db.add("r", ["1", "text"]);

    expect(sorted(db.lookup("r", 0, 1))).toEqual(["1,one"]);
    expect(sorted(db.lookup("r", 0, "1"))).toEqual(["1,text"]);
  });
});

describe("evaluate — resuming a previous fixpoint", () => {
  const CLOSURE = [
    rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
    rule(
      "path",
      [V("x"), V("z")],
      [lit("path", V("x"), V("y")), lit("edge", V("y"), V("z"))],
    ),
  ];

  const freshClosureOver = (edges: Array<[string, string]>): string[] => {
    const db = new Database();
    for (const [from, to] of edges) {
      db.add("edge", [from, to]);
    }
    evaluate(db, CLOSURE);
    return sorted(db.facts("path"));
  };

  it("reaches the same answer as evaluating everything at once", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, CLOSURE);

    db.add("edge", ["c", "d"]);
    db.add("edge", ["x", "a"]);
    evaluate(db, CLOSURE);

    expect(sorted(db.facts("path"))).toEqual(
      freshClosureOver([
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["x", "a"],
      ]),
    );
  });

  it("derives nothing further when no facts were added", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, CLOSURE);
    const afterFirst = sorted(db.facts("path"));

    evaluate(db, CLOSURE);

    expect(sorted(db.facts("path"))).toEqual(afterFirst);
  });

  it("starts over when the rules change", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, CLOSURE);

    // A rule set the first pass never ran; resuming would miss it.
    evaluate(db, [
      rule("backward", [V("y"), V("x")], [lit("edge", V("x"), V("y"))]),
    ]);

    expect(sorted(db.facts("backward"))).toEqual(["b,a", "c,b"]);
  });

  const SINKS = [
    rule("node", [V("x")], [lit("edge", V("x"), V("y"))]),
    rule("node", [V("y")], [lit("edge", V("x"), V("y"))]),
    rule("hasOut", [V("x")], [lit("edge", V("x"), V("y"))]),
    rule("sink", [V("x")], [lit("node", V("x")), notLit("hasOut", V("x"))]),
  ];

  it("takes back a conclusion a new fact invalidates", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    evaluate(db, SINKS);
    expect(sorted(db.facts("sink"))).toEqual(["b"]);

    // "b" has an edge out of it now, so it is no longer a sink. A pass
    // that only ever added facts would leave the old answer standing.
    db.add("edge", ["b", "c"]);
    evaluate(db, SINKS);

    expect(sorted(db.facts("node"))).toEqual(["a", "b", "c"]);
    expect(sorted(db.facts("sink"))).toEqual(["c"]);
  });

  it("matches a fresh database on the same facts", () => {
    const incremental = new Database();
    incremental.add("edge", ["a", "b"]);
    evaluate(incremental, SINKS);
    incremental.add("edge", ["b", "c"]);
    incremental.add("edge", ["c", "a"]);
    evaluate(incremental, SINKS);

    const fresh = new Database();
    for (const edge of [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ]) {
      fresh.add("edge", edge);
    }
    evaluate(fresh, SINKS);

    expect(sorted(incremental.facts("sink"))).toEqual(
      sorted(fresh.facts("sink")),
    );
    expect(sorted(incremental.facts("node"))).toEqual(
      sorted(fresh.facts("node")),
    );
  });

  it("leaves the caller's own facts alone when it takes conclusions back", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    evaluate(db, SINKS);

    db.add("edge", ["b", "c"]);
    evaluate(db, SINKS);

    expect(sorted(db.facts("edge"))).toEqual(["a,b", "b,c"]);
  });
});

describe("Database.retract", () => {
  it("removes facts and reports how many were there", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);

    expect(
      db.retract("edge", [
        ["a", "b"],
        ["x", "y"],
      ]),
    ).toBe(1);
    expect(sorted(db.facts("edge"))).toEqual(["b,c"]);
    expect(db.has("edge", ["a", "b"])).toBe(false);
    expect(db.retract("absent", [["a"]])).toBe(0);
    expect(db.retract("edge", [])).toBe(0);
  });

  it("keeps lookups correct afterwards", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["a", "c"]);
    expect(sorted(db.lookup("edge", 0, "a"))).toEqual(["a,b", "a,c"]);

    db.retract("edge", [["a", "b"]]);

    expect(sorted(db.lookup("edge", 0, "a"))).toEqual(["a,c"]);
  });

  it("makes the next evaluate start over", () => {
    const rules = [
      rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
    ];
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, rules);

    // Retracting a derived fact behind evaluation's back would stay
    // missing if the next call resumed from the old fixpoint.
    db.retract("path", [["a", "b"]]);
    evaluate(db, rules);

    expect(sorted(db.facts("path"))).toEqual(["a,b", "b,c"]);
  });
});

describe("evaluate — taking conclusions back", () => {
  const BLOCKABLE = [
    rule("q", [V("x")], [lit("p", V("x")), notLit("blocked", V("x"))]),
  ];

  it("drops a conclusion whose support the caller retracted", () => {
    const db = new Database();
    db.add("p", ["1"]);
    db.add("p", ["2"]);
    evaluate(db, BLOCKABLE);
    expect(sorted(db.facts("q"))).toEqual(["1", "2"]);

    db.retract("p", [["1"]]);
    evaluate(db, BLOCKABLE);

    // q(1) has nothing holding it up now.
    expect(sorted(db.facts("q"))).toEqual(["2"]);
  });

  it("leaves alone a fact the caller asserted after it was derived", () => {
    const db = new Database();
    db.add("p", ["1"]);
    evaluate(db, BLOCKABLE);
    expect(sorted(db.facts("q"))).toEqual(["1"]);

    // The caller now states q(1) themselves. Blocking p(1) afterwards
    // takes the derivation away, but not the caller's own fact.
    db.add("q", ["1"]);
    db.add("blocked", ["1"]);
    evaluate(db, BLOCKABLE);

    expect(sorted(db.facts("q"))).toEqual(["1"]);
  });

  it("still owns a fact two of its own rules derived", () => {
    // Two rules with the same head reach q(1). The second derivation
    // reports nothing new, which must not read as the caller claiming
    // the fact, or nothing can take it back afterwards.
    const rules = [
      rule("q", [V("x")], [lit("p", V("x")), notLit("blocked", V("x"))]),
      rule("q", [V("x")], [lit("s", V("x")), notLit("blocked", V("x"))]),
    ];
    const db = new Database();
    db.add("p", ["1"]);
    db.add("s", ["1"]);
    evaluate(db, rules);
    expect(sorted(db.facts("q"))).toEqual(["1"]);

    db.add("blocked", ["1"]);
    evaluate(db, rules);

    expect(sorted(db.facts("q"))).toEqual([]);
  });

  it("still owns a fact a recursive rule reached twice", () => {
    const rules = [
      rule(
        "reach",
        [V("x"), V("y")],
        [lit("edge", V("x"), V("y")), notLit("off", V("x"), V("y"))],
      ),
      rule(
        "reach",
        [V("x"), V("z")],
        [lit("reach", V("x"), V("y")), lit("edge", V("y"), V("z"))],
      ),
    ];
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "a"]);
    evaluate(db, rules);

    db.add("off", ["a", "b"]);
    evaluate(db, rules);

    const fresh = new Database();
    fresh.add("edge", ["a", "b"]);
    fresh.add("edge", ["b", "a"]);
    fresh.add("off", ["a", "b"]);
    evaluate(fresh, rules);

    expect(sorted(db.facts("reach"))).toEqual(sorted(fresh.facts("reach")));
  });

  it("takes back only what its own rules concluded", () => {
    const positive = [rule("r", [V("x")], [lit("p", V("x"))])];
    const db = new Database();
    db.add("p", ["1"]);
    evaluate(db, positive);
    expect(sorted(db.facts("r"))).toEqual(["1"]);

    // A negated rule set running on the same database has no business
    // touching what the positive one worked out.
    evaluate(db, BLOCKABLE);

    expect(sorted(db.facts("r"))).toEqual(["1"]);
    expect(sorted(db.facts("q"))).toEqual(["1"]);
  });
});

describe("tupleKey", () => {
  it("gives two different tuples two different keys", () => {
    // Joined on a separator, "a" + "b|c" and "a|b" + "c" would be the
    // same string and a lookup would answer with the wrong facts.
    expect(tupleKey(["a", "b|c"])).not.toBe(tupleKey(["a|b", "c"]));
  });

  it("keeps values apart when one of them holds the unit separator", () => {
    expect(tupleKey(["a\u001fb", "c"])).not.toBe(tupleKey(["a", "b\u001fc"]));
  });

  it("hands back the values it was given", () => {
    expect(tupleKeyParts(tupleKey(["/src/mod.ts", "handler"]))).toEqual([
      "/src/mod.ts",
      "handler",
    ]);
  });

  it("hands back a value that is empty, and one that holds a colon", () => {
    expect(tupleKeyParts(tupleKey(["", "s3:", "n1:"]))).toEqual([
      "",
      "s3:",
      "n1:",
    ]);
  });

  it("keeps a number apart from the text of that number", () => {
    expect(tupleKey([7])).not.toBe(tupleKey(["7"]));
    expect(tupleKeyParts(tupleKey([7, "x"]))).toEqual(["7", "x"]);
  });

  it("refuses a string it did not write", () => {
    // A key that does not parse means two encodings were joined, and
    // every answer read out of it after that would be wrong.
    expect(() => tupleKeyParts("s3:ab")).toThrow("not a tuple key");
    expect(() => tupleKeyParts("nope")).toThrow("not a tuple key");
    expect(() => tupleKeyParts("x1:a")).toThrow("not a tuple key");
    expect(() => tupleKeyParts("s-1:a")).toThrow("not a tuple key");
  });
});
