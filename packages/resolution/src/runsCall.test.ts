// The calls a body runs, over facts written by hand, so what is under test
// is the rule and the order it is read in, not any one language's facts.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { RESOLUTION_QUESTIONS, RESOLUTION_RULES } from "./index.js";
import { callsRun } from "./runsCall.js";

type Fact = [string, ...string[]];

function load(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

/**
 * `function load() { fetch(); items.map(x => save(x)); function helper() { log(); } }`,
 * with each node keyed by its span in a file `f`.
 */
const LOAD: readonly Fact[] = [
  ["func", "f:0-100"],
  ["makesCall", "f:0-100", "f:10-17"],
  ["makesCall", "f:0-100", "f:20-50"],
  ["containsFn", "f:0-100", "f:30-49"],
  ["inlineFn", "f:30-49"],
  ["makesCall", "f:30-49", "f:36-43"],
  ["containsFn", "f:0-100", "f:55-95"],
  ["makesCall", "f:55-95", "f:80-85"],
];

describe("callsRun", () => {
  it("lists a function's own calls and those of the functions written inline in it", () => {
    const calls = callsRun(load(LOAD), ["f:0-100"]);
    expect(calls.get("f:0-100")).toEqual(["f:10-17", "f:20-50", "f:36-43"]);
  });

  it("leaves out the calls of a nested function that is not inline", () => {
    const calls = callsRun(load(LOAD), ["f:0-100"]);
    expect(calls.get("f:0-100")).not.toContain("f:80-85");
  });

  it("follows inline functions written inside inline functions", () => {
    const calls = callsRun(
      load([
        ...LOAD,
        ["containsFn", "f:30-49", "f:38-42"],
        ["inlineFn", "f:38-42"],
        ["makesCall", "f:38-42", "f:39-41"],
      ]),
      ["f:0-100"],
    );
    expect(calls.get("f:0-100")).toEqual([
      "f:10-17",
      "f:20-50",
      "f:36-43",
      "f:39-41",
    ]);
  });

  it("puts a call before the calls written inside it that start where it does", () => {
    const calls = callsRun(
      load([
        ["makesCall", "g", "f:5-9"],
        ["makesCall", "g", "f:5-30"],
        ["makesCall", "g", "f:2-4"],
      ]),
      ["g"],
    );
    expect(calls.get("g")).toEqual(["f:2-4", "f:5-30", "f:5-9"]);
  });

  it("answers each function asked about in one batch", () => {
    const calls = callsRun(load(LOAD), ["f:0-100", "f:55-95", "f:30-49"]);
    expect(calls.get("f:55-95")).toEqual(["f:80-85"]);
    expect(calls.get("f:30-49")).toEqual(["f:36-43"]);
  });

  it("gives an empty list for a function that makes no calls", () => {
    const calls = callsRun(load([["func", "h"]]), ["h"]);
    expect(calls.get("h")).toEqual([]);
  });

  it("puts a call keyed by something other than a span after the ones that are", () => {
    const calls = callsRun(
      load([
        ["makesCall", "g", "decorated"],
        ["makesCall", "g", "f:5-9"],
        ["makesCall", "g", "applied"],
      ]),
      ["g"],
    );
    expect(calls.get("g")).toEqual(["f:5-9", "applied", "decorated"]);
  });

  it("asks nothing when no function is given", () => {
    expect(callsRun(load(LOAD), []).size).toBe(0);
  });
});

describe("callBlock", () => {
  // Ruby states which block a call is written with, and DESIGN.md says no
  // rule reads it. A rule that starts to read it changes that line.
  it("is read by no rule yet", () => {
    const read = [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS].flatMap(
      (rule) => rule.body.map((literal) => literal.relation),
    );
    expect(read).not.toContain("callBlock");
  });
});
