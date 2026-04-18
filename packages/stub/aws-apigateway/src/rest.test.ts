import { describe, expect, it } from "vitest";

import {
  type RestApiConfig,
  type RestEndpointConfig,
  restApiToSummaries,
} from "./index.js";

import type { Output, Predicate } from "@suss/behavioral-ir";

function baseEndpoint(
  overrides: Partial<RestEndpointConfig> = {},
): RestEndpointConfig {
  return {
    method: "GET",
    path: "/users",
    integration: { type: "lambda-proxy", statusCodes: [200] },
    ...overrides,
  };
}

function api(overrides: Partial<RestApiConfig> = {}): RestApiConfig {
  return {
    id: "TestApi",
    endpoints: [baseEndpoint()],
    ...overrides,
  };
}

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

function statuses(summary: { transitions: { output: Output }[] }): number[] {
  return summary.transitions
    .map((t) => statusFromOutput(t.output))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
}

describe("restApiToSummaries — baseline", () => {
  it("emits one summary per endpoint with handler-attributed status codes", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({
            method: "GET",
            path: "/a",
            integration: { type: "lambda-proxy", statusCodes: [200, 404] },
          }),
          baseEndpoint({
            method: "POST",
            path: "/b",
            integration: { type: "lambda-proxy", statusCodes: [201] },
          }),
        ],
      }),
    );

    expect(summaries).toHaveLength(2);
    const get = summaries.find(
      (s) => s.identity.boundaryBinding?.path === "/a",
    );
    const post = summaries.find(
      (s) => s.identity.boundaryBinding?.path === "/b",
    );
    if (get === undefined || post === undefined) {
      throw new Error("expected both endpoints to be present");
    }
    expect(get.identity.boundaryBinding?.method).toBe("GET");
    expect(post.identity.boundaryBinding?.method).toBe("POST");
    // Mock integrations would suppress 502/504; lambda-proxy adds them.
    expect(statuses(get)).toEqual([200, 404, 502, 504]);
    expect(statuses(post)).toEqual([201, 502, 504]);
  });

  it("mock integrations don't add 502/504", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({ integration: { type: "mock", statusCodes: [200] } }),
        ],
      }),
    );
    expect(statuses(summaries[0])).toEqual([200]);
  });

  it("uses lambda-proxy integration source label on handler transitions", () => {
    const [summary] = restApiToSummaries(api());
    const handler = summary.transitions.find(
      (t) => statusFromOutput(t.output) === 200,
    );
    expect(handler?.metadata?.source).toBe(
      "aws::apigateway::integration.lambda-proxy",
    );
    expect(handler?.conditions).toEqual([]);
  });
});

describe("restApiToSummaries — authorizer", () => {
  it("adds 401 + 403 when an authorizer is configured", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({
            authorizer: { type: "cognito" },
          }),
        ],
      }),
    );
    expect(statuses(summaries[0])).toEqual([200, 401, 403, 502, 504]);
  });

  it("inherits API-level default authorizer", () => {
    const summaries = restApiToSummaries(
      api({
        defaultAuthorizer: { type: "iam" },
        endpoints: [baseEndpoint()],
      }),
    );
    expect(statuses(summaries[0])).toContain(401);
    expect(statuses(summaries[0])).toContain(403);
  });

  it("explicit null endpoint authorizer opts out of API default", () => {
    const summaries = restApiToSummaries(
      api({
        defaultAuthorizer: { type: "iam" },
        endpoints: [baseEndpoint({ authorizer: null })],
      }),
    );
    expect(statuses(summaries[0])).not.toContain(401);
    expect(statuses(summaries[0])).not.toContain(403);
  });

  it("identitySourceRequired=false suppresses 401 (anonymous bypass) but keeps 403", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({
            authorizer: { type: "iam", identitySourceRequired: false },
          }),
        ],
      }),
    );
    expect(statuses(summaries[0])).not.toContain(401);
    expect(statuses(summaries[0])).toContain(403);
  });
});

