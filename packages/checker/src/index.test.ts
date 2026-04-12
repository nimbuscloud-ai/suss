import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
  unhandledCaseGap,
  withContract,
} from "./__fixtures__/pairs.js";
import { checkPair } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function emptySummary(name: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/${name}.ts`,
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: { name, exportPath: [name], boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkPair", () => {
  it("returns an empty finding list for two empty summaries", () => {
    const p = emptySummary("provider");
    const c = emptySummary("consumer");
    expect(checkPair(p, c)).toEqual([]);
  });

  it("returns an empty finding list for a clean pair", () => {
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
    expect(checkPair(p, c)).toEqual([]);
  });

  it("surfaces both an unhandled provider case and a dead consumer branch in one pass", () => {
    const p = provider("getUser", [
      transition("t-410", { output: response(410) }),
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
    const findings = checkPair(p, c);
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["deadConsumerBranch", "unhandledProviderCase"]);
  });

  it("composes all three check kinds when a declared contract is present", () => {
    const p = withContract(
      provider("getUser", [
        transition("t-418", { output: response(418) }),
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [200, 404, 500],
      [
        unhandledCaseGap(
          "Declared response 500 is never produced by the handler",
        ),
      ],
    );
    const c = consumer("UserPage", [
      transition("ct-500", {
        conditions: [statusEq(500)],
        output: { type: "return", value: null },
      }),
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const findings = checkPair(p, c);
    const kindSummary = findings
      .map((f) => f.kind)
      .reduce<Record<string, number>>((acc, k) => {
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

    expect(kindSummary.unhandledProviderCase).toBe(1);
    expect(kindSummary.deadConsumerBranch).toBe(1);
    expect(kindSummary.providerContractViolation).toBe(1);
    expect(kindSummary.consumerContractViolation).toBe(1);
  });
});
