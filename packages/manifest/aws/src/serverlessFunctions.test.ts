import { describe, expect, it } from "vitest";

import {
  parseHandler,
  readServerlessFunctions,
} from "./serverlessFunctions.js";

import type { CloudFormationTemplate } from "./templateLoader.js";

describe("parseHandler", () => {
  it("splits module path from export on the final dot", () => {
    expect(parseHandler("src/handlers/confirmToken.handler")).toEqual({
      modulePath: "src/handlers/confirmToken",
      exportName: "handler",
    });
  });

  it("returns null when there is no export segment", () => {
    expect(parseHandler("indexfile")).toBeNull();
    expect(parseHandler("trailing.")).toBeNull();
  });
});

describe("readServerlessFunctions", () => {
  const template: CloudFormationTemplate = {
    Globals: { Function: { CodeUri: "./service" } },
    Resources: {
      ItemFn: {
        Type: "AWS::Serverless::Function",
        Properties: {
          Handler: "src/handlers/item.handler",
          Events: {
            Get: {
              Type: "HttpApi",
              Properties: { Method: "get", Path: "/items/{id}" },
            },
            Remove: {
              Type: "HttpApi",
              Properties: { Method: "DELETE", Path: "/items/{id}" },
            },
          },
        },
      },
      WorkerFn: {
        Type: "AWS::Serverless::Function",
        Properties: {
          Handler: "src/handlers/worker.handler",
          CodeUri: "workers/",
          Events: {
            Jobs: { Type: "SQS", Properties: { Queue: { Ref: "JobsQueue" } } },
          },
        },
      },
      NotAFunction: { Type: "AWS::SQS::Queue" },
    },
  };

  it("reads each function's handler, module, and export", () => {
    const fns = readServerlessFunctions(template);
    const item = fns.find((f) => f.logicalId === "ItemFn");
    expect(item?.modulePath).toBe("src/handlers/item");
    expect(item?.exportName).toBe("handler");
  });

  it("inherits CodeUri from Globals, else the function-level override", () => {
    const fns = readServerlessFunctions(template);
    expect(fns.find((f) => f.logicalId === "ItemFn")?.codeUri).toBe("service");
    expect(fns.find((f) => f.logicalId === "WorkerFn")?.codeUri).toBe(
      "workers",
    );
  });

  it("normalizes HTTP route methods and keeps path templating", () => {
    const item = readServerlessFunctions(template).find(
      (f) => f.logicalId === "ItemFn",
    );
    expect(item?.httpRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /items/{id}",
      "DELETE /items/{id}",
    ]);
  });

  it("classifies non-route Events as non-HTTP accounting entries", () => {
    const worker = readServerlessFunctions(template).find(
      (f) => f.logicalId === "WorkerFn",
    );
    expect(worker?.httpRoutes).toEqual([]);
    expect(worker?.nonHttpEvents).toEqual([
      { eventId: "Jobs", eventType: "SQS" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// implementingHandler threading through the API Gateway route summaries
// ---------------------------------------------------------------------------
