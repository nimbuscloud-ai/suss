import { describe, expect, it } from "vitest";

import {
  consumer,
  opaqueResponse,
  provider,
  response,
  statusEq,
  transition,
} from "./__fixtures__/pairs.js";
import { checkProviderCoverage } from "./provider-coverage.js";

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
    expect(findings[0].boundary.framework).toBe("ts-rest");
  });
});
