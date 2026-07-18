import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { awsLambdaFramework, clearTemplateCache } from "./index.js";
import { handlersForFile } from "./templateIndex.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// A SAM service written to a temp dir, exercising the edge branches the
// main fixture doesn't: an ANY route mixed with a bindable one, an
// ANY-only function, and a template that names an export the file
// doesn't provide.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-lambda-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write(
    "template.yaml",
    `
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    CodeUri: .
Resources:
  Gateway:
    Type: AWS::Serverless::HttpApi
  OkFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/ok.handler
      Events:
        Get:
          Type: HttpApi
          Properties: { Method: GET, Path: /ok }
        Any:
          Type: HttpApi
          Properties: { Method: ANY, Path: /ok/any }
  AnyOnlyFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/anyOnly.handler
      Events:
        Any:
          Type: HttpApi
          Properties: { Method: ANY, Path: /catchall }
  GhostFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/ghost.handler
      Events:
        Get:
          Type: HttpApi
          Properties: { Method: GET, Path: /ghost }
`,
  );
  write(
    "src/ok.ts",
    `import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
     export const handler: APIGatewayProxyHandlerV2 = async () => {
       return { statusCode: 200, body: JSON.stringify({ ok: true }) };
     };`,
  );
  write(
    "src/anyOnly.ts",
    `import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
     export const handler: APIGatewayProxyHandlerV2 = async () => {
       return { statusCode: 200, body: "" };
     };`,
  );
  // The template names `handler`, but this file exports something else.
  write(
    "src/ghost.ts",
    `import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
     export const notTheHandler: APIGatewayProxyHandlerV2 = async () => {
       return { statusCode: 200, body: "" };
     };`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(): Promise<BehavioralSummary[]> {
  clearTemplateCache();
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99,
      module: 99,
      moduleResolution: 100,
      skipLibCheck: true,
    },
  });
  project.addSourceFilesAtPaths(path.join(root, "src/*.ts"));
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [awsLambdaFramework()],
  });
  return await adapter.extractAll();
}

describe("awsLambdaDiscovery — edge cases", () => {
  it("binds concrete-method routes and skips ANY on a mixed function", async () => {
    const summaries = await run();
    const ok = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/ok",
    );
    expect(ok).toBeDefined();
    // The ANY route is not emitted as a REST binding.
    const anyRoute = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/ok/any",
    );
    expect(anyRoute).toBeUndefined();
  });

  it("accounts for an ANY-only function as recognized-not-http", async () => {
    const summaries = await run();
    const anyOnly = summaries.find((s) => {
      const meta = s.metadata?.awsLambda as
        | { functionLogicalId?: string; recognition?: string }
        | undefined;
      return meta?.functionLogicalId === "AnyOnlyFn";
    });
    expect(anyOnly).toBeDefined();
    const meta = (anyOnly as BehavioralSummary).metadata?.awsLambda as {
      recognition: string;
      eventTypes: string[];
    };
    expect(meta.recognition).toBe("recognized-not-http");
    expect(meta.eventTypes).toContain("HttpApi");
  });

  it("skips a template handler whose export the file doesn't provide", async () => {
    const summaries = await run();
    const ghost = summaries.find((s) => {
      const meta = s.metadata?.awsLambda as
        | { functionLogicalId?: string }
        | undefined;
      return meta?.functionLogicalId === "GhostFn";
    });
    expect(ghost).toBeUndefined();
  });
});

describe("handlersForFile — no reachable template", () => {
  it("returns an empty list when no template sits above the file", () => {
    clearTemplateCache();
    const orphan = path.join(
      os.tmpdir(),
      "suss-lambda-none",
      "deep",
      "handler.ts",
    );
    expect(handlersForFile(orphan)).toEqual([]);
  });

  it("surfaces a malformed template as an empty index, not a throw", () => {
    clearTemplateCache();
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suss-lambda-bad-"));
    fs.writeFileSync(
      path.join(badRoot, "template.yaml"),
      "just a bare scalar, not a mapping",
    );
    try {
      expect(handlersForFile(path.join(badRoot, "src/x.ts"))).toEqual([]);
    } finally {
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  });
});
