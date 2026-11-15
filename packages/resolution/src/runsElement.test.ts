// The elements a body renders, over facts written by hand, so what is
// under test is the rule and the order it is read in.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { askResolution, resolutionProgram } from "./program.js";
import { ELEMENTS_RUN_QUESTION, readElementsRun } from "./runsElement.js";

type Fact = [string, ...string[]];

/**
 * `function Panel() { return <ul>{items.map(x => <li/>)}</ul>; function footer() { return <footer/>; } }`,
 * with each node keyed by its span in a file `f`.
 */
const PANEL: readonly Fact[] = [
  ["func", "f:0-100"],
  ["rendersElement", "f:0-100", "f:20-60"],
  ["containsFn", "f:0-100", "f:30-50"],
  ["inlineFn", "f:30-50"],
  ["rendersElement", "f:30-50", "f:40-48"],
  ["containsFn", "f:0-100", "f:65-95"],
  ["rendersElement", "f:65-95", "f:80-90"],
];

function elementsOf(facts: readonly Fact[], fn: string): string[] {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  askResolution(db, [fn], ELEMENTS_RUN_QUESTION, resolutionProgram());
  return readElementsRun(db, fn);
}

describe("the elements a function renders", () => {
  it("lists its own and those of the functions it runs inline, in source order", () => {
    expect(elementsOf(PANEL, "f:0-100")).toEqual(["f:20-60", "f:40-48"]);
  });

  it("leaves a nested declaration's elements to that declaration", () => {
    expect(elementsOf(PANEL, "f:65-95")).toEqual(["f:80-90"]);
  });
});
