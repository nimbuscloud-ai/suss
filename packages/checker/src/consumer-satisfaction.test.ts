import { describe, expect, it } from "vitest";

import {
  consumer,
  opaqueResponse,
  provider,
  response,
  statusEq,
  transition,
} from "./__fixtures__/pairs.js";
import { checkConsumerSatisfaction } from "./consumer-satisfaction.js";

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
});
