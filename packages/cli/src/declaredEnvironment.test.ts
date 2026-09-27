import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { declarationChanges } from "./declaredEnvironment.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function environment(
  name: string,
  declared: Record<string, "template" | "platform">,
  targets: Record<string, string> = {},
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "cloudformation:template.yaml",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: "lambda",
        instanceName: name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: Object.keys(declared),
        envVarSources: declared,
        envVarTargets: Object.fromEntries(
          Object.entries(targets).map(([variable, logicalId]) => [
            variable,
            { kind: "ref", logicalId },
          ]),
        ),
      },
    },
  };
}

describe("declarationChanges", () => {
  it("lists a variable a template now declares, with the parameter its value comes from", () => {
    const before = [environment("Worker", { TABLE: "template" })];
    const after = [
      environment(
        "Worker",
        { TABLE: "template", REGION: "template" },
        { REGION: "RegionParameter" },
      ),
    ];

    expect(declarationChanges(before, after)).toMatchObject([
      {
        boundary: "runtime-config:Worker",
        unit: "Worker",
        change: "changed",
        declarations: [
          { change: "added", name: "REGION", from: "RegionParameter" },
        ],
      },
    ]);
  });

  it("lists every variable of a function the template added or dropped", () => {
    const before = [environment("Old", { TABLE: "template" })];
    const after = [environment("New", { QUEUE: "template" })];

    expect(
      declarationChanges(before, after).map((one) => ({
        unit: one.unit,
        change: one.change,
        declarations: one.declarations,
      })),
    ).toEqual([
      {
        unit: "New",
        change: "added",
        declarations: [{ change: "added", name: "QUEUE" }],
      },
      {
        unit: "Old",
        change: "removed",
        declarations: [{ change: "removed", name: "TABLE" }],
      },
    ]);
  });

  it("leaves out what the platform sets and a function whose variables stayed the same", () => {
    const before = [environment("Worker", { TABLE: "template" })];
    const after = [
      environment("Worker", { TABLE: "template", AWS_REGION: "platform" }),
    ];

    expect(declarationChanges(before, after)).toEqual([]);
  });
});
