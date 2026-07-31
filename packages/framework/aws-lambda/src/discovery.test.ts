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
  PostsFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/posts.handler
  BothFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/both.handler
      Events:
        Get:
          Type: HttpApi
          Properties: { Method: GET, Path: /both }
  QueueFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/queued.handler
      Events:
        Queue:
          Type: SQS
          Properties: { Queue: arn:aws:sqs:us-east-1:1:q }
  Api:
    Type: AWS::Serverless::GraphQLApi
    Properties:
      SchemaInline: |
        type Query { posts: String }
      DataSources:
        Lambda:
          Posts:
            FunctionArn: !GetAtt PostsFn.Arn
          Both:
            FunctionArn: !GetAtt BothFn.Arn
          Queued:
            FunctionArn: !GetAtt QueueFn.Arn
      Functions:
        InvokePosts:
          DataSource: Posts
        InvokeBoth:
          DataSource: Both
        InvokeQueued:
          DataSource: Queued
      Resolvers:
        User:
          profileState:
            Runtime:
              Name: APPSYNC_JS
              Version: "1.0.0"
            Pipeline:
              - InvokeQueued
        Query:
          posts:
            Pipeline:
              - InvokePosts
          both:
            Pipeline:
              - InvokeBoth
          queued:
            Pipeline:
              - InvokeQueued
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
  write(
    "src/both.ts",
    `export const handler = async () => ({ statusCode: 200, body: "" });`,
  );
  write("src/queued.ts", "export const handler = async () => ({ ok: true });");
  write(
    "src/posts.ts",
    `export const handler = async (event: { arguments?: { id?: string } }) => {
       if (!event.arguments?.id) {
         throw new Error("id is required");
       }
       return { id: event.arguments.id };
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

describe("awsLambdaDiscovery — AppSync resolvers", () => {
  it("binds a handler to the GraphQL field the template routes to it", async () => {
    const summaries = await run();
    const posts = summaries.find((s) => s.identity.name.startsWith("PostsFn."));

    // The semantics are what pair: boundaryKey reads a
    // graphql-resolver binding as gql:Type.field and ignores transport,
    // so this matches the same field read from an AppSync template.
    expect(posts?.identity.boundaryBinding?.semantics).toEqual({
      name: "graphql-resolver",
      typeName: "Query",
      fieldName: "posts",
    });
    expect(posts?.identity.boundaryBinding?.recognition).toBe("aws-lambda");
  });

  it("reads the resolver's behavior, not only its identity", async () => {
    const summaries = await run();
    const posts = summaries.find((s) => s.identity.name.startsWith("PostsFn."));

    const outputs = (posts?.transitions ?? []).map((t) => t.output.type);
    expect(outputs).toContain("throw");
  });

  it("leaves a handler no resolver points at unbound", async () => {
    const summaries = await run();
    const anyOnly = summaries.find((s) =>
      s.identity.name.startsWith("AnyOnlyFn."),
    );

    expect(anyOnly?.identity.boundaryBinding?.semantics.name).toBe(
      "function-call",
    );
  });
});

describe("awsLambdaDiscovery — a handler on two boundaries", () => {
  it("keeps both the route and the field when a handler serves both", async () => {
    const summaries = await run();
    const both = summaries.filter((s) => s.identity.name.startsWith("BothFn."));
    const names = both
      .map((s) => s.identity.boundaryBinding?.semantics.name)
      .sort();

    expect(names).toEqual(["graphql-resolver", "rest"]);
  });

  it("still reports the queue a resolver-backed handler also consumes", async () => {
    const summaries = await run();
    const queued = summaries.filter((s) =>
      s.identity.name.startsWith("QueueFn."),
    );
    const kinds = queued.map((s) => s.identity.boundaryBinding?.semantics.name);

    // The SQS event was reported before this handler also became a
    // resolver, and it has to keep being reported.
    expect(kinds).toContain("graphql-resolver");
    expect(kinds).toContain("function-call");
  });
});

describe("awsLambdaDiscovery — fields on a non-root type", () => {
  it("does not treat a type field as an operation a client can call", async () => {
    const summaries = await run();
    const queued = summaries.filter((s) =>
      s.identity.name.startsWith("QueueFn."),
    );
    const fields = queued
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter((sem) => sem?.name === "graphql-resolver")
      .map((sem) => (sem as { typeName: string }).typeName);

    // Query.queued is an operation. User.profileState is a field that
    // resolves while a parent does, and no operation names it.
    expect(fields).toEqual(["Query"]);
  });

  it("records the type field the handler backs", async () => {
    const summaries = await run();
    const accounting = summaries.find(
      (s) =>
        s.identity.name.startsWith("QueueFn.") &&
        s.identity.boundaryBinding?.semantics.name === "function-call",
    );
    const meta = accounting?.metadata?.awsLambda as
      | { graphqlTypeFields?: Array<{ typeName: string; fieldName: string }> }
      | undefined;

    expect(meta?.graphqlTypeFields).toEqual([
      { typeName: "User", fieldName: "profileState" },
    ]);
  });
});
