/**
 * wrapperIndex.test.ts, end to end through createTypeScriptAdapter: a
 * wrapper registered on an app becomes a summary of its own, every
 * route on that app points at it whether it is written in the same file
 * or imported from another one, and what it produces is reported as
 * part of what those routes produce.
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
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
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
      mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
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
    {
      kind: "middleware",
      match: {
        type: "registrationCall",
        importModule: "hono",
        importName: "Hono",
        registrationChain: [],
      },
      wraps: {
        constructorOption: "defaultHook",
        targetPosition: 0,
        resultParam: 0,
      },
      requiresImport: ["hono"],
    },
  ],
  terminals: [
    {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition: 0,
        methodChain: ["json"],
      },
      extraction: {
        statusCode: { from: "argument", position: 1 },
        body: { from: "argument", position: 0 },
        defaultStatusCode: 200,
      },
    },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "context" }],
  },
};

function summaryFor(
  summaries: BehavioralSummary[],
  path: string,
): BehavioralSummary {
  const summary = summaries.find((one) => {
    const semantics = one.identity.boundaryBinding?.semantics;
    return semantics?.name === "rest" && semantics.path === path;
  });
  expect(summary, `no summary for ${path}`).toBeDefined();
  return summary as BehavioralSummary;
}

function wrappersOf(
  summaries: BehavioralSummary[],
  path: string,
): WrapperMetadata["applied"] {
  return readWrapperMetadata(summaryFor(summaries, path))?.applied ?? [];
}

/** The calls a route says it was read without, as callee and sentence. */
function unfollowedOn(
  summaries: BehavioralSummary[],
  path: string,
): Array<{ callee: string; description: string }> {
  return summaryFor(summaries, path).gaps.flatMap((gap) =>
    gap.type === "unfollowedCall" && gap.callee !== undefined
      ? [{ callee: gap.callee, description: gap.description }]
      : [],
  );
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

  it("ends a middleware's pass-through path at the call that hands control on", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((req, res, next) => {
          if (!req.headers.authorization) {
            res.status(401).json({ error: "unauthorized" });
            return;
          }
          next();
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
    expect(wrapper.transitions.map((t) => t.output.type)).toEqual([
      "response",
      "delegate",
    ]);
  });

  it("reports what the middleware produces as part of the route's own behaviour", async () => {
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

    const route = summaries.find(
      (one) => one.identity.boundaryBinding?.semantics.name === "rest",
    ) as BehavioralSummary;
    expect(statusesOf(route)).toEqual([401, 200]);
    expect(
      route.transitions.map((t) => readWrapperMetadata(t)?.from?.name),
    ).toEqual(["requireCaller", undefined]);
  });

  it("reports the error handler's response where the route threw", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        const app = express();
        app.use((err, req, res, next) => {
          res.status(500).json({ error: "unavailable" });
        });
        app.get("/orders", (req, res) => {
          if (!req.query.id) {
            throw new Error("id is required");
          }
          res.status(200).json({});
        });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const route = summaries.find(
      (one) => one.identity.boundaryBinding?.semantics.name === "rest",
    ) as BehavioralSummary;
    expect(statusesOf(route)).toEqual([200, 500]);
    expect(route.transitions.every((t) => t.output.type === "response")).toBe(
      true,
    );
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

  it("follows middleware a project factory returns, named after the factory", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/requireCaller.ts",
      `
        export function requireCaller(config: { header: string }) {
          return (req, res, next) => {
            if (!req.headers[config.header]) {
              res.status(401).json({ error: "unauthorized" });
              return;
            }
            next();
          };
        }
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { requireCaller } from "./requireCaller";
        const app = express();
        app.use(requireCaller({ header: "authorization" }));
        app.get("/orders", (req, res) => { res.status(200).json({}); });
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
    expect(statusesOf(summaryNamed(summaries, "requireCaller"))).toEqual([401]);
    expect(unfollowedOn(summaries, "/orders")).toEqual([]);
  });

  it("leaves a gap on each route when the factory has no body to follow", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        declare function pickMiddleware(): unknown;
        const app = express();
        app.use(pickMiddleware());
        app.get("/orders", (req, res) => { res.json({}); });
        app.get("/items", (req, res) => { res.json({}); });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([]);
    for (const path of ["/orders", "/items"]) {
      expect(unfollowedOn(summaries, path)).toEqual([
        {
          callee: "pickMiddleware",
          description: expect.stringContaining(
            "The call to pickMiddleware registers middleware this run could not follow to one function",
          ),
        },
      ]);
    }
  });

  it("leaves nothing for a factory in a dependency", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/node_modules/cors/index.d.ts",
      "export default function cors(options?: unknown): unknown;",
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import cors from "cors";
        const app = express();
        app.use(cors());
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
    expect(unfollowedOn(summaries, "/orders")).toEqual([]);
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

  it("composes the prefix its router was mounted under into a scope", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const api = new Hono();
        api.use("/v1/*", async (c, next) => { await next(); });
        api.get("/v1/orders", (c) => c.json({}));
        const root = new Hono();
        root.route("/api", api);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/api/v1/orders")).toEqual([
      { file: "/app.ts", name: "use", scope: "/api/v1/*" },
    ]);
  });

  it("composes every prefix a two-deep mount chain gives", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const inner = new Hono();
        inner.use("/v1/*", async (c, next) => { await next(); });
        inner.get("/v1/orders", (c) => c.json({}));
        const mid = new Hono();
        mid.route("/svc", inner);
        const root = new Hono();
        root.route("/api", mid);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/api/svc/v1/orders")).toEqual([
      { file: "/app.ts", name: "use", scope: "/api/svc/v1/*" },
    ]);
  });

  it("leaves a scope as written when two mounts of the same router disagree", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const api = new Hono();
        api.use("/v1/*", async (c, next) => { await next(); });
        api.get("/v1/orders", (c) => c.json({}));
        const root = new Hono();
        root.route("/api", api);
        root.route("/other", api);
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

  it("follows a hook handed to the constructor onto every route on that app", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/validationHook.ts",
      `
        export const validationHook = (result, c) => {
          if (!result.success) {
            return c.json({ error: "invalid" }, 400);
          }
        };
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        import { validationHook } from "./validationHook";
        const app = new Hono({ defaultHook: validationHook });
        app.get("/orders", (c) => c.json({}, 200));
        app.get("/items", (c) => c.json({}, 200));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    for (const path of ["/orders", "/items"]) {
      expect(wrappersOf(summaries, path)).toEqual([
        { file: "/validationHook.ts", name: "validationHook" },
      ]);
      expect(statusesOf(summaryFor(summaries, path))).toEqual([400, 200]);
    }
    expect(statusesOf(summaryNamed(summaries, "validationHook"))).toEqual([
      400,
    ]);
  });

  it("reads the hook out of an options object the constructor is handed by name", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const shared = { strict: false };
        const options = {
          ...shared,
          defaultHook(result, c) {
            if (!result.success) {
              return c.json({ error: "invalid" }, 422);
            }
          },
        };
        const app = new Hono(options);
        app.get("/orders", (c) => c.json({}, 200));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([
      { file: "/app.ts", name: "defaultHook" },
    ]);
    expect(statusesOf(summaryFor(summaries, "/orders"))).toEqual([422, 200]);
  });

  it("leaves a gap on each route when the hook comes from a factory with no body", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        declare function buildHook(): unknown;
        const app = new Hono({ defaultHook: buildHook() });
        app.get("/orders", (c) => c.json({}, 200));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([]);
    expect(unfollowedOn(summaries, "/orders")).toEqual([
      {
        callee: "buildHook",
        description: expect.stringContaining("The call to buildHook"),
      },
    ]);
  });

  it("reads a hook once when the app is also passed to a helper in the same file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const app = new Hono({ defaultHook: (result, c) => c.json({}, 400) });
        function registerOrders(target: Hono) {
          target.get("/orders", (c) => c.json({}, 200));
        }
        registerOrders(app);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(wrappersOf(summaries, "/orders")).toEqual([
      { file: "/app.ts", name: "defaultHook" },
    ]);
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
