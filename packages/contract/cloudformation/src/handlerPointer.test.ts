import { describe, expect, it } from "vitest";

import { readHttpMetadata } from "@suss/behavioral-ir";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CloudFormationTemplate } from "@suss/manifest-aws";

function implementingHandlerOf(summary: BehavioralSummary) {
  return readHttpMetadata(summary)?.implementingHandler;
}

describe("cloudFormationToSummaries — SAM handler pointer", () => {
  const template: CloudFormationTemplate = {
    Resources: {
      // SAM Function Events expand onto an explicit API resource.
      HttpGateway: { Type: "AWS::Serverless::HttpApi" },
      RestGateway: {
        Type: "AWS::Serverless::Api",
        Properties: { StageName: "prod" },
      },
      ConfirmFn: {
        Type: "AWS::Serverless::Function",
        Properties: {
          Handler: "src/handlers/confirmToken.handler",
          CodeUri: ".",
          Events: {
            Confirm: {
              Type: "HttpApi",
              Properties: {
                Method: "POST",
                Path: "/tokens/{tokenId}/confirm",
              },
            },
          },
        },
      },
      RestFn: {
        Type: "AWS::Serverless::Function",
        Properties: {
          Handler: "src/handlers/legacy.handler",
          Events: {
            Ping: {
              Type: "Api",
              Properties: { Method: "GET", Path: "/ping" },
            },
          },
        },
      },
    },
  };

  it("stamps the implementing handler on HttpApi route summaries", () => {
    const summaries = cloudFormationToSummaries(template, {
      source: "template.yaml",
    });
    const confirm = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path ===
          "/tokens/{tokenId}/confirm",
    );
    expect(confirm).toBeDefined();
    expect(implementingHandlerOf(confirm as BehavioralSummary)).toMatchObject({
      handler: "src/handlers/confirmToken.handler",
      modulePath: "src/handlers/confirmToken",
      exportName: "handler",
      functionLogicalId: "ConfirmFn",
      codeUri: ".",
    });
  });

  it("stamps the implementing handler on REST (Api) endpoint summaries", () => {
    const summaries = cloudFormationToSummaries(template, {
      source: "template.yaml",
    });
    const ping = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/ping",
    );
    expect(ping).toBeDefined();
    expect(implementingHandlerOf(ping as BehavioralSummary)).toMatchObject({
      handler: "src/handlers/legacy.handler",
      functionLogicalId: "RestFn",
    });
  });
});
