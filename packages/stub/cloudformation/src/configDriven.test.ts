import { describe, expect, it } from "vitest";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary, Output } from "@suss/behavioral-ir";

function statusFromOutput(output: Output): number | null {
  if (output.type !== "response" || output.statusCode === null) {
    return null;
  }
  if (output.statusCode.type !== "literal") {
    return null;
  }
  const v = output.statusCode.value;
  return typeof v === "number" ? v : null;
}

function restOf(
  summary: BehavioralSummary,
): { method: string; path: string } | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? { method: s.method, path: s.path } : null;
}

function statusesFor(
  summaries: ReturnType<typeof cloudFormationToSummaries>,
  match: { method: string; path: string },
): number[] {
  const summary = summaries.find((s) => {
    const rest = restOf(s);
    return rest?.method === match.method && rest.path === match.path;
  });
  if (summary === undefined) {
    return [];
  }
  return summary.transitions
    .map((t) => statusFromOutput(t.output))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
}

describe("CFN-native REST: integration extraction", () => {
  it("AWS_PROXY integration adds 502 + 504 alongside MethodResponses statuses", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "x" } },
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "users", ParentId: { Ref: "Api" } },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            Integration: { Type: "AWS_PROXY" },
            MethodResponses: [{ StatusCode: 200 }, { StatusCode: 404 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "GET", path: "/users" })).toEqual([
      200, 404, 502, 504,
    ]);
  });

  it("MOCK integration suppresses 502 + 504", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi", Properties: { Name: "x" } },
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "ping", ParentId: { Ref: "Api" } },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "GET", path: "/ping" })).toEqual([
      200,
    ]);
  });

  it("absent Integration leaves type 'unknown' so no 502/504 are fabricated", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "p" },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "GET", path: "/p" })).toEqual([
      200,
    ]);
  });
});

describe("CFN-native REST: authorization", () => {
  it("AWS_IAM authorization adds 401 + 403", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        R: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "p" },
        },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "POST",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            AuthorizationType: "AWS_IAM",
            Integration: { Type: "AWS_PROXY" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "POST", path: "/p" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });

  it("COGNITO_USER_POOLS authorization adds 401 + 403", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        R: { Type: "AWS::ApiGateway::Resource", Properties: { PathPart: "p" } },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            AuthorizationType: "COGNITO_USER_POOLS",
            Integration: { Type: "AWS_PROXY" },
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "GET", path: "/p" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });

  it("CUSTOM authorization with REQUEST authorizer maps to lambda-request", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        Auth: {
          Type: "AWS::ApiGateway::Authorizer",
          Properties: { Type: "REQUEST" },
        },
        R: { Type: "AWS::ApiGateway::Resource", Properties: { PathPart: "p" } },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            AuthorizationType: "CUSTOM",
            AuthorizerId: { Ref: "Auth" },
            Integration: { Type: "AWS_PROXY" },
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "GET", path: "/p" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });

  it("AuthorizationType=NONE doesn't add auth status codes", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        R: { Type: "AWS::ApiGateway::Resource", Properties: { PathPart: "p" } },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            AuthorizationType: "NONE",
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "GET", path: "/p" })).toEqual([
      200,
    ]);
  });
});

describe("CFN-native REST: api key + request validator", () => {
  it("ApiKeyRequired adds 403", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        R: { Type: "AWS::ApiGateway::Resource", Properties: { PathPart: "p" } },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            ApiKeyRequired: true,
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "GET", path: "/p" })).toContain(
      403,
    );
  });

  it("RequestValidatorId adds 400", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        Validator: {
          Type: "AWS::ApiGateway::RequestValidator",
          Properties: { ValidateRequestBody: true },
        },
        R: { Type: "AWS::ApiGateway::Resource", Properties: { PathPart: "p" } },
        M: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "POST",
            ResourceId: { Ref: "R" },
            RestApiId: { Ref: "Api" },
            RequestValidatorId: { Ref: "Validator" },
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
      },
    });
    expect(statusesFor(summaries, { method: "POST", path: "/p" })).toContain(
      400,
    );
  });
});

describe("CFN-native HTTP API: integration + auth extraction", () => {
  it("AWS_PROXY integration linked via Target adds 502 + 504", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGatewayV2::Api" },
        Integration1: {
          Type: "AWS::ApiGatewayV2::Integration",
          Properties: { ApiId: { Ref: "Api" }, IntegrationType: "AWS_PROXY" },
        },
        Route1: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: {
            ApiId: { Ref: "Api" },
            RouteKey: "GET /users",
            Target: "integrations/Integration1",
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "GET", path: "/users" });
    expect(codes).toContain(502);
    expect(codes).toContain(504);
  });

  it("JWT authorization adds 401 + 403", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGatewayV2::Api" },
        Auth: {
          Type: "AWS::ApiGatewayV2::Authorizer",
          Properties: { ApiId: { Ref: "Api" }, AuthorizerType: "JWT" },
        },
        Route1: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: {
            ApiId: { Ref: "Api" },
            RouteKey: "GET /users",
            AuthorizationType: "JWT",
            AuthorizerId: { Ref: "Auth" },
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "GET", path: "/users" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });

  it("AWS_IAM auth maps to iam authorizer", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGatewayV2::Api" },
        Route1: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: {
            ApiId: { Ref: "Api" },
            RouteKey: "POST /admin",
            AuthorizationType: "AWS_IAM",
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "POST", path: "/admin" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });

  it("CUSTOM auth maps to lambda-request", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGatewayV2::Api" },
        Route1: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: {
            ApiId: { Ref: "Api" },
            RouteKey: "POST /x",
            AuthorizationType: "CUSTOM",
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "POST", path: "/x" });
    expect(codes).toContain(401);
    expect(codes).toContain(403);
  });
});

