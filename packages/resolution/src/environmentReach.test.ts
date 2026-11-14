import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { environmentsReaching } from "./environmentReach.js";
import { stateCallsOutsideTests } from "./handWrittenFacts.js";
import { resolutionProgram } from "./index.js";

/**
 * The facts for, in Python:
 *
 *   def load(source): ...
 *   load(os.environ)
 *   def from_default(fallback=os.environ): ...
 *   def other(settings): ...
 */
const FACTS: Array<[string, ...string[]]> = [
  ["environmentObject", "environ"],
  ["func", "load"],
  ["paramOf", "load", "0", "source"],
  ["binds", "loadRef", "load"],
  ["call", "passes", "loadRef"],
  ["callArg", "passes", "0", "environ"],
  ["func", "fromDefault"],
  ["paramOf", "fromDefault", "0", "fallback"],
  ["paramDefault", "fallback", "environ"],
  ["func", "other"],
  ["paramOf", "other", "0", "settings"],
];

function reached(keys: readonly string[]): string[][] {
  const db = new Database();
  for (const [name, ...tuple] of FACTS) {
    db.add(name, tuple);
  }
  stateCallsOutsideTests(db);
  return keys.map((key) => environmentsReaching(db, key, resolutionProgram()));
}

describe("environmentsReaching", () => {
  it("follows the environment into a parameter a caller passes it to, and one that defaults to it", () => {
    expect(reached(["environ", "source", "fallback", "settings"])).toEqual([
      ["environ"],
      ["environ"],
      ["environ"],
      [],
    ]);
  });

  it("asks nothing in a run that states no environment object", () => {
    const db = new Database();
    expect(environmentsReaching(db, "source", resolutionProgram())).toEqual([]);
    expect(db.facts("wanted")).toEqual([]);
  });
});
