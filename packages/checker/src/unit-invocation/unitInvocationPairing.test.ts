/**
 * Pairing an invoke against the unit it reaches, including the case
 * neither side can settle alone: the code names an env var and only
 * the template says which function that variable points at.
 */

import { describe, expect, it } from "vitest";

import { unitInvocationBinding } from "@suss/behavioral-ir";

import {
  checkUnitInvocation,
  invokersOfUnits,
} from "./unitInvocationPairing.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";

/** A Lambda whose template routes no event to it. */
function deployedUnit(instanceName: string, file: string): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 5 }, exportName: "handler" },
    identity: {
      name: `${instanceName}.handler`,
      exportPath: [`${instanceName}.handler`],
      deployableUnit: { deploymentTarget: "lambda", instanceName },
      boundaryBinding: unitInvocationBinding({
        recognition: "aws-lambda",
        deploymentTarget: "lambda",
        instanceName,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** A Lambda that invokes whatever name it is given. */
function invoker(opts: {
  instanceName: string;
  file: string;
  invokes: string | null;
}): BehavioralSummary {
  return {
    ...deployedUnit(opts.instanceName, opts.file),
    transitions: [
      {
        id: "t0",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: unitInvocationBinding({
              recognition: "aws-lambda",
              deploymentTarget: "lambda",
              instanceName: opts.invokes,
            }),
            callee: "lambda.send",
            interaction: { class: "unit-invoke" },
          },
        ],
        location: { start: 1, end: 5 },
        isDefault: false,
      },
    ],
  };
}

/** The template entry that says what an invoking function's env is set to. */
function runtimeConfigProvider(opts: {
  instanceName: string;
  codeScopePath: string;
  envVarTargets: Record<string, { kind: "ref"; logicalId: string }>;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: opts.instanceName,
      exportPath: null,
      deployableUnit: {
        deploymentTarget: "lambda",
        instanceName: opts.instanceName,
      },
      boundaryBinding: {
        transport: "os",
        semantics: {
          name: "runtime-config",
          deploymentTarget: "lambda",
          instanceName: opts.instanceName,
        },
        recognition: "cloudformation",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      codeScope: { kind: "codeUri", path: opts.codeScopePath },
      runtimeContract: {
        envVars: Object.keys(opts.envVarTargets),
        envVarTargets: opts.envVarTargets,
      },
    },
  };
}

describe("checkUnitInvocation", () => {
  it("pairs an invoke that names the function outright", () => {
    const compared: ComparedPair[] = [];
    const findings = checkUnitInvocation(
      [
        deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
        invoker({
          instanceName: "OrderApi",
          file: "src/order-api/index.ts",
          invokes: "ReportBuilder",
        }),
      ],
      undefined,
      compared,
    );

    expect(findings).toEqual([]);
    expect(compared.map((p) => p.key)).toEqual(["unit:lambda ReportBuilder"]);
  });

  it("collapses the env-var chain the template declares", () => {
    const compared: ComparedPair[] = [];
    const findings = checkUnitInvocation(
      [
        deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
        invoker({
          instanceName: "OrderApi",
          file: "src/order-api/index.ts",
          invokes: "{REPORT_BUILDER_FUNCTION}",
        }),
        runtimeConfigProvider({
          instanceName: "OrderApi",
          codeScopePath: "src/order-api/",
          envVarTargets: {
            REPORT_BUILDER_FUNCTION: {
              kind: "ref",
              logicalId: "ReportBuilder",
            },
          },
        }),
      ],
      undefined,
      compared,
    );

    expect(findings).toEqual([]);
    expect(compared.map((p) => p.key)).toEqual(["unit:lambda ReportBuilder"]);
  });

  it("reports an invoke whose target nothing in the run deploys", () => {
    const findings = checkUnitInvocation([
      invoker({
        instanceName: "OrderApi",
        file: "src/order-api/index.ts",
        invokes: "legacy-pricing",
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unitInvocationTargetUnknown");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.description).toContain("legacy-pricing");
  });

  it("says nothing about an invoke whose target arrives at run time", () => {
    const findings = checkUnitInvocation([
      deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
      invoker({
        instanceName: "OrderApi",
        file: "src/order-api/index.ts",
        invokes: null,
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it("leaves an env var no template points anywhere unpaired and quiet", () => {
    const findings = checkUnitInvocation([
      deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
      invoker({
        instanceName: "OrderApi",
        file: "src/order-api/index.ts",
        invokes: "{REPORT_BUILDER_FUNCTION}",
      }),
    ]);

    expect(findings).toEqual([]);
  });
});

describe("invokersOfUnits", () => {
  it("says who invokes each unit", () => {
    const invokes = invokersOfUnits([
      deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
      invoker({
        instanceName: "OrderApi",
        file: "src/order-api/index.ts",
        invokes: "ReportBuilder",
      }),
    ]);

    expect(
      invokes.byUnit
        .get("unit:lambda ReportBuilder")
        ?.map((s) => s.identity.name),
    ).toEqual(["OrderApi.handler"]);
    expect(invokes.unsettled).toBe(0);
  });

  it("counts the invokes that settle their target at run time", () => {
    const invokes = invokersOfUnits([
      invoker({
        instanceName: "OrderApi",
        file: "src/order-api/index.ts",
        invokes: null,
      }),
    ]);

    expect(invokes.byUnit.size).toBe(0);
    expect(invokes.unsettled).toBe(1);
  });

  it("lists one invoker once however many times it calls", () => {
    const twice = invoker({
      instanceName: "OrderApi",
      file: "src/order-api/index.ts",
      invokes: "ReportBuilder",
    });
    const [only] = twice.transitions;
    if (only === undefined) {
      throw new Error("the invoker fixture must have one transition");
    }
    const invokes = invokersOfUnits([
      deployedUnit("ReportBuilder", "src/report-builder/index.ts"),
      { ...twice, transitions: [only, { ...only, id: "t1" }] },
    ]);

    expect(invokes.byUnit.get("unit:lambda ReportBuilder")).toHaveLength(1);
  });
});
