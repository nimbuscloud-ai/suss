import { describe, expect, it } from "vitest";

import { restBinding, withHttpMetadata } from "@suss/behavioral-ir";

import { boundaryCollisions } from "./boundaryCollisions.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function route(
  name: string,
  file = `src/handlers/${name}.ts`,
): BehavioralSummary {
  return {
    kind: "handler",
    location: { file, range: { start: 1, end: 20 }, exportName: "handler" },
    identity: {
      name,
      exportPath: ["handler"],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "aws-lambda",
        method: "GET",
        path: "/orders",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function pointingAt(
  summary: BehavioralSummary,
  pointer: {
    functionLogicalId?: string;
    codeUri?: string;
    modulePath: string;
  },
): BehavioralSummary {
  return {
    ...summary,
    metadata: withHttpMetadata(summary.metadata, {
      implementingHandler: {
        handler: `${pointer.modulePath}.handler`,
        exportName: "handler",
        ...pointer,
      },
    }),
  };
}

describe("boundaryCollisions", () => {
  it("lists a key two files both provide", () => {
    expect(
      boundaryCollisions([
        { summary: route("listOrders"), file: "orders.json" },
        { summary: route("listOrders"), file: "billing.json" },
      ]),
    ).toEqual([
      {
        key: "GET /orders",
        files: ["billing.json", "orders.json"],
        services: [],
      },
    ]);
  });

  it("lists the services the claiming summaries say they came from", () => {
    const inService = (workspace: string): BehavioralSummary => {
      const summary = route("listOrders");
      return { ...summary, location: { ...summary.location, workspace } };
    };
    expect(
      boundaryCollisions([
        { summary: inService("orders"), file: "orders.json" },
        { summary: inService("billing"), file: "billing.json" },
      ]),
    ).toEqual([
      {
        key: "GET /orders",
        files: ["billing.json", "orders.json"],
        services: ["billing", "orders"],
      },
    ]);
  });

  it("stays quiet when one file provides the key twice", () => {
    expect(
      boundaryCollisions([
        { summary: route("a"), file: "orders.json" },
        { summary: route("b"), file: "orders.json" },
      ]),
    ).toEqual([]);
  });

  it("counts a template route and the handler with its logical id as one claim", () => {
    const code = {
      ...route("ListOrdersFunction.handler"),
      identity: {
        ...route("ListOrdersFunction.handler").identity,
        deployableUnit: {
          deploymentTarget: "lambda" as const,
          instanceName: "ListOrdersFunction",
        },
      },
    };
    const template = pointingAt(route("ListOrdersFunction:Get"), {
      functionLogicalId: "ListOrdersFunction",
      modulePath: "elsewhere/listOrders",
    });
    expect(
      boundaryCollisions([
        { summary: code, file: "0-extract.json" },
        { summary: template, file: "1-contract.json" },
      ]),
    ).toEqual([]);
  });

  it("counts a template route and the module its CodeUri and handler path point at as one claim", () => {
    const template = pointingAt(route("ListOrdersFunction:Get"), {
      codeUri: "./src/",
      modulePath: "handlers/listOrders",
    });
    expect(
      boundaryCollisions([
        {
          summary: route("listOrders", "src/handlers/listOrders.ts"),
          file: "0-extract.json",
        },
        { summary: template, file: "1-contract.json" },
      ]),
    ).toEqual([]);
  });

  it("keeps a template route that points at code neither file has as a second claim", () => {
    const template = pointingAt(route("ReportJob:Get"), {
      functionLogicalId: "ReportJob",
      modulePath: "jobs/report",
    });
    expect(
      boundaryCollisions([
        { summary: route("listOrders"), file: "0-extract.json" },
        { summary: template, file: "1-contract.json" },
      ]),
    ).toEqual([
      {
        key: "GET /orders",
        files: ["0-extract.json", "1-contract.json"],
        services: [],
      },
    ]);
  });
});
