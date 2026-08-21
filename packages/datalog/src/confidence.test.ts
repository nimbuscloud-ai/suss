import { describe, expect, it } from "vitest";

import { confidence, confidenceWith } from "./confidence.js";
import { Database, evaluate, lit, notLit, rule, variable } from "./index.js";

import type { ConfidenceLevel } from "./confidence.js";

const V = variable;

const pathRules = [
  rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
  rule(
    "path",
    [V("x"), V("z")],
    [lit("path", V("x"), V("y")), lit("edge", V("y"), V("z"))],
  ),
];

describe("confidence", () => {
  it("gives a conclusion the level of its weakest premise", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("edge", ["b", "c"], "medium" satisfies ConfidenceLevel);
    evaluate(db, pathRules, confidence);
    expect(db.tagOf("path", ["a", "b"])).toBe("high");
    expect(db.tagOf("path", ["a", "c"])).toBe("medium");
  });

  it("keeps the better level when a fact is derived twice", () => {
    const db = new Database();
    // Two routes to ("a", "c"): through "b" at medium, direct at high.
    db.add("edge", ["a", "b"], "medium" satisfies ConfidenceLevel);
    db.add("edge", ["b", "c"]);
    db.add("edge", ["a", "c"]);
    evaluate(db, pathRules, confidence);
    expect(db.tagOf("path", ["a", "c"])).toBe("high");
  });

  it("leaves a chain of low facts at low, not lower", () => {
    const db = new Database();
    db.add("edge", ["a", "b"], "low" satisfies ConfidenceLevel);
    db.add("edge", ["b", "c"], "low" satisfies ConfidenceLevel);
    db.add("edge", ["c", "d"], "low" satisfies ConfidenceLevel);
    evaluate(db, pathRules, confidence);
    expect(db.tagOf("path", ["a", "d"])).toBe("low");
  });

  it("counts a matched negation as high", () => {
    const db = new Database();
    db.add("node", ["a"], "medium" satisfies ConfidenceLevel);
    db.add("node", ["b"], "medium" satisfies ConfidenceLevel);
    db.add("edge", ["a", "a"]);
    evaluate(
      db,
      [
        rule(
          "lonely",
          [V("n")],
          [lit("node", V("n")), notLit("edge", V("n"), V("n"))],
        ),
      ],
      confidence,
    );
    // The absence contributes high, so the medium premise is the minimum.
    expect(db.tagOf("lonely", ["b"])).toBe("medium");
    expect(db.has("lonely", ["a"])).toBe(false);
  });
});

describe("confidenceWith", () => {
  it("caps a heuristic rule's conclusions at the rule's level", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    const algebra = confidenceWith((r) =>
      r.head.relation === "path" && r.body.length === 1 ? "medium" : undefined,
    );
    evaluate(db, pathRules, algebra);
    expect(db.tagOf("path", ["a", "b"])).toBe("medium");
  });

  it("lets a better route through an exact rule win the merge", () => {
    const db = new Database();
    db.add("edge", ["a", "b"]);
    db.add("guess", ["a", "b"]);
    const rules = [
      rule("path", [V("x"), V("y")], [lit("edge", V("x"), V("y"))]),
      rule("path", [V("x"), V("y")], [lit("guess", V("x"), V("y"))]),
    ];
    const algebra = confidenceWith((r) =>
      r.body[0]?.relation === "guess" ? "low" : undefined,
    );
    evaluate(db, rules, algebra);
    expect(db.tagOf("path", ["a", "b"])).toBe("high");
  });
});
