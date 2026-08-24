// mountPrefix.test.ts, end to end through createTypeScriptAdapter: a
// route declared on a mounted router summarizes with the mount's
// prefix composed into its path, whether the mount is in the same
// file, across an import, or chained through more than one router.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
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
        importName: "Router",
        registrationChain: [".get", ".post", ".all"],
      },
      bindingExtraction: {
        method: {
          type: "fromRegistration",
          position: "methodName",
          nameMap: { all: "*" },
        },
        path: { type: "fromArgument", position: 0 },
      },
      mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
      requiresImport: ["express"],
    },
    {
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "express",
        importName: "express",
        registrationChain: [".get", ".post", ".all"],
      },
      bindingExtraction: {
        method: {
          type: "fromRegistration",
          position: "methodName",
          nameMap: { all: "*" },
        },
        path: { type: "fromArgument", position: 0 },
      },
      mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
      requiresImport: ["express"],
    },
  ],
  terminals: [],
  inputMapping: {
    type: "positionalParams",
    params: [
      { position: 0, role: "request" },
      { position: 1, role: "response" },
    ],
  },
};

// Same shape @suss/framework-hono ships, minus the terminals this test
// doesn't need. A different pack, whose registration subjects (`new
// Hono()`) are never something Express's own `.use` mounts.
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
        registrationChain: [".get", ".post"],
      },
      bindingExtraction: {
        method: { type: "fromRegistration", position: "methodName" },
        path: { type: "fromArgument", position: 0 },
      },
      mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
      requiresImport: ["hono"],
    },
  ],
  terminals: [],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "context" }],
  },
};

function pathsOf(summaries: BehavioralSummary[]): string[] {
  return summaries
    .map((s) => {
      const sem = s.identity.boundaryBinding?.semantics;
      return sem?.name === "rest" ? sem.path : null;
    })
    .filter((p): p is string => p !== null)
    .sort();
}

