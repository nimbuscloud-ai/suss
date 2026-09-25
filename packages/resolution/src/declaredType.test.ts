import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { declaredTypesOf } from "./declaredType.js";

/**
 * A helper `lookup` taking `db` by name and by position, with one call
 * per caller given here. Each caller is a function whose own `db`
 * parameter is what it passes on, unless `passes` says otherwise.
 */
function project(
  callers: {
    name: string;
    states?: string;
    passes?: string;
    byPosition?: boolean;
  }[],
): Database {
  const db = new Database();
  db.add("func", ["lookup"]);
  db.add("paramOf", ["lookup", "0", "lookup#db"]);
  db.add("paramNamed", ["lookup", "db", "lookup#db"]);
  for (const caller of callers) {
    const param = `${caller.name}#db`;
    db.add("func", [caller.name]);
    db.add("paramOf", [caller.name, "0", param]);
    db.add("paramNamed", [caller.name, "db", param]);
    if (caller.states !== undefined) {
      db.add("instanceOf", [param, caller.states]);
    }
    const call = `${caller.name}:call`;
    const callee = `${caller.name}:callee`;
    db.add("call", [call, callee]);
    db.add("binds", [callee, "lookup"]);
    const argument = caller.passes ?? param;
    if (caller.byPosition === true) {
      db.add("callArg", [call, "0", argument]);
      continue;
    }
    db.add("callKeywordArg", [call, "db", argument]);
  }
  return db;
}

describe("the types a value is declared as", () => {
  it("gives a parameter the type its caller states, by name or by position", () => {
    const db = project([
      { name: "view", states: "Session" },
      { name: "job", states: "Session", byPosition: true },
    ]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("lists each type when two callers state different ones", () => {
    const db = project([
      { name: "view", states: "Session" },
      { name: "job", states: "Engine" },
    ]);
    expect(declaredTypesOf(db, "lookup#db").sort()).toEqual([
      "Engine",
      "Session",
    ]);
  });

  it("follows a caller that passes on a parameter its own caller types", () => {
    const db = project([{ name: "middle" }]);
    db.add("func", ["view"]);
    db.add("instanceOf", ["view#session", "Session"]);
    db.add("call", ["view:call", "view:callee"]);
    db.add("binds", ["view:callee", "middle"]);
    db.add("callKeywordArg", ["view:call", "db", "view#session"]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("takes the type of a name declared as a typed one", () => {
    const db = project([{ name: "view", passes: "view#alias" }]);
    db.add("binds", ["view#alias", "view#session"]);
    db.add("instanceOf", ["view#session", "Session"]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("takes the type through a fallback a caller passes", () => {
    const db = project([{ name: "view", passes: "view#either" }]);
    db.add("fallbackBranch", ["view#either", "view#session"]);
    db.add("fallbackBranch", ["view#either", "view:built"]);
    db.add("instanceOf", ["view#session", "Session"]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("takes the type of the value a reassigned name ends holding", () => {
    const db = project([{ name: "view", passes: "view#current" }]);
    db.add("endsHolding", ["view#current", "view#session"]);
    db.add("instanceOf", ["view#session", "Session"]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("gives nothing when one caller passes a value nothing types", () => {
    const db = project([
      { name: "view", states: "Session" },
      { name: "job", passes: "job:built" },
    ]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual([]);
  });

  it("lets a caller passing on an untyped parameter of its own make no claim", () => {
    const db = project([{ name: "view", states: "Session" }, { name: "job" }]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });

  it("gives a parameter its own stated type", () => {
    const db = project([]);
    db.add("instanceOf", ["lookup#db", "Session"]);
    expect(declaredTypesOf(db, "lookup#db")).toEqual(["Session"]);
  });
});
