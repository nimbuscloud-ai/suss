// What a template split across nested stacks turns into: which
// documents contribute summaries, what a resource declared in a child
// is named, and what a child nothing can open reads as.

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { cloudFormationFileToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/aws-nested-stacks/template.yaml",
);

function summariesFromFixture(): BehavioralSummary[] {
  // The fixture names two children nothing here can open, on purpose.
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return cloudFormationFileToSummaries(fixture);
  } finally {
    stderr.mockRestore();
  }
}

function instanceNames(summaries: BehavioralSummary[]): string[] {
  return summaries
    .map((s) => s.identity.deployableUnit?.instanceName)
    .filter((name): name is string => name !== undefined);
}

function runtimeConfigOf(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (s) => s.identity.boundaryBinding?.semantics.name === "runtime-config",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a template split across nested stacks", () => {
  it("summarizes the resources its children declare", () => {
    const summaries = summariesFromFixture();

    expect(instanceNames(summaries)).toEqual(
      expect.arrayContaining([
        "RootFunction",
        "OrdersStack/HandlerFunction",
        "BillingStack/HandlerFunction",
      ]),
    );
  });

  it("names the deployed function by the stack path that reaches it", () => {
    const named = runtimeConfigOf(summariesFromFixture()).filter((s) =>
      s.identity.deployableUnit?.instanceName.endsWith("HandlerFunction"),
    );

    // Two children declare HandlerFunction, and the two contracts stay
    // apart. The binding carries the same name as the unit, because a
    // runtime-config boundary is keyed on the instance.
    expect(named).toHaveLength(2);
    for (const summary of named) {
      const semantics = summary.identity.boundaryBinding?.semantics;
      expect(
        semantics?.name === "runtime-config" && semantics.instanceName,
      ).toBe(summary.identity.deployableUnit?.instanceName);
    }
    expect(new Set(instanceNames(named)).size).toBe(2);
  });

  it("keeps each document's env-var contract to that document's Globals", () => {
    const byInstance = new Map(
      runtimeConfigOf(summariesFromFixture()).map((s) => [
        s.identity.deployableUnit?.instanceName,
        readRuntimeContractMetadata(s)?.envVars,
      ]),
    );

    expect(byInstance.get("RootFunction")).toContain("ROOT_ONLY");
    expect(byInstance.get("OrdersStack/HandlerFunction")).toContain(
      "ORDERS_ONLY",
    );
    // The parent's section reaches the parent's resources and stops
    // there, so the child never inherits it.
    expect(byInstance.get("OrdersStack/HandlerFunction")).not.toContain(
      "ROOT_ONLY",
    );
    expect(byInstance.get("BillingStack/HandlerFunction")).not.toContain(
      "ORDERS_ONLY",
    );
  });

  it("records which document each summary was read from", () => {
    const files = new Set(summariesFromFixture().map((s) => s.location.file));

    const root = "cloudformation:fixtures/aws-nested-stacks/template.yaml";

    expect(files).toContain(root);
    expect(files).toContain(`${root}#OrdersStack`);
    expect(files).toContain(`${root}#BillingStack`);
  });

  it("says which children it could not open, and why", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    cloudFormationFileToSummaries(fixture);
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");

    expect(written).toContain("PackagedStack");
    expect(written).toContain("is not a path in this repository");
    expect(written).toContain("DashboardStack");
    expect(written).toContain("./dashboard-template.yaml is not on disk");
  });

  it("summarizes a route declared in a child", () => {
    const routes = summariesFromFixture()
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter((s) => s?.name === "rest")
      .map((s) => (s?.name === "rest" ? `${s.method} ${s.path}` : ""));

    expect(routes).toContain("GET /invoices");
  });
});
