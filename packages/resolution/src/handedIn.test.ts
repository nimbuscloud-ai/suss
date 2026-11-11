import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { handedNamesReaching, stateHandedIn } from "./handedIn.js";
import { resolutionProgram } from "./index.js";

function withParameters(): Database {
  const db = new Database();
  db.add("paramOf", ["fetch", "0", "request"]);
  db.add("paramOf", ["fetch", "1", "env"]);
  db.add("paramOf", ["other", "1", "settings"]);
  return db;
}

describe("stateHandedIn", () => {
  it("states the fact on the function's parameter at each position, and says when it added one", () => {
    const db = withParameters();
    expect(stateHandedIn(db, "fetch", [{ at: 1, name: "env" }])).toBe(true);
    expect(stateHandedIn(db, "fetch", [{ at: 1, name: "env" }])).toBe(false);
    expect(db.facts("handedIn")).toEqual([["env", "env"]]);
  });

  it("states nothing for a position the function has no parameter at", () => {
    const db = withParameters();
    expect(stateHandedIn(db, "fetch", [{ at: 2, name: "ctx" }])).toBe(false);
    expect(db.facts("handedIn")).toEqual([]);
  });
});

describe("handedNamesReaching", () => {
  // def fetch(request, env): local = env; origin(env)
  // def origin(settings): ...
  // def other(request, env): ...
  const facts: Array<[string, ...string[]]> = [
    ["func", "fetch"],
    ["paramOf", "fetch", "0", "request"],
    ["paramOf", "fetch", "1", "env"],
    ["binds", "local", "env"],
    ["func", "origin"],
    ["paramOf", "origin", "0", "settings"],
    ["binds", "originRef", "origin"],
    ["call", "passes", "originRef"],
    ["callArg", "passes", "0", "env"],
    ["func", "other"],
    ["paramOf", "other", "1", "otherEnv"],
  ];

  function reached(keys: readonly string[]): string[][] {
    const db = new Database();
    for (const [name, ...tuple] of facts) {
      db.add(name, tuple);
    }
    stateHandedIn(db, "fetch", [{ at: 1, name: "env" }]);
    return keys.map((key) => handedNamesReaching(db, key, resolutionProgram()));
  }

  it("follows the parameter into a local and into the parameter of a helper it is passed to", () => {
    expect(reached(["env", "local", "settings", "otherEnv"])).toEqual([
      ["env"],
      ["env"],
      ["env"],
      [],
    ]);
  });

  it("asks nothing in a run that states no handed-in parameter", () => {
    const db = new Database();
    expect(handedNamesReaching(db, "env", resolutionProgram())).toEqual([]);
    expect(db.facts("wantedHandedObject")).toEqual([]);
  });
});
