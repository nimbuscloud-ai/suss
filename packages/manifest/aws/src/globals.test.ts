import { describe, expect, it } from "vitest";

import { inheritedEnvVars, resourcesWithGlobals } from "./globals.js";

describe("resourcesWithGlobals", () => {
  it("gives a function the variables only the section declares", () => {
    const resources = resourcesWithGlobals({
      Globals: {
        Function: {
          Environment: { Variables: { LOG_LEVEL: "info", STAGE: "prod" } },
        },
      },
      Resources: {
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Environment: { Variables: { QUEUE_URL: "https://sqs" } },
          },
        },
      },
    });

    const env = resources.Worker.Properties?.Environment as {
      Variables: Record<string, unknown>;
    };
    expect(Object.keys(env.Variables).sort()).toEqual([
      "LOG_LEVEL",
      "QUEUE_URL",
      "STAGE",
    ]);
  });

  it("keeps the function's own value where both declare the variable", () => {
    const resources = resourcesWithGlobals({
      Globals: {
        Function: { Environment: { Variables: { TABLE_NAME: "shared" } } },
      },
      Resources: {
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Environment: { Variables: { TABLE_NAME: "own" } },
          },
        },
      },
    });

    const env = resources.Worker.Properties?.Environment as {
      Variables: Record<string, unknown>;
    };
    expect(env.Variables.TABLE_NAME).toBe("own");
  });

  it("replaces the section's intrinsic rather than merging into it", () => {
    const resources = resourcesWithGlobals({
      Globals: {
        Function: {
          Environment: { Variables: { TABLE_NAME: { Ref: "SharedTable" } } },
        },
      },
      Resources: {
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Environment: {
              Variables: { TABLE_NAME: { "Fn::GetAtt": ["OwnTable", "Arn"] } },
            },
          },
        },
      },
    });

    const env = resources.Worker.Properties?.Environment as {
      Variables: Record<string, unknown>;
    };
    expect(env.Variables.TABLE_NAME).toEqual({
      "Fn::GetAtt": ["OwnTable", "Arn"],
    });
  });

  it("gives a function a property it declares nothing about", () => {
    const resources = resourcesWithGlobals({
      Globals: { Function: { Runtime: "nodejs20.x", Timeout: 10 } },
      Resources: {
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: { Handler: "src/worker.handler", Timeout: 30 },
        },
      },
    });

    expect(resources.Worker.Properties).toEqual({
      Handler: "src/worker.handler",
      Runtime: "nodejs20.x",
      Timeout: 30,
    });
  });

  it("holds the section's list entries ahead of the resource's", () => {
    const resources = resourcesWithGlobals({
      Globals: { Function: { Layers: [{ Ref: "SharedLayer" }] } },
      Resources: {
        Worker: {
          Type: "AWS::Serverless::Function",
          Properties: { Layers: [{ Ref: "OwnLayer" }] },
        },
      },
    });

    expect(resources.Worker.Properties?.Layers).toEqual([
      { Ref: "SharedLayer" },
      { Ref: "OwnLayer" },
    ]);
  });

  it("applies a section only to the resource type it names", () => {
    const resources = resourcesWithGlobals({
      Globals: { Function: { Timeout: 10 }, HttpApi: { StageName: "live" } },
      Resources: {
        Api: { Type: "AWS::Serverless::HttpApi", Properties: {} },
        Queue: { Type: "AWS::SQS::Queue", Properties: {} },
      },
    });

    expect(resources.Api.Properties).toEqual({ StageName: "live" });
    expect(resources.Queue.Properties).toEqual({});
  });

  it("leaves the resources alone when the template has no section", () => {
    const template = {
      Resources: {
        Worker: { Type: "AWS::Serverless::Function", Properties: {} },
      },
    };
    expect(resourcesWithGlobals(template)).toBe(template.Resources);
  });

  it("ignores a section name SAM does not define", () => {
    const resources = resourcesWithGlobals({
      Globals: { Table: { BillingMode: "PAY_PER_REQUEST" } },
      Resources: {
        Widgets: { Type: "AWS::DynamoDB::Table", Properties: {} },
      },
    });
    expect(resources.Widgets.Properties).toEqual({});
  });
});

describe("inheritedEnvVars", () => {
  it("names the variables a function takes from the section", () => {
    const inherited = inheritedEnvVars({
      Globals: {
        Function: {
          Environment: {
            Variables: { LOG_LEVEL: "info", TABLE_NAME: "shared" },
          },
        },
      },
      Resources: {
        Ingest: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Environment: { Variables: { TABLE_NAME: "own", OWN_ONLY: "x" } },
          },
        },
        Notify: { Type: "AWS::Serverless::Function", Properties: {} },
        Queue: { Type: "AWS::SQS::Queue" },
      },
    });

    // A function that declares TABLE_NAME itself does not inherit it.
    expect(inherited.Ingest).toEqual(["LOG_LEVEL"]);
    expect(inherited.Notify).toEqual(["LOG_LEVEL", "TABLE_NAME"]);
    expect(inherited.Queue).toBeUndefined();
  });

  it("names nothing when the section declares no environment", () => {
    expect(
      inheritedEnvVars({
        Globals: { Function: { Timeout: 10 } },
        Resources: {
          Ingest: { Type: "AWS::Serverless::Function", Properties: {} },
        },
      }),
    ).toEqual({});
  });
});
