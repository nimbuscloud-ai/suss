import { describe, expect, it } from "vitest";

import {
  constant,
  Database,
  evaluate,
  lit,
  notLit,
  rule,
  stratify,
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
