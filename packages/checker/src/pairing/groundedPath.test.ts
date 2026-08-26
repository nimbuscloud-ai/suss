import { describe, expect, it } from "vitest";

import { restBinding, runtimeConfigBinding } from "@suss/behavioral-ir";

import { pairSummaries } from "./pairing.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** The service the proxy forwards to, mounted at a path of its own. */
function backend(path: string): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "backend/src/server.ts",
      range: { start: 1, end: 10 },
      exportName: "getOrders",
    },
    identity: {
      name: "getOrders",
      exportPath: ["getOrders"],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "express",
        method: "GET",
        path,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** The route handler that forwards, with its base URL still a hole. */
function forwarder(path: string): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "app/api/orders/route.ts",
      range: { start: 1, end: 10 },
      exportName: "GET",
    },
    identity: {
      name: "GET",
      exportPath: ["GET"],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "fetch",
        method: "GET",
        path,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

/** What the deployment sets, for the code it runs. */
function runtime(values: Record<string, string>): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "wrangler.toml",
      range: { start: 1, end: 5 },
      exportName: null,
    },
    identity: {
      name: "admin-proxy",
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "wrangler",
        deploymentTarget: "worker",
        instanceName: "admin-proxy",
      }),
      deployableUnit: {
        deploymentTarget: "worker" as const,
        instanceName: "admin-proxy",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: Object.keys(values),
        envVarValues: values,
      },
      // The code this runtime runs: the forwarder lives under it.
      codeScope: { kind: "codeUri" as const, path: "app" },
    },
  };
}

const pairedKeys = (summaries: BehavioralSummary[]): string[] =>
  pairSummaries(summaries).pairs.map((pair) => pair.key);

describe("a consumer whose base URL the deployment fills in", () => {
  it("pairs with the service it reaches when the base is an origin", () => {
    // An app forwarding to another service writes the call with the
    // base URL in a variable. Both sides are here and neither says the
    // same string, so nothing paired before this.
    const keys = pairedKeys([
      backend("/orders"),
      forwarder("{API_BASE}/orders"),
      runtime({ API_BASE: "http://backend.internal" }),
    ]);

    expect(keys).toContain("GET {API_BASE}/orders");
  });

  it("reaches a different path when the base is a path prefix", () => {
    // The source cannot tell these two apart, which is why the adapter
    // leaves the hole in. `/api/v2` puts the call at `/api/v2/orders`,
    // and a service at `/orders` is not the one it reaches.
    const keys = pairedKeys([
      backend("/orders"),
      forwarder("{API_BASE}/orders"),
      runtime({ API_BASE: "/api/v2" }),
    ]);

    expect(keys).toHaveLength(0);
  });

  it("pairs with the service mounted under that prefix", () => {
    const keys = pairedKeys([
      backend("/api/v2/orders"),
      forwarder("{API_BASE}/orders"),
      runtime({ API_BASE: "/api/v2" }),
    ]);

    expect(keys).toHaveLength(1);
  });

  it("leaves the path alone when no runtime sets the variable", () => {
    const keys = pairedKeys([
      backend("/orders"),
      forwarder("{API_BASE}/orders"),
    ]);

    expect(keys).toHaveLength(0);
  });

  it("reads the variable through the way the source spells it", () => {
    const keys = pairedKeys([
      backend("/orders"),
      forwarder("{env.API_BASE}/orders"),
      runtime({ API_BASE: "http://backend.internal" }),
    ]);

    expect(keys).toContain("GET {env.API_BASE}/orders");
  });

  it("leaves a path whose hole is not at the front alone", () => {
    // `/orders/{id}` is a route parameter, not a base URL, and
    // substituting a deployed value into it would be wrong.
    const keys = pairedKeys([
      backend("/orders/{id}"),
      forwarder("/orders/{id}"),
      runtime({ id: "http://backend.internal" }),
    ]);

    expect(keys).toEqual(["GET /orders/{id}"]);
  });
});
