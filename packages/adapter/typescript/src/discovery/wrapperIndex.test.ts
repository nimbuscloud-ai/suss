/**
 * wrapperIndex.test.ts, end to end through createTypeScriptAdapter: a
 * wrapper registered on an app becomes a summary of its own, and every
 * route on that app points at it, whether it is written in the same
 * file or imported from another one.
 */

import { describe, expect, it } from "vitest";

import { readWrapperMetadata } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary, WrapperMetadata } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

// Same shape @suss/framework-express ships, minus the terminals this
// test doesn't need.
const expressLikePack: PatternPack = {
  name: "express",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "express",
        importName: "express",
        registrationChain: [".get", ".post"],
      },
      bindingExtraction: {
        method: { type: "fromRegistration", position: "methodName" },
        path: { type: "fromArgument", position: 0 },
      },
      mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
      requiresImport: ["express"],
    },
    {
      kind: "middleware",
      match: {
        type: "registrationCall",
        importModule: "express",
        importName: "express",
        registrationChain: [],
      },
      wraps: { method: "use", targetPosition: 0, continuationParam: 2 },
      requiresImport: ["express"],
    },
    {
      kind: "middleware",
      match: {
        type: "registrationCall",
        importModule: "express",
        importName: "express",
        registrationChain: [],
      },
      wraps: {
        method: "use",
        targetPosition: 0,
        continuationParam: 3,
        throwParam: 0,
        arity: 4,
      },
      requiresImport: ["express"],
    },
  ],
  terminals: [
    {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition: 1,
        methodChain: ["status", "json"],
      },
      extraction: {
        statusCode: { from: "argument", position: 0 },
        body: { from: "argument", position: 0 },
      },
    },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [
      { position: 0, role: "request" },
      { position: 1, role: "response" },
    ],
  },
};

// A second pack whose routable is built by a different constructor, so
// an Express `.use` has nothing of its to wrap.
const honoLikePack: PatternPack = {
  name: "hono",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "hono",
        importName: "Hono",
        registrationChain: [".get"],
      },
      bindingExtraction: {
        method: { type: "fromRegistration", position: "methodName" },
        path: { type: "fromArgument", position: 0 },
      },
      requiresImport: ["hono"],
    },
    {
      kind: "middleware",
      match: {
        type: "registrationCall",
        importModule: "hono",
        importName: "Hono",
        registrationChain: [],
      },
      wraps: {
        method: "use",
        scopePosition: 0,
        targetPosition: 1,
        continuationParam: 1,
      },
      requiresImport: ["hono"],
    },
  ],
  terminals: [],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "context" }],
  },
};

function wrappersOf(
  summaries: BehavioralSummary[],
  path: string,
): WrapperMetadata["applied"] {
  const summary = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return semantics?.name === "rest" && semantics.path === path;
  });
  expect(summary, `no summary for ${path}`).toBeDefined();
  return readWrapperMetadata(summary as BehavioralSummary)?.applied ?? [];
}

function statusesOf(summary: BehavioralSummary): unknown[] {
  return summary.transitions.flatMap((transition) => {
    const output = transition.output;
    if (output.type !== "response" || output.statusCode?.type !== "literal") {
      return [];
    }
    return [output.statusCode.value];
  });
}

function summaryNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const summary = summaries.find((one) => one.identity.name === name);
  expect(summary, `no summary named ${name}`).toBeDefined();
  return summary as BehavioralSummary;
}

describe("wrapper registrations, end to end", () => {
  it("records middleware written in the same file as the route", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((req, res, next) => { next(); });
        app.get("/orders", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([
      { file: "/app.ts", name: "use" },
    ]);
  });

  it("follows middleware imported from another file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/requireCaller.ts",
      `
        export const requireCaller = (req, res, next) => { next(); };
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { requireCaller } from "./requireCaller";
        const app = express();
        app.use(requireCaller);
        app.get("/orders", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([
      { file: "/requireCaller.ts", name: "requireCaller" },
    ]);
  });

  it("summarizes the middleware itself, where what it does is written", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/requireCaller.ts",
      `
        export const requireCaller = (req, res, next) => {
          if (!req.headers.authorization) {
            res.status(401).json({ error: "unauthorized" });
            return;
          }
          next();
        };
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { requireCaller } from "./requireCaller";
        const app = express();
        app.use(requireCaller);
        app.get("/orders", (req, res) => { res.status(200).json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const wrapper = summaryNamed(summaries, "requireCaller");
    expect(wrapper.kind).toBe("middleware");
    expect(statusesOf(wrapper)).toEqual([401]);
  });

  it("reads an error handler's own body past the thrown value it is handed", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((err, req, res, next) => {
          res.status(500).json({ error: "unavailable" });
        });
        app.get("/orders", (req, res) => { res.status(200).json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const wrapper = summaryNamed(summaries, "use");
    expect(statusesOf(wrapper)).toEqual([500]);
  });

  it("records nothing for a registration whose function does not resolve", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        declare function pickMiddleware(): unknown;
        const app = express();
        app.use(pickMiddleware());
        app.get("/orders", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([]);
  });

  it("marks a four-argument function as running on a throw, and not as middleware too", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((err, req, res, next) => { res.status(500).json({}); });
        app.get("/orders", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([
      { file: "/app.ts", name: "use", onThrow: true },
    ]);
  });

  it("records the path pattern a scoped registration narrows itself to", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const app = new Hono();
        app.use("/v1/*", async (c, next) => { await next(); });
        app.get("/v1/orders", (c) => c.json({}));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/v1/orders")).toEqual([
      { file: "/app.ts", name: "use", scope: "/v1/*" },
    ]);
  });

  it("leaves a route alone when another pack's app registered the wrapper", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/honoApp.ts",
      `
        import { Hono } from "hono";
        export const honoApp = new Hono();
        honoApp.get("/ping", (c) => c.json({}));
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((req, res, next) => { next(); });
        app.get("/orders", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack, honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/ping")).toEqual([]);
    expect(wrappersOf(summaries, "/orders")).toHaveLength(1);
  });

  it("leaves a mount alone, since the mounted value is a router and not a function", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        const orders = express();
        orders.get("/list", (req, res) => { res.json({}); });
        app.use("/orders", orders);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders/list")).toEqual([]);
  });
});
