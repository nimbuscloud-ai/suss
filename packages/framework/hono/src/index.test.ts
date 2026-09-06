import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readHttpMetadata } from "@suss/behavioral-ir";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { honoFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/hono/api.ts",
);

describe("honoFramework", () => {
  it("registers routes off a constructed app", () => {
    const pack = honoFramework();
    expect(pack.name).toBe("hono");
    expect(pack.protocol).toBe("http");
    // Two import sources times the verb list, plus app.openapi.
    // Two spreads of two call patterns each, plus the loop pattern
    // each spread of httpRouteDiscovery emits, the zod-openapi
    // registration, and one wrapper pattern per app per wrapper shape.
    expect(pack.discovery).toHaveLength(16);
    expect(pack.discovery[0]?.requiresImport).toEqual(["hono"]);
  });

  it("reads the context at parameter 0, not a response object at 1", () => {
    // Express hands the handler a response object as its second
    // parameter; Hono hands one context as its first and the handler
    // returns from it. Reading position 1 here would find nothing.
    const responses = honoFramework().terminals.filter(
      (t) => t.match.type === "parameterMethodCall",
    );
    expect(responses.length).toBeGreaterThan(0);
    for (const terminal of responses) {
      expect(
        terminal.match.type === "parameterMethodCall"
          ? terminal.match.parameterPosition
          : null,
      ).toBe(0);
    }
  });
});

describe("honoFramework: extraction", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    const adapter = createTypeScriptAdapter({
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    adapter.tsProject.addSourceFileAtPath(FIXTURE);
    summaries = await adapter.extractAll();
  });

  function boundary(method: string, routePath: string) {
    return summaries.find((s) => {
      const semantics = s.identity.boundaryBinding?.semantics;
      return (
        semantics?.name === "rest" &&
        semantics.method === method &&
        semantics.path === routePath
      );
    });
  }

  function statuses(summary: BehavioralSummary | undefined): unknown[] {
    return (summary?.transitions ?? [])
      .map((t) => (t.output.type === "response" ? t.output.statusCode : null))
      .map((code) => (code?.type === "literal" ? code.value : code?.type))
      .sort();
  }

  it("finds every registered route", () => {
    expect(boundary("GET", "/users/:id")).toBeDefined();
    expect(boundary("POST", "/users")).toBeDefined();
    expect(boundary("GET", "/legacy/:id")).toBeDefined();
  });

  it("reads each guard's status from the second argument", () => {
    expect(statuses(boundary("GET", "/users/:id"))).toEqual([200, 404, 410]);
  });

  it("defaults to 200 when the handler passes no status", () => {
    const ok = boundary("GET", "/users/:id")?.transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );
    const body = ok?.output.type === "response" ? ok.output.body : null;
    expect(
      Object.keys((body as { properties?: object })?.properties ?? {}),
    ).toEqual(expect.arrayContaining(["id", "name"]));
  });

  it("reads a text response and its status", () => {
    expect(statuses(boundary("POST", "/users"))).toEqual([201, 400]);
  });

  it("does not read a status off a class the map never names", () => {
    const retries = boundary("POST", "/users/:id/retries");
    expect(statuses(retries)).not.toContain(503);
  });

  it("reads the status off HTTPException's first argument", () => {
    const del = boundary("DELETE", "/users/:id");
    expect(statuses(del)).toContain(404);
  });

  it("gives a redirect Hono's default status", () => {
    expect(statuses(boundary("GET", "/legacy/:id"))).toEqual([302]);
  });
});

describe("honoFramework \u2014 zod-openapi registration", () => {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../fixtures/hono-openapi",
  );

  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    const project = createFixtureProject(dir, "*.ts");
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
    });
    summaries = await adapter.extractAll();
  }, 90_000);

  // The read route is registered through a cast, which the resolution store
  // used to return null for, and the route was lost entirely.
  it("reads the route off the contract object the registration names", () => {
    const routes = summaries
      .map((s) => s.identity.boundaryBinding)
      .filter((b) => b?.semantics.name === "rest")
      .map((b) =>
        b?.semantics.name === "rest"
          ? `${b.semantics.method} ${b.semantics.path}`
          : "",
      )
      .sort();
    expect(routes).toEqual([
      "GET /v1/tenants/{tenantId}",
      "POST /v1/tenants/{tenantId}/provision",
    ]);
  });

  it("reads both outcomes of the provision handler", () => {
    const provision = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.method === "POST",
    );
    const statuses = provision?.transitions
      .map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      )
      .sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("reads the declared responses off the registered route object", () => {
    const provision = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.method === "POST",
    );
    const declared =
      provision === undefined
        ? undefined
        : readHttpMetadata(provision)?.declaredContract;
    expect(declared?.provenance).toBe("independent");
    expect(declared?.responses.map((r) => r.statusCode)).toEqual([200]);
  });

  it("reads the declaration through the cast the read route arrives behind", () => {
    const read = summaries.find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.method === "GET",
    );
    const declared =
      read === undefined ? undefined : readHttpMetadata(read)?.declaredContract;
    expect(declared?.responses.map((r) => r.statusCode)).toEqual([200]);
  });
});