describe("restApiToSummaries — other knobs", () => {
  it("apiKeyRequired adds 403 (collapses with authorizer 403 if both)", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({
            apiKeyRequired: true,
            authorizer: { type: "iam" },
          }),
        ],
      }),
    );
    // Both authorizer and api-key produce 403; should be ONE 403 transition,
    // not two — that's the collapse rule that keeps the consumer from having
    // to disambiguate platform causes.
    const at403 = summaries[0].transitions.filter(
      (t) => statusFromOutput(t.output) === 403,
    );
    expect(at403).toHaveLength(1);
    expect(at403[0].metadata?.causes).toEqual(
      expect.arrayContaining(["authorization", "api-key"]),
    );
  });

  it("requestValidation adds 400 only when at least one check is on", () => {
    const off = restApiToSummaries(
      api({ endpoints: [baseEndpoint({ requestValidation: {} })] }),
    );
    expect(statuses(off[0])).not.toContain(400);

    const on = restApiToSummaries(
      api({
        endpoints: [baseEndpoint({ requestValidation: { body: true } })],
      }),
    );
    expect(statuses(on[0])).toContain(400);
  });

  it("throttle adds 429 only when a positive limit is set", () => {
    const zero = restApiToSummaries(
      api({
        endpoints: [
          baseEndpoint({ throttle: { burstLimit: 0, rateLimit: 0 } }),
        ],
      }),
    );
    expect(statuses(zero[0])).not.toContain(429);

    const positive = restApiToSummaries(
      api({
        endpoints: [baseEndpoint({ throttle: { rateLimit: 100 } })],
      }),
    );
    expect(statuses(positive[0])).toContain(429);
  });

  it("inherits API-level throttle when endpoint doesn't override", () => {
    const summaries = restApiToSummaries(
      api({
        defaultThrottle: { rateLimit: 50 },
        endpoints: [baseEndpoint()],
      }),
    );
    expect(statuses(summaries[0])).toContain(429);
  });
});

describe("restApiToSummaries — platform transition shape", () => {
  it("each platform transition carries a single opaque predicate", () => {
    const [summary] = restApiToSummaries(
      api({
        endpoints: [baseEndpoint({ authorizer: { type: "cognito" } })],
      }),
    );
    const platform = summary.transitions.filter(
      (t) =>
        statusFromOutput(t.output) === 401 ||
        statusFromOutput(t.output) === 403,
    );
    for (const t of platform) {
      expect(t.conditions).toHaveLength(1);
      const pred = t.conditions[0] as Predicate;
      expect(pred.type).toBe("opaque");
      if (pred.type === "opaque") {
        expect(pred.sourceText).toMatch(/^aws:apigateway:status-/);
      }
      expect(t.confidence?.source).toBe("stub");
      expect(t.metadata?.platform).toBe("apiGateway");
    }
  });
});

describe("restApiToSummaries — CORS", () => {
  it("emits a synthetic OPTIONS endpoint per unique path when CORS is configured", () => {
    const summaries = restApiToSummaries(
      api({
        cors: {
          allowOrigins: ["https://app.example.com"],
          allowMethods: ["GET", "POST"],
          allowHeaders: ["X-Auth"],
          allowCredentials: true,
          maxAge: 600,
        },
        endpoints: [
          baseEndpoint({ method: "GET", path: "/a" }),
          baseEndpoint({ method: "POST", path: "/a" }),
          baseEndpoint({ method: "GET", path: "/b" }),
        ],
      }),
    );

    const preflights = summaries.filter(
      (s) => s.identity.boundaryBinding?.method === "OPTIONS",
    );
    expect(
      preflights.map((p) => p.identity.boundaryBinding?.path).sort(),
    ).toEqual(["/a", "/b"]);

    const headers = preflights[0].transitions[0].output;
    if (headers.type !== "response") {
      throw new Error("expected response output");
    }
    expect(headers.statusCode).toEqual({ type: "literal", value: 204 });
    expect(headers.headers["Access-Control-Allow-Origin"]).toEqual({
      type: "literal",
      value: "https://app.example.com",
    });
    expect(headers.headers["Access-Control-Allow-Credentials"]).toEqual({
      type: "literal",
      value: "true",
    });
    expect(headers.headers["Access-Control-Max-Age"]).toEqual({
      type: "literal",
      value: "600",
    });
  });
});

describe("restApiToSummaries — identity & boundary", () => {
  it("uses endpoint.name as ownerKey when provided", () => {
    const summaries = restApiToSummaries(
      api({
        endpoints: [baseEndpoint({ name: "GetUsers" })],
      }),
    );
    expect(summaries[0].identity.name).toBe("GetUsers");
    expect(summaries[0].location.file).toContain(":GetUsers");
  });

  it("respects custom source label", () => {
    const summaries = restApiToSummaries(api({ source: "template.yaml" }));
    expect(summaries[0].location.file.startsWith("template.yaml:")).toBe(true);
  });
});