describe("SAM Events block expansion", () => {
  it("AWS::Serverless::Function with Events.Api expands into REST endpoints", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        UsersFn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              GetUser: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "GET",
                  Path: "/users/{id}",
                },
              },
              CreateUser: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "POST",
                  Path: "/users",
                },
              },
            },
          },
        },
      },
    });
    // Each event becomes its own endpoint summary; lambda-proxy adds 502 + 504.
    const get = statusesFor(summaries, { method: "GET", path: "/users/{id}" });
    expect(get).toContain(502);
    expect(get).toContain(504);
    const post = statusesFor(summaries, { method: "POST", path: "/users" });
    expect(post).toContain(502);
  });

  it("AWS::Serverless::Function with Events.HttpApi expands into HTTP routes", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        HttpApi: { Type: "AWS::ApiGatewayV2::Api" },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              ListItems: {
                Type: "HttpApi",
                Properties: {
                  ApiId: { Ref: "HttpApi" },
                  Method: "GET",
                  Path: "/items",
                },
              },
            },
          },
        },
      },
    });
    const codes = statusesFor(summaries, { method: "GET", path: "/items" });
    expect(codes).toContain(502);
    expect(codes).toContain(504);
  });

  it("Events with Method=ANY are skipped (would explode into 7 verbs)", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: { Type: "AWS::ApiGateway::RestApi" },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              All: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "ANY",
                  Path: "/x",
                },
              },
            },
          },
        },
      },
    });
    // Runtime-config summaries from the Function resource are
    // expected; the assertion is specifically that no REST endpoint
    // summaries got synthesized for the ANY method.
    const restSummaries = summaries.filter(
      (s) => s.identity.boundaryBinding?.semantics.name === "rest",
    );
    expect(restSummaries).toHaveLength(0);
  });
});

describe("SAM CorsConfiguration", () => {
  it("REST API CorsConfiguration synthesizes OPTIONS preflight per path", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::Api",
          Properties: {
            CorsConfiguration: {
              AllowOrigins: ["https://app.example.com"],
              AllowMethods: ["GET", "POST"],
              AllowHeaders: ["X-Auth"],
              AllowCredentials: true,
              MaxAge: 600,
            },
          },
        },
        UsersFn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              GetUser: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "GET",
                  Path: "/users/{id}",
                },
              },
            },
          },
        },
      },
    });
    const optionsSummaries = summaries.filter(
      (s) => restOf(s)?.method === "OPTIONS",
    );
    expect(optionsSummaries).toHaveLength(1);
    expect(restOf(optionsSummaries[0])?.path).toBe("/users/{id}");
  });

  it("HTTP API CorsConfiguration synthesizes OPTIONS preflight", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::ApiGatewayV2::Api",
          Properties: {
            CorsConfiguration: {
              AllowOrigins: ["*"],
              AllowMethods: ["GET"],
            },
          },
        },
        Route1: {
          Type: "AWS::ApiGatewayV2::Route",
          Properties: {
            ApiId: { Ref: "Api" },
            RouteKey: "GET /items",
          },
        },
      },
    });
    const options = summaries.filter((s) => restOf(s)?.method === "OPTIONS");
    expect(options).toHaveLength(1);
    expect(restOf(options[0])?.path).toBe("/items");
  });

  it("CorsConfiguration as a bare string (single allowed origin)", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::Api",
          Properties: { CorsConfiguration: "https://only.example.com" },
        },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              E: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "GET",
                  Path: "/p",
                },
              },
            },
          },
        },
      },
    });
    const options = summaries.find((s) => restOf(s)?.method === "OPTIONS");
    expect(options).toBeDefined();
    if (options !== undefined) {
      const out = options.transitions[0].output;
      if (out.type !== "response") {
        throw new Error("expected response");
      }
      expect(out.headers["Access-Control-Allow-Origin"]).toEqual({
        type: "literal",
        value: "https://only.example.com",
      });
    }
  });

  it("malformed CorsConfiguration is ignored gracefully", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::Api",
          Properties: { CorsConfiguration: { Garbage: "value" } },
        },
        Fn: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Events: {
              E: {
                Type: "Api",
                Properties: {
                  RestApiId: { Ref: "Api" },
                  Method: "GET",
                  Path: "/p",
                },
              },
            },
          },
        },
      },
    });
    const options = summaries.filter((s) => restOf(s)?.method === "OPTIONS");
    expect(options).toHaveLength(0);
  });
});

describe("Multi-API templates", () => {
  it("groups Methods to their declared RestApiId", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ApiOne: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Name: "one" },
        },
        ApiTwo: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Name: "two" },
        },
        R1: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "a" },
        },
        R2: {
          Type: "AWS::ApiGateway::Resource",
          Properties: { PathPart: "b" },
        },
        M1: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "GET",
            ResourceId: { Ref: "R1" },
            RestApiId: { Ref: "ApiOne" },
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 200 }],
          },
        },
        M2: {
          Type: "AWS::ApiGateway::Method",
          Properties: {
            HttpMethod: "POST",
            ResourceId: { Ref: "R2" },
            RestApiId: { Ref: "ApiTwo" },
            Integration: { Type: "MOCK" },
            MethodResponses: [{ StatusCode: 201 }],
          },
        },
      },
    });
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.metadata?.apiId).sort()).toEqual([
      "ApiOne",
      "ApiTwo",
    ]);
  });
});
