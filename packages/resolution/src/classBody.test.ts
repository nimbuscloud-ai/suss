// The calls a class body makes, over facts written by hand, so what is
// under test is the rule and the order it is read in, not any one
// language's facts.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { classBodyCalls } from "./index.js";

type Fact = [string, ...string[]];

function load(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

/**
 * ```ruby
 * class Account
 *   has_many :items
 *   with_options dependent: :destroy do
 *     has_one :owner
 *   end
 *   def save; touch; end
 *   after_commit do notify end
 * end
 * ```
 * with each node keyed by its span in a file `f`.
 */
const ACCOUNT: readonly Fact[] = [
  ["objectValue", "f:0-200"],
  ["bodyCallAt", "f:0-200", "0", "f:20-35"],
  ["bodyCallAt", "f:0-200", "1", "f:40-110"],
  ["callBlock", "f:40-110", "f:70-110"],
  ["runsBlockInPlace", "f:40-110"],
  ["bodyCallAt", "f:70-110", "0", "f:80-95"],
  ["func", "f:120-190"],
  ["bodyCallAt", "f:120-190", "0", "f:150-155"],
  ["bodyCallAt", "f:0-200", "2", "f:191-199"],
  ["callBlock", "f:191-199", "f:195-199"],
  ["bodyCallAt", "f:195-199", "0", "f:196-198"],
];

describe("classBodyCalls", () => {
  it("lists the body's statements and those of a block its call runs in place, in source order", () => {
    const calls = classBodyCalls(load(ACCOUNT), ["f:0-200"]);
    expect(calls.get("f:0-200")).toEqual([
      "f:20-35",
      "f:40-110",
      "f:80-95",
      "f:191-199",
    ]);
  });

  it("leaves out the calls of a method the body defines", () => {
    const calls = classBodyCalls(load(ACCOUNT), ["f:0-200"]);
    expect(calls.get("f:0-200")).not.toContain("f:150-155");
  });

  it("leaves out the calls of a block that runs later, though its call is the body's", () => {
    const calls = classBodyCalls(load(ACCOUNT), ["f:0-200"]);
    expect(calls.get("f:0-200")).toContain("f:191-199");
    expect(calls.get("f:0-200")).not.toContain("f:196-198");
  });

  it("follows a block written inside a block, when each call runs its block in place", () => {
    const nested: readonly Fact[] = [
      ...ACCOUNT,
      ["bodyCallAt", "f:70-110", "1", "f:96-108"],
      ["callBlock", "f:96-108", "f:100-108"],
      ["bodyCallAt", "f:100-108", "0", "f:101-107"],
    ];
    expect(classBodyCalls(load(nested), ["f:0-200"]).get("f:0-200")).toEqual([
      "f:20-35",
      "f:40-110",
      "f:80-95",
      "f:96-108",
      "f:191-199",
    ]);
    const calls = classBodyCalls(
      load([...nested, ["runsBlockInPlace", "f:96-108"]]),
      ["f:0-200"],
    );
    expect(calls.get("f:0-200")).toEqual([
      "f:20-35",
      "f:40-110",
      "f:80-95",
      "f:96-108",
      "f:101-107",
      "f:191-199",
    ]);
  });

  it("lists nothing for a function's body, which is not a class", () => {
    const calls = classBodyCalls(load(ACCOUNT), ["f:120-190"]);
    expect(calls.get("f:120-190")).toEqual([]);
  });
});