describe("mount prefix composition, end to end", () => {
  it("composes a mount that crosses a file boundary", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/routes/ordersRouter.ts",
      `
        import { Router } from "express";
        export const ordersRouter = Router();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { ordersRouter } from "./routes/ordersRouter";
        const app = express();
        app.use("/api/orders", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/api/orders/_health"]);
  });

  it("composes a mount declared in the same file", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
        app.use("/api/orders", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/api/orders/_health"]);
  });

  it("leaves the path untouched when the mount's prefix isn't a literal", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        declare function readPrefix(): string;
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
        app.use(readPrefix(), ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/_health"]);
  });

  it("leaves the path untouched when the mounted router can't be resolved", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        declare function pickRouter(): unknown;
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
        app.use("/api/orders", pickRouter());
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/_health"]);
  });

  it("composes a mount chained through more than one router", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/detailRouter.ts",
      `
        import { Router } from "express";
        export const detailRouter = Router();
        detailRouter.get("/:id", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/ordersRouter.ts",
      `
        import { Router } from "express";
        import { detailRouter } from "./detailRouter";
        export const ordersRouter = Router();
        ordersRouter.use("/orders", detailRouter);
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { ordersRouter } from "./ordersRouter";
        const app = express();
        app.use("/api", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/api/orders/:id"]);
  });

  it("leaves the path untouched when a router is mounted at two different prefixes", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/sharedRouter.ts",
      `
        import { Router } from "express";
        export const sharedRouter = Router();
        sharedRouter.get("/ping", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { sharedRouter } from "./sharedRouter";
        const app = express();
        app.use("/api", sharedRouter);
        app.use("/internal", sharedRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/ping"]);
  });

  it("composes a router mounted twice at the identical prefix, since that isn't ambiguous", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/sharedRouter.ts",
      `
        import { Router } from "express";
        export const sharedRouter = Router();
        sharedRouter.get("/ping", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { sharedRouter } from "./sharedRouter";
        const app = express();
        app.use("/api", sharedRouter);
        app.use("/api", sharedRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/api/ping"]);
  });

  it("strips a trailing slash off the mount's own prefix before joining", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
        app.use("/api/orders/", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    // Bare concatenation would double the slash at the seam
    // ("/api/orders//_health"), which the pairing engine's path
    // normalizer does not collapse, so it would never pair against
    // the single-slash path an ALB rule or another reader states.
    expect(pathsOf(summaries)).toEqual(["/api/orders/_health"]);
  });

  it("composes a root mount to the route's own path unchanged", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/health", (req, res) => { res.json({ ok: true }); });
        app.use("/", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    // Bare concatenation would produce "//health", which the pairing
    // engine's path normalizer does not collapse either.
    expect(pathsOf(summaries)).toEqual(["/health"]);
  });

  it("composes a mounted router's own root route to a path that pairs with the mount alone", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        const app = express();
        const ordersRouter = Router();
        ordersRouter.get("/", (req, res) => { res.json([]); });
        app.use("/api/orders", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    // "/api/orders" + "/" composes to "/api/orders/". The pairing
    // engine's path normalizer strips a trailing slash before two
    // paths are compared, the same treatment a route written as
    // "/api/orders" (no mount) gets, so a listener rule or another
    // reader stating "GET /api/orders" still pairs with this route.
    expect(pathsOf(summaries)).toEqual(["/api/orders/"]);
  });

  it("composes a mount past middleware interposed between the prefix and the router", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/adminRouter.ts",
      `
        import { Router } from "express";
        export const adminRouter = Router();
        adminRouter.get("/settings", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { adminRouter } from "./adminRouter";
        declare function requireAuth(req: any, res: any, next: any): void;
        const app = express();
        app.use("/admin", requireAuth, adminRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/admin/settings"]);
  });

  it("composes a wildcard route on a mounted router, prefix and method together", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/routes/ordersRouter.ts",
      `
        import { Router } from "express";
        export const ordersRouter = Router();
        ordersRouter.all("/*", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { ordersRouter } from "./routes/ordersRouter";
        const app = express();
        app.use("/api/orders", ordersRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const wildcard = summaries.find((s) => {
      const sem = s.identity.boundaryBinding?.semantics;
      return sem?.name === "rest" && sem.path === "/api/orders/*";
    });
    expect(wildcard).toBeDefined();
    const semantics = wildcard?.identity.boundaryBinding?.semantics;
    expect(semantics?.name === "rest" ? semantics.method : null).toBe("*");
  });

  it("mounts every argument that resolves to a router, not only one", async () => {
    // Express applies each handler argument at the same prefix, so
    // app.use("/a", r1, r2) mounts both r1 and r2 under /a, rather
    // than only whichever one a walk stops on first.
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        const app = express();
        const r1 = Router();
        const r2 = Router();
        r1.get("/one", (req, res) => { res.json({}); });
        r2.get("/two", (req, res) => { res.json({}); });
        app.use("/a", r1, r2);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/a/one", "/a/two"]);
  });

  it("composes nothing across packs: an Express mount can't target a Hono app", async () => {
    // Both ordersRouter and honoApp resolve to something, and both
    // are at the same argument position, but only ordersRouter is
    // one of Express's own registration subjects. honoApp belongs to
    // the Hono pack's own registry, which an Express .use never
    // checks, so it is not a mount target here whatever it resolves
    // to; Express never runs a Hono instance as a sub-router.
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import express, { Router } from "express";
        import { Hono } from "hono";
        const app = express();
        const ordersRouter = Router();
        const honoApp = new Hono();
        ordersRouter.get("/_health", (req, res) => { res.json({ ok: true }); });
        honoApp.get("/status", (c) => c.json({ ok: true }));
        app.use("/api/orders", ordersRouter, honoApp);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack, honoLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    // The Express router composes; the Hono instance, mounted through
    // the same call, does not.
    expect(pathsOf(summaries)).toEqual(["/api/orders/_health", "/status"]);
  });

  it("composes nothing when a router mounted twice at the same local prefix resolves to different full paths", async () => {
    // Both mounts state the identical local prefix "/api", but app1
    // is itself mounted under "/v1" while app2 is not mounted
    // anywhere, so the two mounts resolve to "/v1/api" and "/api",
    // genuinely different paths. Picking either arbitrarily would be
    // a wrong result presented as a right one, so this composes nothing
    // rather than guess which mount a request actually reaches
    // sharedRouter through.
    const project = createTestProject();
    project.createSourceFile(
      "/sharedRouter.ts",
      `
        import { Router } from "express";
        export const sharedRouter = Router();
        sharedRouter.get("/ping", (req, res) => { res.json({}); });
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        import { sharedRouter } from "./sharedRouter";
        const rootApp = express();
        const app1 = express();
        const app2 = express();
        rootApp.use("/v1", app1);
        app1.use("/api", sharedRouter);
        app2.use("/api", sharedRouter);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressLikePack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    expect(pathsOf(summaries)).toEqual(["/ping"]);
  });
});
