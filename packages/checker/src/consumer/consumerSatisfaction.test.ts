import { describe, expect, it } from "vitest";

import {
  consumer,
  opaqueResponse,
  provider,
  rangeResponse,
  response,
  statusEq,
  transition,
  unreadOutcomeGap,
} from "../__fixtures__/pairs.js";
import { checkConsumerSatisfaction } from "./consumerSatisfaction.js";

import type { Predicate } from "@suss/behavioral-ir";

describe("checkConsumerSatisfaction", () => {
  it("reports no findings when every consumer-expected status is produced", () => {
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
    expect(checkConsumerSatisfaction(p, c)).toEqual([]);
  });

  it("emits deadConsumerBranch when consumer handles a status provider never produces", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-410", {
        conditions: [statusEq(410)],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkConsumerSatisfaction(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("deadConsumerBranch");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].description).toContain("410");
    expect(findings[0].consumer.transitionId).toBe("ct-410");
  });

  it("treats a status inside a declared range as produced", () => {
    const p = provider("getPet", [
      transition("t-2xx", {
        output: rangeResponse(),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
      transition("t-4xx", {
        output: rangeResponse(),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("PetPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkConsumerSatisfaction(p, c)).toEqual([]);
  });

  it("still reports a status outside every declared range as dead", () => {
    const p = provider("getPet", [
      transition("t-2xx", {
        output: rangeResponse(),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
    ]);
    const c = consumer("PetPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkConsumerSatisfaction(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("deadConsumerBranch");
    expect(findings[0].description).toContain("404");
  });

  it("treats every status as produced when the provider has a catch-all default", () => {
    const p = provider("getPet", [
      transition("t-200", { output: response(200) }),
      transition("t-default", { output: rangeResponse(), isDefault: true }),
    ]);
    const c = consumer("PetPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
    ]);
    expect(checkConsumerSatisfaction(p, c)).toEqual([]);
  });

  it("reports the reading, not a dead branch, when nothing about the provider was read", () => {
    const p = {
      ...provider("getUser", []),
      gaps: [unreadOutcomeGap("the handler comes from outside this file")],
    };
    const c = consumer("UserPage", [
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkConsumerSatisfaction(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("lowConfidence");
    expect(findings[0].severity).toBe("info");
  });

  it("emits lowConfidence instead of deadConsumerBranch when provider has an opaque status", () => {
    const p = provider("getUser", [
      transition("t-dyn", { output: opaqueResponse() }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-410", {
        conditions: [statusEq(410)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkConsumerSatisfaction(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("lowConfidence");
    expect(findings[0].severity).toBe("info");
  });

  it("emits one finding per unmatched expected status", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-410", {
        conditions: [statusEq(410)],
        output: { type: "return", value: null },
      }),
      transition("ct-418", {
        conditions: [statusEq(418)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkConsumerSatisfaction(p, c);
    expect(findings).toHaveLength(2);
    const expectedStatuses = findings
      .map((f) => f.consumer.transitionId)
      .sort();
    expect(expectedStatuses).toEqual(["ct-410", "ct-418"]);
  });

  it("recognises pack-defined status accessors via metadata", () => {
    // Consumer comes from a hypothetical pack whose response object exposes
    // the HTTP status as `.responseStatus` rather than `.status`. Without
    // metadata, the checker would not see the comparison as a status
    // predicate and would think every consumer expectation went unmatched.
    const responseStatusEq = (status: number): Predicate => ({
      type: "comparison",
      op: "eq",
      left: {
        type: "derived",
        from: { type: "dependency", name: "client.get", accessChain: [] },
        derivation: { type: "propertyAccess", property: "responseStatus" },
      },
      right: { type: "literal", value: status },
    });

    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
      transition("t-410", { output: response(410) }),
    ]);
    const c = consumer(
      "UserPage",
      [
        transition("ct-410", {
          conditions: [responseStatusEq(410)],
          output: { type: "return", value: null },
        }),
      ],
      { http: { statusAccessors: ["responseStatus"] } },
    );
    expect(checkConsumerSatisfaction(p, c)).toEqual([]);
  });
});
