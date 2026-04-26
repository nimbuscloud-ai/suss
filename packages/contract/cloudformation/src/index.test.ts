import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function restPathOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.path : null;
}

function restMethodOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.method : null;
}

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
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/{id}" },
      recognition: "openapi",
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

// ---------------------------------------------------------------------------
// CFN-native walks: AWS::ApiGateway::Method (REST)
// ---------------------------------------------------------------------------

describe("cloudFormationToSummaries — AWS::ApiGateway::Method", () => {
  it("resolves a method's path by walking ParentId chain through Resource entries", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Name: "petstore" },
        },
        PetsResource: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "pets", ParentId: { Ref: "Api" } },
        },
        PetIdResource: {
          Type: "AWS::ApiGateway::Resource",
          Properties: {
            PathPart: "{petId}",
            ParentId: { Ref: "PetsResource" },
          },
        },
        GetPetMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "PetIdResource" },
            MethodResponses: [{ StatusCode: 200 }, { StatusCode: 404 }],
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.kind).toBe("handler");
    expect(s.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/pets/{petId}" },
      recognition: "apigateway",
    });
    const codes = s.transitions
      .map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      )
      .sort();
    expect(codes).toEqual([200, 404]);
  });

  it("falls back to a single default transition when MethodResponses is absent", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        PingResource: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "ping" },
        },
        PingMethod: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "PingResource" },
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].transitions).toHaveLength(1);
    expect(summaries[0].transitions[0].isDefault).toBe(true);
  });

  it("accepts string status codes ('200') alongside numeric ones", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "x" },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "POST",
            ResourceId: { Ref: "R" },
            MethodResponses: [{ StatusCode: "201" }, { StatusCode: 422 }],
          },
        },
      },
    });
    const codes = summaries[0].transitions
      .map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      )
      .sort();
    expect(codes).toEqual([201, 422]);
  });

  it("skips methods with HttpMethod=ANY (would explode into 7 verbs)", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "x" },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: { HttpMethod: "ANY", ResourceId: { Ref: "R" } },
        },
      },
    });
    expect(summaries).toEqual([]);
  });

  it("falls back to '/' when ResourceId can't be resolved", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: { HttpMethod: "GET" },
        },
      },
    });
    expect(restPathOf(summaries[0])).toBe("/");
  });

  it("recognises Fn::GetAtt references in ResourceId", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Name: "x" },
        },
        Root: {
          Type: "AWS::ApiGateway::Resource",
          Properties: {
            PathPart: "x",
            ParentId: { "Fn::GetAtt": ["Api", "RootResourceId"] },
          },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { "Fn::GetAtt": ["Root", "Id"] },
          },
        },
      },
    });
    expect(restPathOf(summaries[0])).toBe("/x");
  });

  it("accepts a bare-string ResourceId (parsers that drop the !Ref tag)", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "y" },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: { HttpMethod: "GET", ResourceId: "R" },
        },
      },
    });
    expect(restPathOf(summaries[0])).toBe("/y");
  });
});

// ---------------------------------------------------------------------------
// CFN-native walks: AWS::ApiGatewayV2::Route (HTTP API)
// ---------------------------------------------------------------------------

describe("cloudFormationToSummaries — AWS::ApiGatewayV2::Route", () => {
  it("parses RouteKey 'METHOD path' into a boundary binding", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        GetPetRoute: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { RouteKey: "GET /pets/{petId}" },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/pets/{petId}" },
      recognition: "apigateway",
    });
    expect(summaries[0].transitions[0].isDefault).toBe(true);
  });

  it("skips $default routes and malformed RouteKeys", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Default: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { RouteKey: "$default" },
        },
        Empty: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { RouteKey: "" },
        },
        NoSpace: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: { RouteKey: "GETBADKEY" },
        },
      },
    });
    expect(summaries).toEqual([]);
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
      expect(restPathOf(summaries[0])).toBe("/ping");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("understands CloudFormation YAML intrinsic shorthand (!Ref / !GetAtt / !Sub)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cfn-"));
    const file = path.join(tmp, "template.yaml");
    fs.writeFileSync(
      file,
      `Resources:
  Api:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Name: !Sub "petstore"
  PetsResource:
    Type: AWS::ApiGateway::Resource
    Properties:
      PathPart: pets
      ParentId: !GetAtt Api.RootResourceId
  GetPets:
    Type: AWS::ApiGateway::Method
    Properties:
      HttpMethod: GET
      ResourceId: !Ref PetsResource
      MethodResponses:
        - StatusCode: 200
`,
    );
    try {
      const summaries = cloudFormationFileToSummaries(file);
      expect(summaries).toHaveLength(1);
      expect(restPathOf(summaries[0])).toBe("/pets");
      expect(restMethodOf(summaries[0])).toBe("GET");
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
