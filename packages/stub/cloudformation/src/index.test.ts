import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "./index.js";

const inlineOpenApi = {
  openapi: "3.0.3",
  info: { title: "users-api", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id"],
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("cloudFormationToSummaries — resource shapes", () => {
  it("extracts inline OpenAPI from AWS::ApiGateway::RestApi.Properties.Body", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        UsersApi: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineOpenApi },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("getUser");
    expect(summaries[0].identity.boundaryBinding).toEqual({
      protocol: "http",
      method: "GET",
      path: "/users/{id}",
      framework: "openapi",
    });
  });

  it("extracts inline OpenAPI from AWS::ApiGatewayV2::Api.Properties.Body", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        HttpApi: {
          Type: "AWS::ApiGatewayV2::Api",
          Properties: { Body: inlineOpenApi },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("getUser");
  });

  it("reads DefinitionBody for SAM AWS::Serverless::Api / HttpApi", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        SamRest: {
          Type: "AWS::Serverless::Api",
          Properties: { DefinitionBody: inlineOpenApi },
        },
        SamHttp: {
          Type: "AWS::Serverless::HttpApi",
          Properties: { DefinitionBody: inlineOpenApi },
        },
      },
    });
    // Two resources, one operation each
    expect(summaries).toHaveLength(2);
  });

  it("walks every API Gateway-shaped resource in the template", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ApiOne: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineOpenApi },
        },
        ApiTwo: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineOpenApi },
        },
      },
    });
    expect(summaries).toHaveLength(2);
  });

  it("ignores non-API-Gateway resources", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "mybucket" },
        },
        UsersApi: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineOpenApi },
        },
      },
    });
    expect(summaries).toHaveLength(1);
  });

  it("skips API Gateway resources whose Body is missing or not an object", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        OutOfLine: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { BodyS3Location: { Bucket: "x", Key: "y" } },
        },
        NoProperties: {
          Type: "AWS::ApiGateway::RestApi",
        },
        StringBody: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: "not-an-object" },
        },
      },
    });
    expect(summaries).toHaveLength(0);
  });

  it("tags each summary's source with the logical resource id", () => {
    const summaries = cloudFormationToSummaries(
      {
        Resources: {
          UsersApi: {
            Type: "AWS::ApiGateway::RestApi",
            Properties: { Body: inlineOpenApi },
          },
        },
      },
      { source: "stack" },
    );
    expect(summaries[0].location.file).toContain("UsersApi");
  });

  it("returns empty when the template has no Resources block", () => {
    expect(cloudFormationToSummaries({})).toEqual([]);
  });
});

describe("cloudFormationFileToSummaries — file loading", () => {
  it("loads a JSON template from disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cfn-"));
    const file = path.join(tmp, "stack.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        Resources: {
          UsersApi: {
            Type: "AWS::ApiGateway::RestApi",
            Properties: { Body: inlineOpenApi },
          },
        },
      }),
    );
    try {
      const summaries = cloudFormationFileToSummaries(file);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].identity.name).toBe("getUser");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("loads a YAML template from disk (AWS SAM-style)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cfn-"));
    const file = path.join(tmp, "template.yaml");
    fs.writeFileSync(
      file,
      `Resources:
  PingApi:
    Type: AWS::Serverless::Api
    Properties:
      DefinitionBody:
        openapi: 3.0.3
        paths:
          /ping:
            get:
              operationId: ping
              responses:
                '200':
                  description: ok
`,
    );
    try {
      const summaries = cloudFormationFileToSummaries(file);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].identity.boundaryBinding?.path).toBe("/ping");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("throws when the file is missing", () => {
    expect(() =>
      cloudFormationFileToSummaries("/no/such/template.yaml"),
    ).toThrow(/not found/);
  });

  it("throws when the parsed value isn't an object", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cfn-"));
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, JSON.stringify("just-a-string"));
    try {
      expect(() => cloudFormationFileToSummaries(file)).toThrow(
        /not an object/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});
