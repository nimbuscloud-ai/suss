import { describe, expect, it } from "vitest";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function pickRuntimeConfig(
  summaries: BehavioralSummary[],
): BehavioralSummary[] {
  return summaries.filter(
    (s) => s.identity.boundaryBinding?.semantics.name === "runtime-config",
  );
}

interface RuntimeContractMeta {
  envVars?: string[];
  envVarSources?: Record<string, "template" | "platform">;
}

function readEnvVars(summary: BehavioralSummary): RuntimeContractMeta {
  return (summary.metadata?.runtimeContract ?? {}) as RuntimeContractMeta;
}

describe("buildRuntimeConfigSummaries — Lambda", () => {
  it("emits one summary per AWS::Lambda::Function with template-declared env vars", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Environment: {
                Variables: { DATABASE_URL: "x", STRIPE_KEY: "y" },
              },
            },
          },
        },
      }),
    );
    expect(summaries).toHaveLength(1);
    const meta = readEnvVars(summaries[0]);
    expect(meta.envVars).toContain("DATABASE_URL");
    expect(meta.envVars).toContain("STRIPE_KEY");
    expect(meta.envVarSources?.DATABASE_URL).toBe("template");
    expect(meta.envVarSources?.STRIPE_KEY).toBe("template");
  });

  it("appends Lambda's platform-injected vars with source=platform", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Lambda::Function",
            Properties: {},
          },
        },
      }),
    );
    const meta = readEnvVars(summaries[0]);
    expect(meta.envVars).toContain("AWS_REGION");
    expect(meta.envVars).toContain("AWS_LAMBDA_FUNCTION_NAME");
    expect(meta.envVarSources?.AWS_REGION).toBe("platform");
  });

  it("captures SAM Properties.CodeUri as codeScope", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Serverless::Function",
            Properties: {
              CodeUri: "./src/myFn",
              Environment: { Variables: { OK: "yes" } },
            },
          },
        },
      }),
    );
    const codeScope = summaries[0].metadata?.codeScope as {
      kind: string;
      path?: string;
    };
    expect(codeScope.kind).toBe("codeUri");
    expect(codeScope.path).toBe("src/myFn");
  });

  it("falls back to Metadata.SussCodeScope when no CodeUri is set", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Lambda::Function",
            Properties: {},
            Metadata: { SussCodeScope: "src/handlers/myFn/" },
          },
        },
      }),
    );
    const codeScope = summaries[0].metadata?.codeScope as {
      kind: string;
      path?: string;
    };
    expect(codeScope.kind).toBe("codeUri");
    expect(codeScope.path).toBe("src/handlers/myFn/");
  });

  it("emits codeScope.kind=unknown when neither CodeUri nor SussCodeScope is set", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Lambda::Function",
            Properties: { Code: { S3Bucket: "x", S3Key: "y" } },
          },
        },
      }),
    );
    expect(summaries[0].metadata?.codeScope).toEqual({ kind: "unknown" });
  });

  it("uses the resource's logicalId as the runtime instance name", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          CheckoutHandler: { Type: "AWS::Lambda::Function", Properties: {} },
        },
      }),
    );
    expect(summaries[0].identity.name).toBe("CheckoutHandler");
    if (
      summaries[0].identity.boundaryBinding?.semantics.name !== "runtime-config"
    ) {
      throw new Error("expected runtime-config semantics");
    }
    expect(
      summaries[0].identity.boundaryBinding.semantics.deploymentTarget,
    ).toBe("lambda");
    expect(summaries[0].identity.boundaryBinding.semantics.instanceName).toBe(
      "CheckoutHandler",
    );
  });
});

describe("buildRuntimeConfigSummaries — ECS task", () => {
  it("emits one summary per container in an AWS::ECS::TaskDefinition", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyTask: {
            Type: "AWS::ECS::TaskDefinition",
            Properties: {
              ContainerDefinitions: [
                {
                  Name: "api",
                  Environment: [
                    { Name: "PORT", Value: "8080" },
                    { Name: "DATABASE_URL", Value: "..." },
                  ],
                },
                {
                  Name: "worker",
                  Environment: [{ Name: "QUEUE_URL", Value: "..." }],
                },
              ],
            },
          },
        },
      }),
    );
    expect(summaries).toHaveLength(2);
    const apiSummary = summaries.find((s) => s.identity.name === "MyTask/api");
    const workerSummary = summaries.find(
      (s) => s.identity.name === "MyTask/worker",
    );
    expect(apiSummary).toBeDefined();
    expect(workerSummary).toBeDefined();
    expect(readEnvVars(apiSummary!).envVars).toContain("PORT");
    expect(readEnvVars(workerSummary!).envVars).toContain("QUEUE_URL");
  });

  it("appends ECS-specific platform-injected vars", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          T: {
            Type: "AWS::ECS::TaskDefinition",
            Properties: {
              ContainerDefinitions: [{ Name: "c", Environment: [] }],
            },
          },
        },
      }),
    );
    const meta = readEnvVars(summaries[0]);
    expect(meta.envVars).toContain("AWS_DEFAULT_REGION");
    expect(meta.envVars).toContain("ECS_CONTAINER_METADATA_URI_V4");
  });
});

describe("buildRuntimeConfigSummaries — provenance precedence", () => {
  it("template wins when a name overlaps a platform-injected one", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          MyFn: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Environment: { Variables: { AWS_REGION: "us-east-1" } },
            },
          },
        },
      }),
    );
    const meta = readEnvVars(summaries[0]);
    expect(meta.envVarSources?.AWS_REGION).toBe("template");
  });
});
