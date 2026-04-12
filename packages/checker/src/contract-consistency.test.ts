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
import { checkContractConsistency } from "./contract-consistency.js";

describe("checkContractConsistency", () => {
  it("returns no findings when provider has no declared contract", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = consumer("UserPage", [
      transition("ct", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkContractConsistency(p, c)).toEqual([]);
  });

  it("surfaces each provider summary.gaps entry as a providerContractViolation finding", () => {
    const p = withContract(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [200, 500],
      [
        unhandledCaseGap(
          "Declared response 500 is never produced by the handler",
        ),
      ],
    );
    const c = consumer("UserPage", [
      transition("ct", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
      transition("ct-500", {
        conditions: [statusEq(500)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkContractConsistency(p, c);
    const providerViolations = findings.filter(
      (f) => f.kind === "providerContractViolation",
    );
    expect(providerViolations).toHaveLength(1);
    expect(providerViolations[0].severity).toBe("error");
    expect(providerViolations[0].description).toContain("500");
  });

  it("flags consumer as violating the contract when it handles an undeclared status", () => {
    const p = withContract(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [200, 404],
    );
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
      transition("ct-418", {
        conditions: [statusEq(418)],
        output: { type: "return", value: null },
      }),
    ]);
    const findings = checkContractConsistency(p, c);
    const undeclared = findings.find(
      (f) =>
        f.kind === "consumerContractViolation" && f.description.includes("418"),
    );
    expect(undeclared).toBeDefined();
    expect(undeclared!.severity).toBe("error");
  });

  it("flags consumer as violating when it fails to handle a declared non-success status", () => {
    const p = withContract(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [200, 404, 500],
    );
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
    const findings = checkContractConsistency(p, c);
    const unhandled = findings.filter(
      (f) =>
        f.kind === "consumerContractViolation" &&
        f.description.startsWith("Contract declares"),
    );
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].description).toContain("500");
    expect(unhandled[0].severity).toBe("warning");
  });

  it("treats consumer default branch as handling declared 2xx statuses", () => {
    const p = withContract(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [200, 404],
    );
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
    expect(checkContractConsistency(p, c)).toEqual([]);
  });

  it("ignores malformed declaredContract metadata", () => {
    const base = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const withBadContract: typeof base = {
      ...base,
      metadata: { declaredContract: "not-an-object" },
    };
    const c = consumer("UserPage", [
      transition("ct", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    expect(checkContractConsistency(withBadContract, c)).toEqual([]);
  });
});
