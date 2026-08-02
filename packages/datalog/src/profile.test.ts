import { describe, expect, it } from "vitest";

import {
  Database,
  evaluate,
  formatProfile,
  lit,
  profileEvaluation,
  profileEvaluationAsync,
  rule,
  variable as v,
} from "./index.js";

/** Transitive closure over a path graph, the shape resolution rules take. */
const REACHES = [
  rule("reaches", [v("a"), v("b")], [lit("edge", v("a"), v("b"))]),
  rule(
    "reaches",
    [v("a"), v("c")],
    [lit("edge", v("a"), v("b")), lit("reaches", v("b"), v("c"))],
  ),
];

function chain(length: number): Database {
  const db = new Database();
  for (let i = 0; i < length; i++) {
    db.add("edge", [`n${i}`, `n${i + 1}`]);
  }
  return db;
}

describe("evaluation profiling", () => {
  it("charges every rule that ran and counts the tuples it won", () => {
    const db = chain(5);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    const heads = profile.rules.map((r) => r.head);
    expect(new Set(heads)).toEqual(new Set(["reaches"]));

    const derived = profile.rules.reduce((sum, r) => sum + r.derived, 0);
    // Every pair i < j in a 6-node chain is reachable: 5+4+3+2+1.
    expect(derived).toBe(15);
    expect(db.size("reaches")).toBe(15);
  });

  it("names the body relations so a rule is recognisable in a report", () => {
    const db = chain(3);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    const recursive = profile.rules.find((r) => r.body.length === 2);
    expect(recursive?.body).toEqual(["edge", "reaches"]);
  });

  it("reports the final size of every relation, base facts included", () => {
    const db = chain(4);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    const sizes = new Map(profile.relations.map((r) => [r.relation, r.tuples]));
    expect(sizes.get("edge")).toBe(4);
    expect(sizes.get("reaches")).toBe(10);
  });

  it("counts more rounds for a longer chain, since fixpoint takes longer", () => {
    const shortRun = profileEvaluation(() => evaluate(chain(3), REACHES));
    const longRun = profileEvaluation(() => evaluate(chain(12), REACHES));

    expect(longRun.profile.rounds).toBeGreaterThan(shortRun.profile.rounds);
  });

  it("counts one evaluation per call, so re-derivation is visible", () => {
    const db = chain(4);
    const { profile } = profileEvaluation(() => {
      evaluate(db, REACHES);
      db.add("edge", ["n4", "n5"]);
      evaluate(db, REACHES);
      db.add("edge", ["n5", "n6"]);
      evaluate(db, REACHES);
    });

    expect(profile.evaluations).toBe(3);
  });

  it("hands back what the profiled function returned", () => {
    const db = chain(2);
    const { result } = profileEvaluation(() => evaluate(db, REACHES));

    expect(result).toBe(db);
  });

  it("separates engine time from the wall time of the whole scope", () => {
    const db = chain(3);
    const { profile } = profileEvaluation(() => {
      const out = evaluate(db, REACHES);
      const spinUntil = performance.now() + 20;
      while (performance.now() < spinUntil) {
        // Work outside the engine, which wall time counts and datalog does not.
      }
      return out;
    });

    expect(profile.wallMs).toBeGreaterThan(profile.datalogMs);
  });

  it("folds a nested profiled scope into the outer one", () => {
    const db = chain(4);
    const outer = profileEvaluation(() => {
      const inner = profileEvaluation(() => evaluate(db, REACHES));
      return inner.profile.rounds;
    });

    expect(outer.profile.rules.length).toBeGreaterThan(0);
  });

  it("profiles an async scope", async () => {
    const db = chain(4);
    const { profile } = await profileEvaluationAsync(async () => {
      await Promise.resolve();
      return evaluate(db, REACHES);
    });

    expect(profile.rules.length).toBeGreaterThan(0);
    expect(profile.rounds).toBeGreaterThan(0);
  });

  it("stops collecting once the scope ends", () => {
    const first = chain(3);
    const { profile } = profileEvaluation(() => evaluate(first, REACHES));
    const rulesDuringScope = profile.rules.length;

    // An unprofiled evaluation afterwards must not appear anywhere.
    evaluate(chain(9), REACHES);
    expect(profile.rules.length).toBe(rulesDuringScope);
  });

  it("derives the same facts whether or not anybody is watching", () => {
    const watched = chain(6);
    profileEvaluation(() => evaluate(watched, REACHES));
    const unwatched = chain(6);
    evaluate(unwatched, REACHES);

    expect(watched.size("reaches")).toBe(unwatched.size("reaches"));
    for (const tuple of unwatched.facts("reaches")) {
      expect(watched.has("reaches", tuple)).toBe(true);
    }
  });

  it("marks derived relations apart from the base facts a caller added", () => {
    const db = chain(4);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    const marked = new Map(
      profile.relations.map((r) => [r.relation, r.derived]),
    );
    expect(marked.get("reaches")).toBe(true);
    expect(marked.get("edge")).toBe(false);
  });

  it("splits time by rule set when a run evaluates more than one", () => {
    const db = chain(5);
    // A second rule set over the same database, deriving its own relation.
    const ENDS = [rule("ends", [v("b")], [lit("edge", v("a"), v("b"))])];
    const { profile } = profileEvaluation(() => {
      evaluate(db, REACHES);
      evaluate(db, ENDS);
    });

    const names = profile.ruleSets.map((s) => s.derives.join(", "));
    expect(new Set(names)).toEqual(new Set(["reaches", "ends"]));

    const summed = profile.ruleSets.reduce((total, s) => total + s.ms, 0);
    expect(summed).toBeCloseTo(profile.datalogMs, 5);

    const reaches = profile.ruleSets.find((s) => s.derives[0] === "reaches");
    expect(reaches?.evaluations).toBe(1);
    expect(reaches?.rules.every((r) => r.head === "reaches")).toBe(true);

    const rendered = formatProfile(profile);
    expect(rendered).toContain("by rule set:");
    expect(rendered).toContain("ends");
  });

  it("leaves the rule-set breakdown out when only one rule set ran", () => {
    const db = chain(4);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    expect(formatProfile(profile)).not.toContain("by rule set:");
  });

  it("reports each rule's share of engine time so nobody divides by hand", () => {
    const db = chain(6);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    expect(formatProfile(profile)).toMatch(/\d+\.\d%/);
  });

  it("renders a report naming the busiest relation and rule", () => {
    const db = chain(5);
    const { profile } = profileEvaluation(() => evaluate(db, REACHES));

    const rendered = formatProfile(profile);
    expect(rendered).toContain("reaches");
    expect(rendered).toContain("rounds");
  });
});
