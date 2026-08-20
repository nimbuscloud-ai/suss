// The resolution rules under the witness algebra: run them over a
// small fact base, reconstruct the proof of one answer, and check the
// chain lists the rules and facts a person would expect.

import { describe, expect, it } from "vitest";

import {
  Database,
  evaluate,
  proofOf,
  ruleLabel,
  witnesses,
} from "@suss/datalog";

import { RESOLUTION_RULES } from "./index.js";

import type { Proof } from "@suss/datalog";

/** Every leaf fact in the tree, written as `relation(a, b)`. */
function leavesOf(proof: Proof): string[] {
  if (proof.kind === "fact") {
    return [`${proof.relation}(${proof.tuple.join(", ")})`];
  }
  if (proof.kind !== "derived") {
    return [];
  }
  return proof.premises.flatMap(leavesOf);
}

/** The label of every rule fired anywhere in the tree. */
function rulesOf(proof: Proof): string[] {
  if (proof.kind !== "derived") {
    return [];
  }
  return [ruleLabel(proof.rule), ...proof.premises.flatMap(rulesOf)];
}

describe("a comesTo answer explains itself", () => {
  // const x = h, where h is `handler` imported from lib, and lib
  // exports the function handlerFn under that name.
  const facts: Array<[string, ...string[]]> = [
    ["func", "handlerFn"],
    ["exportsAs", "lib", "handler", "handlerFn"],
    ["imports", "h", "lib", "handler"],
    ["binds", "x", "h"],
  ];

  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  evaluate(db, RESOLUTION_RULES, witnesses);

  it("still gives the answer", () => {
    expect(db.has("comesTo", ["x", "handlerFn"])).toBe(true);
  });

  it("proves the answer from the facts the adapter stated", () => {
    const proof = proofOf(db, "comesTo", ["x", "handlerFn"]);
    expect(proof.kind).toBe("derived");
    expect(leavesOf(proof).sort()).toEqual([
      "binds(x, h)",
      "exportsAs(lib, handler, handlerFn)",
      "func(handlerFn)",
      "imports(h, lib, handler)",
    ]);
  });

  it("fires the rules a person would expect along the chain", () => {
    const proof = proofOf(db, "comesTo", ["x", "handlerFn"]);
    const fired = rulesOf(proof);
    expect(fired[0]).toBe("comesTo :- reaches, func");
    expect(fired).toContain("stepsTo :- binds");
    expect(fired).toContain("stepsTo :- imports, moduleExport");
    expect(fired).toContain("moduleExport :- exportsAs");
  });
});