describe("honoFramework, app.route mount prefix", () => {
  it("composes a sub-app's mount prefix into its routes, across a file boundary", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/ordersApp.ts",
      `
        import { Hono } from "hono";
        export const ordersApp = new Hono();
        ordersApp.get("/_health", (c) => c.json({ ok: true }));
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        import { ordersApp } from "./ordersApp";
        const app = new Hono();
        app.route("/api/orders", ordersApp);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const paths = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter(
        (sem): sem is Extract<typeof sem, { name: "rest" }> =>
          sem?.name === "rest",
      )
      .map((sem) => sem.path);
    expect(paths).toEqual(["/api/orders/_health"]);
  });

  it("leaves the path alone when the mount can't be resolved", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        declare function pickSubApp(): unknown;
        const app = new Hono();
        const ordersApp = new Hono();
        ordersApp.get("/_health", (c) => c.json({ ok: true }));
        app.route("/api/orders", pickSubApp());
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const paths = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter(
        (sem): sem is Extract<typeof sem, { name: "rest" }> =>
          sem?.name === "rest",
      )
      .map((sem) => sem.path);
    expect(paths).toEqual(["/_health"]);
  });

  it("composes a mount prefix into a route on a sub-app a project wrapper builds", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/subApps.ts",
      `
        import { Hono } from "hono";
        export function buildOrdersApp() {
          return new Hono();
        }
      `,
    );
    project.createSourceFile(
      "/ordersApp.ts",
      `
        import { buildOrdersApp } from "./subApps";
        export const ordersApp = buildOrdersApp();
        ordersApp.get("/_health", (c) => c.json({ ok: true }));
      `,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        import { ordersApp } from "./ordersApp";
        const app = new Hono();
        app.route("/api/orders", ordersApp);
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const paths = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter(
        (sem): sem is Extract<typeof sem, { name: "rest" }> =>
          sem?.name === "rest",
      )
      .map((sem) => sem.path);
    expect(paths).toEqual(["/api/orders/_health"]);
  });
});

describe("honoFramework, app.use", () => {
  it("applies middleware registered without a path to every route", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { Hono } from "hono";
        const app = new Hono();
        const requireCaller = async (c, next) => {
          if (c.req.header("authorization") === undefined) {
            return c.json({ error: "unauthorized" }, 401);
          }
          await next();
        };
        app.use(requireCaller);
        app.use("/v1/*", async (c, next) => { await next(); });
        app.get("/health", (c) => c.json({ ok: true }, 200));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const health = summaries.find(
      (s) => s.identity.boundaryBinding?.semantics?.name === "rest",
    );
    const wrappers = health?.metadata?.wrappers as
      | { applied: { name: string; scope?: string }[] }
      | undefined;
    expect(wrappers?.applied).toEqual([
      { file: "/app.ts", name: "requireCaller" },
    ]);
  });
});

describe("honoFramework, defaultHook", () => {
  it("reports the hook's 400 on every route of an OpenAPIHono app", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/app.ts",
      `
        import { OpenAPIHono } from "@hono/zod-openapi";
        const app = new OpenAPIHono({
          defaultHook: (result, c) => {
            if (!result.success) {
              return c.json({ error: "invalid" }, 400);
            }
          },
        });
        app.get("/health", (c) => c.json({ ok: true }, 200));
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [honoFramework()],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();

    const health = summaries.find(
      (s) => s.identity.boundaryBinding?.semantics?.name === "rest",
    );
    const wrappers = health?.metadata?.wrappers as
      | { applied: { name: string }[] }
      | undefined;
    expect(wrappers?.applied).toEqual([
      { file: "/app.ts", name: "defaultHook" },
    ]);
    expect(
      health?.transitions.map((t) =>
        t.output.type === "response" && t.output.statusCode?.type === "literal"
          ? t.output.statusCode.value
          : null,
      ),
    ).toEqual([400, 200]);
  });
});
