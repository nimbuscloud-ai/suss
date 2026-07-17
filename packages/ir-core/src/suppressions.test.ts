import { describe, expect, it } from "vitest";

import {
  applySuppressionsToFindings,
  countsForThreshold,
  normalizeRuleBoundary,
  ruleBoundaryMatchesKey,
  type SuppressibleFinding,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "./index.js";

function rule(partial: Partial<SuppressionRule>): SuppressionRule {
  return SuppressionRuleSchema.parse({ reason: "test", ...partial });
}

interface TestFinding extends SuppressibleFinding {
  boundary: string;
}

function finding(partial: Partial<TestFinding> = {}): TestFinding {
  return {
    kind: "uncoveredOutcome",
    severity: "error",
    boundary: "GET /users/{id}",
    ...partial,
  };
}

/** Matcher used by tests: boundary key equality only. */
function byBoundary(r: SuppressionRule, f: TestFinding): boolean {
  return (
    r.boundary === undefined || ruleBoundaryMatchesKey(r.boundary, f.boundary)
  );
}

describe("validateRule", () => {
  it("accepts narrow rules with kind + boundary", () => {
    expect(validateRule(rule({ kind: "x", boundary: "GET /a" }))).toBeNull();
  });

  it("accepts narrow rules with kind + consumer.transitionId", () => {
    expect(
      validateRule(rule({ kind: "x", consumer: { transitionId: "t1" } })),
    ).toBeNull();
  });

  it("rejects narrow rules missing a second discriminator", () => {
    expect(validateRule(rule({ kind: "x" }))).toMatch(/narrow-scope/);
    expect(validateRule(rule({ boundary: "GET /a" }))).toMatch(/narrow-scope/);
  });

  it("broad rules need at least one field", () => {
    expect(validateRule(rule({ scope: "broad" }))).toMatch(/broad-scope/);
    expect(validateRule(rule({ scope: "broad", kind: "x" }))).toBeNull();
  });
});

describe("normalizeRuleBoundary / ruleBoundaryMatchesKey", () => {
  it("normalizes REST keys across param syntax and case", () => {
    expect(normalizeRuleBoundary("get /Users/:id/")).toBe("GET /users/{id}");
    expect(ruleBoundaryMatchesKey("GET /users/:id", "GET /users/{id}")).toBe(
      true,
    );
  });

  it("matches non-REST keys verbatim without mangling case", () => {
    expect(normalizeRuleBoundary("fn:@acme/api::getUser")).toBe(
      "fn:@acme/api::getUser",
    );
    expect(
      ruleBoundaryMatchesKey("fn:@acme/api::getUser", "fn:@acme/api::getUser"),
    ).toBe(true);
    expect(ruleBoundaryMatchesKey("fn:@acme/api::getUser", null)).toBe(false);
    expect(ruleBoundaryMatchesKey("fn:@acme/api::getUser", "GET /a")).toBe(
      false,
    );
  });
});

describe("applySuppressionsToFindings", () => {
  it("returns findings untouched when no rule matches", () => {
    const f = finding();
    const out = applySuppressionsToFindings(
      [f],
      [rule({ kind: "otherKind", boundary: "GET /users/{id}" })],
      byBoundary,
    );
    expect(out).toEqual([f]);
  });

  it("marks a matched finding, first rule wins", () => {
    const out = applySuppressionsToFindings(
      [finding()],
      [
        rule({
          kind: "uncoveredOutcome",
          boundary: "GET /users/:id",
          reason: "first",
        }),
        rule({
          kind: "uncoveredOutcome",
          boundary: "GET /users/:id",
          reason: "second",
          effect: "hide",
        }),
      ],
      byBoundary,
    );
    expect(out).toHaveLength(1);
    expect(out[0].suppressed).toEqual({ reason: "first", effect: "mark" });
  });

  it("downgrades severity one level and preserves the original", () => {
    const out = applySuppressionsToFindings(
      [finding({ severity: "error" }), finding({ severity: "info" })],
      [
        rule({
          kind: "uncoveredOutcome",
          boundary: "GET /users/{id}",
          effect: "downgrade",
        }),
      ],
      byBoundary,
    );
    expect(out[0].severity).toBe("warning");
    expect(out[0].suppressed?.originalSeverity).toBe("error");
    expect(out[1].severity).toBe("info");
  });

  it("hides matched findings unless keepHidden is set", () => {
    const rules = [
      rule({
        kind: "uncoveredOutcome",
        boundary: "GET /users/{id}",
        effect: "hide",
      }),
    ];
    expect(
      applySuppressionsToFindings([finding()], rules, byBoundary),
    ).toHaveLength(0);
    const kept = applySuppressionsToFindings([finding()], rules, byBoundary, {
      keepHidden: true,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0].suppressed?.effect).toBe("hide");
  });
});

describe("countsForThreshold", () => {
  it("counts unsuppressed and downgraded findings, not mark/hide", () => {
    expect(countsForThreshold(finding())).toBe(true);
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: { reason: "r", effect: "downgrade" },
      }),
    ).toBe(true);
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: { reason: "r", effect: "mark" },
      }),
    ).toBe(false);
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: { reason: "r", effect: "hide" },
      }),
    ).toBe(false);
  });
});
