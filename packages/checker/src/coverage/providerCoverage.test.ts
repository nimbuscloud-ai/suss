import { describe, expect, it } from "vitest";

import {
  bodyFieldTruthy,
  catchEntry,
  consumer,
  followsRedirects,
  negated,
  opaqueResponse,
  provider,
  rangeResponse,
  recordBody,
  response,
  statusEq,
  statusInRange,
  successFlag,
  throwsOnFailure,
  transition,
} from "../__fixtures__/pairs.js";
import { checkProviderCoverage } from "./providerCoverage.js";

import type { Predicate, TypeShape } from "@suss/behavioral-ir";

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
    expect(findings[0].severity).toBe("warning");
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

  it("reads an else arm as covering every status its guard left over", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-500", { output: response(500) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-else", {
        conditions: [negated(statusEq(404))],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("does not read the path past a guard with no else as covering the rest", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
      transition("ct-fallthrough", {
        conditions: [negated(statusEq(200))],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("404");
  });

  it("counts a guard on a field only the failing body returns", () => {
    const p = provider("banLink", [
      transition("t-404", { output: response(404, recordBody("error")) }),
      transition("t-200", {
        output: response(200, recordBody("link")),
        isDefault: true,
      }),
    ]);
    const c = consumer("BanLink", [
      transition("ct-error", {
        conditions: [bodyFieldTruthy("error")],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("does not count a field both the failing and the succeeding body return", () => {
    const p = provider("banLink", [
      transition("t-404", { output: response(404, recordBody("message")) }),
      transition("t-200", {
        output: response(200, recordBody("message")),
        isDefault: true,
      }),
    ]);
    const c = consumer("BanLink", [
      transition("ct-default", {
        conditions: [bodyFieldTruthy("message")],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("404");
  });

  it("counts a catch when the client throws on a non-2xx", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = throwsOnFailure(
      consumer("UserPage", [
        transition("ct-catch", {
          conditions: [catchEntry()],
          output: { type: "return", value: null },
        }),
        transition("ct-default", {
          output: { type: "return", value: null },
          isDefault: true,
        }),
      ]),
    );
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("does not ask a client that follows redirects to handle one", () => {
    const p = provider("requireLogin", [
      transition("t-301", { output: response(301) }),
      transition("t-302", { output: response(302) }),
      transition("t-304", { output: response(304) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("trackClick", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    // A 304 has nowhere to go next, so even fetch hands it back.
    expect(
      checkProviderCoverage(p, followsRedirects(c)).map((f) => f.description),
    ).toEqual(["Provider produces status 304 but no consumer branch handles it"]);
    expect(checkProviderCoverage(p, c)).toHaveLength(3);
  });

  it("does not count a catch when the client returns the failing response", () => {
    const p = provider("getUser", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-catch", {
        conditions: [catchEntry()],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("404");
  });

  it("still reports a consumer that reads nothing off the response", () => {
    const p = provider("banLink", [
      transition("t-404", { output: response(404, recordBody("error")) }),
      transition("t-200", {
        output: response(200, recordBody("link")),
        isDefault: true,
      }),
    ]);
    const c = consumer("handleBanLink", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("404");
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
    // Provider: returns 200 in two cases, active user (default) and deleted user
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
    const subcaseFindings = findings.filter(
      (f) => f.kind === "unhandledProviderCase" && f.severity === "warning",
    );
    expect(subcaseFindings).toHaveLength(1);
    expect(subcaseFindings[0].provider.transitionId).toBe("t-200-deleted");
    expect(subcaseFindings[0].description).toContain("2 different situations");
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
    const subcaseFindings = findings.filter(
      (f) => f.kind === "unhandledProviderCase" && f.severity === "warning",
    );
    // All three 404 transitions have conditions, consumer doesn't distinguish
    expect(subcaseFindings).toHaveLength(3);
    expect(subcaseFindings[0].description).toContain("3 different situations");
    expect(subcaseFindings[0].description).toContain("status 404");
  });
  it("treats a negated 2xx range as handling every non-2xx status", () => {
    const p = provider("renewDomain", [
      transition("t-400", { output: response(400) }),
      transition("t-404", { output: response(404) }),
      transition("t-409", { output: response(409) }),
      transition("t-200", { output: response(200) }),
    ]);
    // `if (!res.ok) { toast.error(...); return }`, then the success path.
    const c = consumer("RenewDomain", [
      transition("ct-failed", {
        conditions: [negated(statusInRange(200, 299))],
        output: { type: "return", value: null },
      }),
      transition("ct-ok", {
        conditions: [negated(negated(statusInRange(200, 299)))],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("reads `res.ok` left as a truthiness check the same way", () => {
    const p = provider("renewDomain", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200) }),
    ]);
    const c = consumer("RenewDomain", [
      transition("ct-failed", {
        conditions: [successFlag(true)],
        output: { type: "return", value: null },
      }),
      transition("ct-ok", {
        conditions: [successFlag(false)],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("leaves a status outside every branch's range reported", () => {
    const p = provider("renewDomain", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200) }),
    ]);
    // Only the failure path exists: nothing admits a 200.
    const c = consumer("RenewDomain", [
      transition("ct-failed", {
        conditions: [negated(statusInRange(200, 299))],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkProviderCoverage(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("200");
  });

  it("does not let a branch with no status guard cover every status", () => {
    const p = provider("banLink", [
      transition("t-404", { output: response(404) }),
      transition("t-200", { output: response(200) }),
    ]);
    // `.then((r) => r.json())`, then a branch on a body field.
    const c = consumer("BanLink", [
      transition("ct-error", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: { type: "input", inputRef: "res", path: ["error"] },
            negated: false,
          },
        ],
        output: { type: "return", value: null },
      }),
    ]);
    // The branch never tests the status, so a 200 can reach it.
    const findings = checkProviderCoverage(p, c);
    expect(findings.map((f) => f.description)).toEqual([
      "Provider produces status 404 but no consumer branch handles it",
    ]);
  });

  it("lets branches that never test the status take a success", () => {
    const p = provider("saveMarkers", [
      transition("t-200", { output: response(200) }),
      transition("t-401", { output: response(401) }),
    ]);
    // Each branch tests something before the call, none tests the response.
    const c = consumer("SubmitMarkers", [
      transition("ct-no-token", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: { type: "dependency", name: "getToken", accessChain: [] },
            negated: true,
          },
        ],
        output: { type: "return", value: null },
      }),
      transition("ct-sent", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: { type: "dependency", name: "getToken", accessChain: [] },
            negated: false,
          },
        ],
        output: { type: "return", value: null },
      }),
    ]);
    expect(
      checkProviderCoverage(p, c).map((f) => f.description),
    ).toEqual(["Provider produces status 401 but no consumer branch handles it"]);
  });

  it("leaves the status to the caller when the consumer returns the response", () => {
    const p = provider("setup", [
      transition("t-200", { output: response(200) }),
      transition("t-401", { output: response(401) }),
      transition("t-500", { output: response(500) }),
    ]);
    const c = consumer("TwoFactorApi.setup", [
      transition("ct-return", {
        output: {
          type: "return",
          value: { type: "ref", name: "Promise<Response>" },
        },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("finds the response inside a record or a union the consumer returns", () => {
    const p = provider("lookup", [
      transition("t-200", { output: response(200) }),
      transition("t-404", { output: response(404) }),
    ]);
    const returning = (value: TypeShape) =>
      consumer("lookup", [
        transition("ct-return", {
          output: { type: "return", value },
          isDefault: true,
        }),
      ]);
    const inRecord: TypeShape = {
      type: "record",
      properties: { response: { type: "ref", name: "Response" } },
    };
    const inUnion: TypeShape = {
      type: "union",
      variants: [{ type: "null" }, { type: "ref", name: "AxiosResponse<User>" }],
    };
    expect(checkProviderCoverage(p, returning(inRecord))).toEqual([]);
    expect(checkProviderCoverage(p, returning(inUnion))).toEqual([]);
    expect(
      checkProviderCoverage(p, returning({ type: "text" })),
    ).toHaveLength(1);
  });

  it("still judges a consumer that returns a body type named like a response", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200) }),
      transition("t-404", { output: response(404) }),
    ]);
    const c = consumer("getUser", [
      transition("ct-return", {
        output: {
          type: "return",
          value: { type: "ref", name: "Promise<UserResponse>" },
        },
        isDefault: true,
      }),
    ]);
    expect(
      checkProviderCoverage(p, c).map((f) => f.description),
    ).toEqual(["Provider produces status 404 but no consumer branch handles it"]);
  });

  it("does not ask a consumer that never looks at the response to tell sub-cases apart", () => {
    const p = provider("getHome", [
      transition("t-200-signed-in", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: { type: "dependency", name: "currentUser", accessChain: [] },
            negated: false,
          },
        ],
        output: response(200),
      }),
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    // `cache.put("/", await fetch("/"))`: the response is stored unread.
    const c = consumer("cacheRoot", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });

  it("reads a one-sided comparison as the range it describes", () => {
    const p = provider("getUser", [
      transition("t-500", { output: response(500) }),
      transition("t-200", { output: response(200) }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-server-error", {
        conditions: [
          {
            type: "comparison",
            left: {
              type: "derived",
              from: { type: "dependency", name: "fetch", accessChain: [] },
              derivation: { type: "propertyAccess", property: "status" },
            },
            op: "gte",
            right: { type: "literal", value: 500 },
          },
        ],
        output: { type: "return", value: null },
      }),
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });
});

describe("checkProviderCoverage — provider ranges", () => {
  const rangeProvider = () =>
    provider("getPet", [
      transition("t-2xx", {
        output: rangeResponse(),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
      transition("t-4xx", {
        output: rangeResponse(),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);

  it("counts a branch on one member as covering the range", () => {
    const c = consumer("PetPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-else", {
        conditions: [negated(statusEq(404))],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(rangeProvider(), c)).toEqual([]);
  });

  it("counts a `!res.ok` guard as covering a failure range", () => {
    const c = consumer("PetPage", [
      transition("ct-failed", {
        conditions: [negated(statusInRange(200, 299))],
        output: { type: "return", value: null },
      }),
      transition("ct-ok", {
        conditions: [negated(negated(statusInRange(200, 299)))],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkProviderCoverage(rangeProvider(), c)).toEqual([]);
  });

  it("counts a catch on a throwing client as covering a failure range", () => {
    const c = throwsOnFailure(
      consumer("PetPage", [
        transition("ct-catch", {
          conditions: [catchEntry()],
          output: { type: "return", value: null },
        }),
        transition("ct-default", {
          output: { type: "return", value: null },
          isDefault: true,
        }),
      ]),
    );
    expect(checkProviderCoverage(rangeProvider(), c)).toEqual([]);
  });

  it("reports an uncovered range once, not per member", () => {
    const c = consumer("PetPage", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkProviderCoverage(rangeProvider(), c);
    expect(findings.map((f) => f.description)).toEqual([
      "Provider produces statuses in the 4XX range but no consumer branch handles any of them",
    ]);
    expect(findings[0].kind).toBe("unhandledProviderCase");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].provider.transitionId).toBe("t-4xx");
  });

  it("keeps the finding when the consumer reads a 2XX-only field on a path that admits 4XX", () => {
    const p = provider("getPet", [
      transition("t-2xx", {
        output: rangeResponse(recordBody("name")),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
      transition("t-4xx", {
        output: rangeResponse(),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("PetPage", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: {
        type: "record",
        properties: {
          body: {
            type: "record",
            properties: { name: { type: "unknown" } },
          },
        },
      },
    };
    const findings = checkProviderCoverage(p, c);
    expect(findings.map((f) => f.description)).toEqual([
      "Provider produces statuses in the 4XX range but no consumer branch handles any of them",
    ]);
  });

  it("counts a guard on a field only the failure range's body returns", () => {
    const p = provider("getPet", [
      transition("t-2xx", {
        output: rangeResponse(recordBody("name")),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
      transition("t-4xx", {
        output: rangeResponse(recordBody("error")),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("PetPage", [
      transition("ct-error", {
        conditions: [bodyFieldTruthy("error")],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkProviderCoverage(p, c)).toEqual([]);
  });
});
