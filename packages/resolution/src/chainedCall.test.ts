import { describe, expect, it } from "vitest";

import { Database, evaluate } from "@suss/datalog";

import { RESOLUTION_QUESTIONS, RESOLUTION_RULES } from "./index.js";

/**
 * `db.update(t).set(v).where(c)`, keyed the way every adapter keys a
 * method call: the call, and a callee that reads the method off the
 * receiver's key.
 */
const UPDATE_CHAIN: Array<[string, ...string[]]> = [
  ["call", "update()", "db.update"],
  ["readsProperty", "db.update", "db", "update"],
  ["call", "set()", "update().set"],
  ["readsProperty", "update().set", "update()", "set"],
  ["call", "where()", "set().where"],
  ["readsProperty", "set().where", "set()", "where"],
];

function chainedFrom(
  facts: Array<[string, ...string[]]>,
  start: string,
): string[][] {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return evaluate(db, RESOLUTION_RULES)
    .facts("chainedCall")
    .filter((row) => row[0] === start)
    .map((row) => row.slice(1).map(String))
    .sort();
}

describe("chainedCall", () => {
  it("reaches every call further out along a chain, with its method", () => {
    expect(chainedFrom(UPDATE_CHAIN, "update()")).toEqual([
      ["set()", "set"],
      ["where()", "where"],
    ]);
    expect(chainedFrom(UPDATE_CHAIN, "set()")).toEqual([["where()", "where"]]);
  });

  it("starts only at a call, so a method called on a name is no chain", () => {
    expect(chainedFrom(UPDATE_CHAIN, "db")).toEqual([]);
  });

  it("is read by no rule but its own yet, and compares by none", () => {
    const readers = [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS].filter(
      (one) =>
        one.head.relation !== "chainedCall" &&
        one.body.some(
          (literal) =>
            literal.relation === "chainedCall" ||
            literal.relation === "compares",
        ),
    );
    expect(readers).toEqual([]);
  });
});
