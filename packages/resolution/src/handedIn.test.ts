import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { stateHandedIn } from "./handedIn.js";

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
