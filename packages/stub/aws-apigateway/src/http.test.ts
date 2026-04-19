import { describe, expect, it } from "vitest";

import {
  type HttpApiConfig,
  type HttpRouteConfig,
  httpApiToSummaries,
} from "./index.js";

import type { BehavioralSummary, Output } from "@suss/behavioral-ir";

function restMethodOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.method : null;
}

function restPathOf(summary: BehavioralSummary): string | null {
  const s = summary.identity.boundaryBinding?.semantics;
  return s?.name === "rest" ? s.path : null;
}

function baseRoute(overrides: Partial<HttpRouteConfig> = {}): HttpRouteConfig {
  return {
    routeKey: "GET /users",
    integration: { type: "lambda-proxy", statusCodes: [200] },
    ...overrides,
  };
}

function api(overrides: Partial<HttpApiConfig> = {}): HttpApiConfig {
  return {
    id: "TestHttpApi",
    routes: [baseRoute()],
    ...overrides,
  };
}

function statuses(summary: { transitions: { output: Output }[] }): number[] {
  return summary.transitions
    .map((t) => {
      if (
        t.output.type !== "response" ||
        t.output.statusCode === null ||
        t.output.statusCode.type !== "literal"
      ) {
        return null;
      }
      const v = t.output.statusCode.value;
      return typeof v === "number" ? v : null;
    })
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
}

describe("httpApiToSummaries", () => {
  it("parses route keys into method + path and emits one summary per route", () => {
    const summaries = httpApiToSummaries(
      api({
        routes: [
          baseRoute({ routeKey: "GET /users" }),
          baseRoute({ routeKey: "POST /users" }),
        ],
      }),
    );
    expect(summaries).toHaveLength(2);
    expect(restMethodOf(summaries[0])).toBe("GET");
    expect(restMethodOf(summaries[1])).toBe("POST");
  });

  it("skips $default and malformed route keys", () => {
    const summaries = httpApiToSummaries(
      api({
        routes: [
          baseRoute({ routeKey: "$default" }),
          baseRoute({ routeKey: "malformed" }),
          baseRoute({ routeKey: "GET /ok" }),
        ],
      }),
    );
    expect(summaries).toHaveLength(1);
    expect(restPathOf(summaries[0])).toBe("/ok");
  });

  it("adds 401 + 403 + 502 + 504 with a JWT authorizer", () => {
    const summaries = httpApiToSummaries(
      api({
        routes: [baseRoute({ authorizer: { type: "jwt" } })],
      }),
    );
    expect(statuses(summaries[0])).toEqual([200, 401, 403, 502, 504]);
  });

  it("inherits API-level default authorizer", () => {
    const summaries = httpApiToSummaries(
      api({
        defaultAuthorizer: { type: "jwt" },
        routes: [baseRoute()],
      }),
    );
    expect(statuses(summaries[0])).toContain(401);
    expect(statuses(summaries[0])).toContain(403);
  });

  it("explicit null route authorizer opts out of inherited default", () => {
    const summaries = httpApiToSummaries(
      api({
        defaultAuthorizer: { type: "jwt" },
        routes: [baseRoute({ authorizer: null })],
      }),
    );
    expect(statuses(summaries[0])).not.toContain(401);
    expect(statuses(summaries[0])).not.toContain(403);
  });

  it("API-level throttle adds 429", () => {
    const summaries = httpApiToSummaries(
      api({
        defaultThrottle: { rateLimit: 100 },
        routes: [baseRoute()],
      }),
    );
    expect(statuses(summaries[0])).toContain(429);
  });

  it("emits CORS preflight per unique path", () => {
    const summaries = httpApiToSummaries(
      api({
        cors: {
          allowOrigins: ["*"],
          allowMethods: ["GET"],
        },
        routes: [
          baseRoute({ routeKey: "GET /users" }),
          baseRoute({ routeKey: "POST /users" }),
          baseRoute({ routeKey: "GET /admin" }),
        ],
      }),
    );
    const preflights = summaries.filter((s) => restMethodOf(s) === "OPTIONS");
    expect(preflights.map((p) => restPathOf(p)).sort()).toEqual([
      "/admin",
      "/users",
    ]);
  });

  it("identitySourceRequired=false suppresses 401", () => {
    const summaries = httpApiToSummaries(
      api({
        routes: [
          baseRoute({
            authorizer: { type: "jwt", identitySourceRequired: false },
          }),
        ],
      }),
    );
    expect(statuses(summaries[0])).not.toContain(401);
    expect(statuses(summaries[0])).toContain(403);
  });

  it("mock integration suppresses 502/504", () => {
    const summaries = httpApiToSummaries(
      api({
        routes: [
          baseRoute({ integration: { type: "mock", statusCodes: [200] } }),
        ],
      }),
    );
    expect(statuses(summaries[0])).toEqual([200]);
  });

  it("CORS preflight headers include allow-headers and credentials when set", () => {
    const summaries = httpApiToSummaries(
      api({
        cors: {
          allowOrigins: ["https://x.test"],
          allowMethods: ["GET"],
          allowHeaders: ["X-Auth"],
          exposeHeaders: ["X-Trace"],
          allowCredentials: true,
          maxAge: 300,
        },
        routes: [baseRoute()],
      }),
    );
    const preflight = summaries.find((s) => restMethodOf(s) === "OPTIONS");
    if (preflight === undefined) {
      throw new Error("expected preflight");
    }
    const out = preflight.transitions[0].output;
    if (out.type !== "response") {
      throw new Error("expected response");
    }
    expect(out.headers["Access-Control-Allow-Headers"]).toBeDefined();
    expect(out.headers["Access-Control-Expose-Headers"]).toBeDefined();
    expect(out.headers["Access-Control-Allow-Credentials"]).toBeDefined();
    expect(out.headers["Access-Control-Max-Age"]).toBeDefined();
  });

  it("uses route.name as ownerKey when provided", () => {
    const summaries = httpApiToSummaries(
      api({ routes: [baseRoute({ name: "ListUsers" })] }),
    );
    expect(summaries[0].identity.name).toBe("ListUsers");
  });
});
