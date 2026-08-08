import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { cloudFormationToSummaries } from "./index.js";

import type {
  BehavioralSummary,
  RuntimeContractMetadata,
} from "@suss/behavioral-ir";

function pickRuntimeConfig(
  summaries: BehavioralSummary[],
): BehavioralSummary[] {
  return summaries.filter(
    (s) => s.identity.boundaryBinding?.semantics.name === "runtime-config",
  );
}

function readEnvVars(summary: BehavioralSummary): RuntimeContractMetadata {
  return readRuntimeContractMetadata(summary) ?? {};
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

  it("gives a function the section's variables, marked as the section's", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Globals: {
          Function: {
            Environment: {
              Variables: { LOG_LEVEL: "info", TABLE_NAME: { Ref: "Shared" } },
            },
          },
        },
        Resources: {
          MyFn: {
            Type: "AWS::Serverless::Function",
            Properties: {
              Environment: { Variables: { TABLE_NAME: { Ref: "Own" } } },
            },
          },
        },
      }),
    );
    const meta = readEnvVars(summaries[0]);
    expect(meta.envVars).toContain("LOG_LEVEL");
    expect(meta.envVarSources?.LOG_LEVEL).toBe("globals");
    // The function declares this one itself, so it is the source.
    expect(meta.envVarSources?.TABLE_NAME).toBe("template");
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
    expect(codeScope.path).toBe("src/handlers/myFn");
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

  it("says the same deployable unit on the identity as on the binding", () => {
    const summaries = pickRuntimeConfig(
      cloudFormationToSummaries({
        Resources: {
          CheckoutHandler: { Type: "AWS::Lambda::Function", Properties: {} },
        },
      }),
    );
    const semantics = summaries[0].identity.boundaryBinding?.semantics;
    if (semantics?.name !== "runtime-config") {
      throw new Error("expected runtime-config semantics");
    }
    expect(summaries[0].identity.deployableUnit).toEqual({
      deploymentTarget: semantics.deploymentTarget,
      instanceName: semantics.instanceName,
    });
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

describe("what recognized the resources", () => {
  const template = {
    Resources: {
      Worker: {
        Type: "AWS::Serverless::Function",
        Properties: {
          Runtime: "nodejs20.x",
          Environment: { Variables: { QUEUE_URL: { Ref: "Jobs" } } },
        },
      },
      Jobs: { Type: "AWS::SQS::Queue", Properties: {} },
    },
  };

  it("says cloudformation when the caller does not say otherwise", () => {
    const recognitions = new Set(
      cloudFormationToSummaries(template).map(
        (s) => s.identity.boundaryBinding?.recognition,
      ),
    );

    expect(recognitions).toEqual(new Set(["cloudformation"]));
  });

  it("carries another manifest language's name onto every binding it keys", () => {
    // A reader whose document compiles to these resource shapes reads
    // through this walk and points at the document a person wrote.
    const recognitions = new Set(
      cloudFormationToSummaries(template, { recognition: "serverless" }).map(
        (s) => s.identity.boundaryBinding?.recognition,
      ),
    );

    expect(recognitions).toEqual(new Set(["serverless"]));
  });

  it("records the language runtime the manifest declares", () => {
    const summaries = pickRuntimeConfig(cloudFormationToSummaries(template));

    expect(readEnvVars(summaries[0]).runtime).toBe("nodejs20.x");
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
