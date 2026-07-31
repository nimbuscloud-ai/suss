import { describe, expect, it } from "vitest";

import { atom, FactDb, rule, v } from "./engine.js";

describe("FactDb", () => {
  it("returns base facts matching a pattern", () => {
    const db = new FactDb();
    db.add("edge", "a", "b");
    db.add("edge", "b", "c");

    expect(db.query("edge", ["a", null])).toEqual([["a", "b"]]);
    expect(db.query("edge", [null, null])).toHaveLength(2);
  });

  it("derives a transitive closure", () => {
    const db = new FactDb();
    db.setRules([
      rule(atom("path", v("x"), v("y")), atom("edge", v("x"), v("y"))),
      rule(
        atom("path", v("x"), v("z")),
        atom("edge", v("x"), v("y")),
        atom("path", v("y"), v("z")),
      ),
    ]);
    db.add("edge", "a", "b");
    db.add("edge", "b", "c");
    db.add("edge", "c", "d");

    expect(db.has("path", ["a", "d"])).toBe(true);
    expect(db.has("path", ["d", "a"])).toBe(false);
  });

  it("reaches fixpoint on a cycle without looping forever", () => {
    const db = new FactDb();
    db.setRules([
      rule(atom("path", v("x"), v("y")), atom("edge", v("x"), v("y"))),
      rule(
        atom("path", v("x"), v("z")),
        atom("edge", v("x"), v("y")),
        atom("path", v("y"), v("z")),
      ),
    ]);
    db.add("edge", "a", "b");
    db.add("edge", "b", "a");

    expect(db.has("path", ["a", "a"])).toBe(true);
    expect(db.query("path", [null, null])).toHaveLength(4);
  });

  it("re-evaluates when facts arrive after a query", () => {
    const db = new FactDb();
    db.setRules([
      rule(atom("path", v("x"), v("y")), atom("edge", v("x"), v("y"))),
      rule(
        atom("path", v("x"), v("z")),
        atom("edge", v("x"), v("y")),
        atom("path", v("y"), v("z")),
      ),
    ]);
    db.add("edge", "a", "b");
    expect(db.has("path", ["a", "c"])).toBe(false);

    db.add("edge", "b", "c");
    expect(db.has("path", ["a", "c"])).toBe(true);
  });

  it("joins three atoms with shared variables", () => {
    // grandparent(x, z) needs both parent facts to agree on y.
    const db = new FactDb();
    db.setRules([
      rule(
        atom("grandparent", v("x"), v("z")),
        atom("parent", v("x"), v("y")),
        atom("parent", v("y"), v("z")),
      ),
    ]);
    db.add("parent", "ann", "ben");
    db.add("parent", "ben", "cal");
    db.add("parent", "ben", "dot");
    db.add("parent", "eve", "fay");

    expect(db.query("grandparent", ["ann", null]).map((t) => t[1])).toEqual([
      "cal",
      "dot",
    ]);
    expect(db.query("grandparent", ["eve", null])).toEqual([]);
  });

  it("binds literal terms in rule bodies", () => {
    const db = new FactDb();
    db.setRules([
      rule(
        atom("adminOf", v("who"), v("what")),
        atom("role", v("who"), "admin", v("what")),
      ),
    ]);
    db.add("role", "sam", "admin", "billing");
    db.add("role", "sam", "viewer", "reports");

    expect(db.query("adminOf", [null, null])).toEqual([["sam", "billing"]]);
  });

  it("holds a repeated variable to one value", () => {
    const db = new FactDb();
    db.setRules([rule(atom("selfLoop", v("x")), atom("edge", v("x"), v("x")))]);
    db.add("edge", "a", "a");
    db.add("edge", "a", "b");

    expect(db.query("selfLoop", [null])).toEqual([["a"]]);
  });

  it("does not duplicate tuples derived by two routes", () => {
    const db = new FactDb();
    db.setRules([
      rule(atom("path", v("x"), v("y")), atom("edge", v("x"), v("y"))),
      rule(
        atom("path", v("x"), v("z")),
        atom("edge", v("x"), v("y")),
        atom("path", v("y"), v("z")),
      ),
    ]);
    // a→c directly and via b.
    db.add("edge", "a", "b");
    db.add("edge", "b", "c");
    db.add("edge", "a", "c");

    expect(
      db.query("path", ["a", null]).filter((t) => t[1] === "c"),
    ).toHaveLength(1);
  });

  it("keeps derived facts when rules are reset", () => {
    const db = new FactDb();
    const rules = [
      rule(atom("path", v("x"), v("y")), atom("edge", v("x"), v("y"))),
    ];
    db.setRules(rules);
    db.add("edge", "a", "b");
    expect(db.has("path", ["a", "b"])).toBe(true);

    db.setRules([
      ...rules,
      rule(
        atom("path", v("x"), v("z")),
        atom("edge", v("x"), v("y")),
        atom("path", v("y"), v("z")),
      ),
    ]);
    db.add("edge", "b", "c");
    expect(db.has("path", ["a", "c"])).toBe(true);
  });
});
