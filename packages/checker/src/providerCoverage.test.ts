import { describe, expect, it } from "vitest";

import {
  consumer,
  opaqueResponse,
  provider,
  response,
  statusEq,
  transition,
} from "./__fixtures__/pairs.js";
import { checkProviderCoverage } from "./providerCoverage.js";

import type { Predicate } from "@suss/behavioral-ir";

describe("checkProviderCoverage", () => {
  it("reports no findings when consumer explicitly handles every provider status", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("emits unhandledProviderCase when consumer has no default and misses a provider status", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-410", { output: response(410) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unhandledProviderCase");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].description).toContain("410");
    expect(findings[0].provider.transitionId).toBe("t-410");
  });

  it("treats a consumer default branch as covering 2xx statuses", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("does NOT treat a consumer default as covering non-2xx statuses", () => {
    const p = provider("getUser", [
      transition("t-500", { output: response(500) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("500");
  });

  it("emits a lowConfidence finding for opaque provider statuses", () => {
    const p = provider("getUser", [
      transition("t-dyn", { output: opaqueResponse() }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("lowConfidence");
    expect(findings[0].severity).toBe("info");
  });

  it("counts throw-converted-to-response as a produced status code", () => {
    // When the extractor converts a throw-with-status to a response output
    // (e.g., `throw new HttpError(404)` → response 404), the checker
    // treats it like any other response.
    const p = provider("getUser", [
      transition("t-404", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: {
              type: "dependency",
              name: "db.findById",
              accessChain: [],
            },
            negated: true,
          },
        ],
        // Extractor already converted throw-with-status to response
        output: response(404),
      }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("uses the provider's boundary binding on findings", () => {
    const p = provider(
      "getUser",
      [transition("t-418", { output: response(418) })],
      { framework: "ts-rest" },
    );
    const c = consumer("UserPage", [
      transition("ct", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings[0].boundary.recognition).toBe("ts-rest");
  });
});

// ---------------------------------------------------------------------------
// Sub-case analysis: multiple provider transitions for same status
// ---------------------------------------------------------------------------

describe("checkProviderCoverage — sub-case analysis", () => {
  // Predicates that are NOT status checks (server-side conditions)
  const userNull: Predicate = {
    type: "truthinessCheck",
    subject: { type: "dependency", name: "db.findById", accessChain: [] },
    negated: true,
  };
  const userDeleted: Predicate = {
    type: "truthinessCheck",
    subject: {
      type: "derived",
      from: { type: "dependency", name: "db.findById", accessChain: [] },
      derivation: { type: "propertyAccess", property: "deletedAt" },
    },
    negated: false,
  };

  it("emits warnings when provider has multiple 200 transitions but consumer only has one branch", () => {
    // Provider: returns 200 in two cases — active user (default) and deleted user
    const p = provider("getUser", [
      transition("t-200-deleted", {
        conditions: [userDeleted],
        output: response(200),
      }),
      transition("t-200-default", {
        output: response(200),
        isDefault: true,
      }),
    ]);
    // Consumer: handles 200 with no sub-case distinction
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkProviderCoverage(p, c);
    // Should warn about the conditional 200 (deleted user) that consumer ignores
    const subcaseFindings = findings.filter((f) =>
      f.description.includes("distinct cases"),
    );
    expect(subcaseFindings).toHaveLength(1);
    expect(subcaseFindings[0].severity).toBe("warning");
    expect(subcaseFindings[0].provider.transitionId).toBe("t-200-deleted");
    expect(subcaseFindings[0].description).toContain("2 distinct cases");
  });

  it("does not emit sub-case warnings when provider has only one transition per status", () => {
    const p = provider("getUser", [
      transition("t-404", { conditions: [userNull], output: response(404) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkProviderCoverage(p, c);
    expect(
      findings.filter((f) => f.description.includes("distinct cases")),
    ).toHaveLength(0);
  });

  it("does not emit sub-case warnings when the provider default is the only 200", () => {
    const p = provider("simple", [
      transition("t-200", {
        output: response(200),
        isDefault: true,
      }),
    ]);
    const c = consumer("Client", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    expect(
      checkProviderCoverage(p, c).filter((f) =>
        f.description.includes("distinct cases"),
      ),
    ).toHaveLength(0);
  });

  it("emits warnings for each conditional sub-case beyond the default", () => {
    // Provider: 3 ways to return 404
    const p = provider("getUser", [
      transition("t-404-no-id", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: { type: "input", inputRef: "params", path: ["id"] },
            negated: true,
          },
        ],
        output: response(404),
      }),
      transition("t-404-not-found", {
        conditions: [userNull],
        output: response(404),
      }),
      transition("t-404-deleted", {
        conditions: [userDeleted],
        output: response(404),
      }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkProviderCoverage(p, c);
    const subcaseFindings = findings.filter((f) =>
      f.description.includes("distinct cases"),
    );
    // All three 404 transitions have conditions, consumer doesn't distinguish
    expect(subcaseFindings).toHaveLength(3);
    expect(subcaseFindings[0].description).toContain("3 distinct cases");
    expect(subcaseFindings[0].description).toContain("status 404");
  });
});
