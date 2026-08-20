import { describe, expect, it } from "vitest";

import {
  Database,
  evaluate,
  lit,
  notLit,
  proofOf,
  rule,
  ruleLabel,
  variable,
  Witness,
  witnesses,
} from "./index.js";

import type { Proof } from "./index.js";

const V = variable;

const pathRules = [
  rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
  rule(
    "path",
    [V("x"), V("z")],
    [lit("path", V("x"), V("y")), lit("edge", V("y"), V("z"))],
  ),
];

const derived = (proof: Proof): proof is Proof & { kind: "derived" } =>
  proof.kind === "derived";

describe("the witnesses algebra", () => {
  it("reconstructs a two-hop chain", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"]);
    evaluate(db, pathRules, witnesses);

    const proof = proofOf(db, "path", ["a", "c"]);
    expect(proof.kind).toBe("derived");
    if (!derived(proof)) {
      return;
    }
    expect(ruleLabel(proof.rule)).toBe("path :- path, edge");
    expect(proof.premises).toHaveLength(2);

    const [inner, hop] = proof.premises;
    expect(hop).toEqual({ kind: "fact", relation: "edge", tuple: ["b", "c"] });
    expect(inner.kind).toBe("derived");
    if (!derived(inner)) {
      return;
    }
    expect(ruleLabel(inner.rule)).toBe("path :- edge");
    expect(inner.premises).toEqual([
      { kind: "fact", relation: "edge", tuple: ["a", "b"] },
    ]);
  });

  it("keeps a join's body facts in rule-body order", () => {
    const db = new Database();
    db.add("owner", ["o1", "alice"]);
    db.add("repo", ["o1", "r1"]);
    evaluate(
      db,
      [
        rule(
          "maintains",
          [V("who"), V("r")],
          [lit("owner", V("o"), V("who")), lit("repo", V("o"), V("r"))],
        ),
      ],
      witnesses,
    );

    const proof = proofOf(db, "maintains", ["alice", "r1"]);
    expect(derived(proof) && proof.premises).toEqual([
      { kind: "fact", relation: "owner", tuple: ["o1", "alice"] },
      { kind: "fact", relation: "repo", tuple: ["o1", "r1"] },
    ]);
  });

  it("records which grounded tuple a negated literal was missing", () => {
    const db = new Database();
    db.add("request", ["x"]);
    db.add("request", ["y"]);
    db.add("handles", ["y"]);
    evaluate(
      db,
      [
        rule(
          "unhandled",
          [V("r")],
          [lit("request", V("r")), notLit("handles", V("r"))],
        ),
      ],
      witnesses,
    );

    expect(db.has("unhandled", ["y"])).toBe(false);
    const proof = proofOf(db, "unhandled", ["x"]);
    expect(derived(proof) && proof.premises).toEqual([
      { kind: "fact", relation: "request", tuple: ["x"] },
      { kind: "absence", relation: "handles", tuple: ["x"] },
    ]);
  });

  it("leaves an asserted fact as a leaf, even when a rule re-derives it", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    // The caller already asserted the conclusion. First-wins keeps the
    // assertion, so the proof is the fact itself, not the derivation.
    db.add("path", ["a", "b"]);
    evaluate(db, pathRules, witnesses);

    expect(db.tagOf("path", ["a", "b"])).toBeUndefined();
    expect(proofOf(db, "path", ["a", "b"])).toEqual({
      kind: "fact",
      relation: "path",
      tuple: ["a", "b"],
    });
  });

  it("keeps the first witness when a second derivation arrives", () => {
    const db = new Database();
    db.add("cheap", ["x"]);
    db.add("dear", ["x"]);
    const first = rule("p", [V("x")], [lit("cheap", V("x"))], "the cheap way");
    const second = rule("p", [V("x")], [lit("dear", V("x"))], "the dear way");
    evaluate(db, [first, second], witnesses);

    const proof = proofOf(db, "p", ["x"]);
    expect(derived(proof) && proof.rule).toBe(first);
    expect(derived(proof) && ruleLabel(proof.rule)).toBe("the cheap way");
  });

  it("truncates at the depth cap", () => {
    const db = new Database();
    for (let hop = 0; hop < 6; hop += 1) {
      db.add("edge", [`n${hop}`, `n${hop + 1}`]);
    }
    evaluate(db, pathRules, witnesses);

    const proof = proofOf(db, "path", ["n0", "n6"], { maxDepth: 2 });
    expect(derived(proof)).toBe(true);
    const bottom = derived(proof) && proof.premises[0];
    expect(bottom && derived(bottom) && bottom.premises[0]).toMatchObject({
      kind: "truncated",
      reason: "depth",
    });
  });

  it("stops on a hand-built witness cycle instead of recursing forever", () => {
    const db = new Database();
    const r = rule("p", [V("x")], [lit("p", V("x"))]);
    db.add(
      "p",
      ["a"],
      new Witness(r, [{ kind: "fact", relation: "p", tuple: ["a"] }]),
    );

    const proof = proofOf(db, "p", ["a"]);
    expect(derived(proof) && proof.premises[0]).toEqual({
      kind: "truncated",
      relation: "p",
      tuple: ["a"],
      reason: "cycle",
    });
  });

  it("answers absence for a fact that was never derived", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    evaluate(db, pathRules, witnesses);

    expect(proofOf(db, "path", ["b", "a"])).toEqual({
      kind: "absence",
      relation: "path",
      tuple: ["b", "a"],
    });
  });

  it("leaves a fact derived without the algebra as a leaf", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    evaluate(db, pathRules);

    expect(proofOf(db, "path", ["a", "b"])).toEqual({
      kind: "fact",
      relation: "path",
      tuple: ["a", "b"],
    });
  });
});
