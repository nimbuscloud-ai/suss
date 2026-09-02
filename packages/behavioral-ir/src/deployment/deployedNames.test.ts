import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/ir-core";

import { deploymentOf } from "./deployedNames.js";

import type { BehavioralSummary, Input } from "../index.js";

/** A handler in a unit's code, with whatever parameters it declares. */
function code(
  file: string,
  inputs: Input[] = [],
  unit?: string,
): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 10 }, exportName: "handler" },
    identity: {
      name: "handler",
      exportPath: ["handler"],
      boundaryBinding: null,
      ...(unit === undefined
        ? {}
        : {
            deployableUnit: {
              deploymentTarget: "lambda" as const,
              instanceName: unit,
            },
          }),
    },
    inputs,
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** A deployment that runs the code under `scope` with what it sets. */
function runtime(opts: {
  name: string;
  scope: string;
  values?: Record<string, string>;
  targets?: Record<string, { kind: "ref"; logicalId: string }>;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 1, end: 5 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: "lambda",
        instanceName: opts.name,
      }),
      deployableUnit: {
        deploymentTarget: "lambda" as const,
        instanceName: opts.name,
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: Object.keys(opts.values ?? opts.targets ?? {}),
        ...(opts.values === undefined ? {} : { envVarValues: opts.values }),
        ...(opts.targets === undefined ? {} : { envVarTargets: opts.targets }),
      },
      codeScope: { kind: "codeUri" as const, path: opts.scope },
    },
  };
}

const parameter = (name: string, role: string | null): Input => ({
  type: "parameter",
  name,
  position: 0,
  role,
  shape: { type: "unknown" },
});

const bare = (root: string) => ({ root, fields: [] });

describe("deploymentOf", () => {
  it("gives back what the deployment sets a variable to", () => {
    const handler = code("src/secrets/index.ts");
    const deployment = deploymentOf([
      handler,
      runtime({
        name: "SecretsRotator",
        scope: "src/secrets",
        values: { API_KEY_SECRET_ID: "prod/app/api-key" },
      }),
    ]);

    expect(deployment(handler).setTo(bare("API_KEY_SECRET_ID"))).toBe(
      "prod/app/api-key",
    );
  });

  it("gives back the resource a variable points at", () => {
    const handler = code("src/report-builder/index.ts");
    const deployment = deploymentOf([
      handler,
      runtime({
        name: "ReportBuilder",
        scope: "src/report-builder",
        targets: {
          ARCHIVE_WORKER_FUNCTION: { kind: "ref", logicalId: "ArchiveWorker" },
        },
      }),
    ]);

    expect(deployment(handler).pointsAt(bare("ARCHIVE_WORKER_FUNCTION"))).toBe(
      "ArchiveWorker",
    );
  });

  it("settles nothing for a unit no runtime in the set runs", () => {
    const handler = code("other/index.ts");
    const deployment = deploymentOf([
      handler,
      runtime({
        name: "SecretsRotator",
        scope: "src/secrets",
        values: { API_KEY_SECRET_ID: "prod/app/api-key" },
      }),
    ]);

    expect(deployment(handler).setTo(bare("API_KEY_SECRET_ID"))).toBeNull();
  });

  it("settles nothing when two deployments of the code disagree", () => {
    // Picking one of the two would be a guess, and an unpaired
    // boundary says less than a wrong pair.
    const handler = code("src/app/index.ts");
    const deployment = deploymentOf([
      handler,
      runtime({
        name: "Staging",
        scope: "src/app",
        values: { TABLE: "staging-orders" },
      }),
      runtime({
        name: "Production",
        scope: "src/app",
        values: { TABLE: "prod-orders" },
      }),
    ]);

    expect(deployment(handler).setTo(bare("TABLE"))).toBeNull();
  });

  it("settles nothing with no deployment in the set at all", () => {
    const handler = code("src/secrets/index.ts");
    const deployment = deploymentOf([handler])(handler);

    expect(deployment.setTo(bare("API_KEY_SECRET_ID"))).toBeNull();
    expect(deployment.pointsAt(bare("ARCHIVE_WORKER_FUNCTION"))).toBeNull();
  });

  it("settles nothing for a variable the deployment never sets", () => {
    const handler = code("src/secrets/index.ts");
    const deployment = deploymentOf([
      handler,
      runtime({
        name: "SecretsRotator",
        scope: "src/secrets",
        values: { API_KEY_SECRET_ID: "prod/app/api-key" },
        targets: {
          ARCHIVE_WORKER_FUNCTION: { kind: "ref", logicalId: "ArchiveWorker" },
        },
      }),
    ])(handler);

    expect(deployment.setTo(bare("SOMETHING_ELSE"))).toBeNull();
    expect(deployment.pointsAt(bare("SOMETHING_ELSE"))).toBeNull();
  });
});

describe("which variable a reference asks about", () => {
  const handler = (inputs: Input[]) => code("src/app/index.ts", inputs);
  const asking = (summary: BehavioralSummary, name: string, field: string) =>
    deploymentOf([
      summary,
      runtime({
        name: "App",
        scope: "src/app",
        values: { [field]: "prod-subscribers-v1" },
      }),
    ])(summary).setTo({ root: name, fields: [field] });

  it("reads through the argument a pack calls the configuration", () => {
    const summary = handler([parameter("env", "config")]);

    expect(asking(summary, "env", "SUBSCRIBERS_TABLE")).toBe(
      "prod-subscribers-v1",
    );
  });

  it("leaves a path whose root the unit never takes to whoever calls it", () => {
    const summary = handler([]);

    expect(asking(summary, "env", "SUBSCRIBERS_TABLE")).toBeNull();
  });

  it("leaves a path through an ordinary parameter to whoever calls it", () => {
    const summary = handler([parameter("location", null)]);

    expect(asking(summary, "location", "bucket")).toBeNull();
    expect(
      deploymentOf([summary])(summary).variableFor({
        root: "location",
        fields: ["bucket"],
      }),
    ).toBeNull();
  });

  it("names the root itself when the reference has no fields", () => {
    const summary = handler([]);

    expect(deploymentOf([summary])(summary).variableFor(bare("API_BASE"))).toBe(
      "API_BASE",
    );
  });
});
