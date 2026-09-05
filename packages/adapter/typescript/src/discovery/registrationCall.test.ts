import { describe, expect, it } from "vitest";

import { joinMountedPath } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import { nodeId } from "../facts/extract.js";
import { ResolutionStore } from "../facts/store.js";
import {
  discoverMountEdges,
  discoverRegistrationCalls,
  type MountPrefixIndex,
  registrationSubjectIdsOf,
  registrationSubjectsOf,
  storeCanFindSubjects,
} from "./registrationCall.js";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

function sourceFile(code: string) {
  const project = createTestProject();
  return project.createSourceFile("test.ts", code);
}

// HTTP-style: method from the registration verb, path from arg 0.
const httpBinding: BindingExtraction = {
  method: { type: "fromRegistration", position: "methodName" },
  path: { type: "fromArgument", position: 0 },
};

const expressMatch: RegistrationMatch = {
  type: "registrationCall",
  importModule: "express",
  importName: "Router",
  registrationChain: [".get", ".post", ".put"],
};

describe("discoverRegistrationCalls: handler discovery", () => {
  it("finds an express last-arg handler and lifts (method, path) into routeInfo", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/users/:id", (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("handler");
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/users/:id" });
  });

  it("follows a path passed by name to the string it was written as", () => {
    // A provider whose path is a constant used to come back with no route at
    // all, so a client calling it paired with nothing. The consumer side
    // has followed a name since #123; both read it the same way now.
    const sf = sourceFile(`
      import { Router } from "express";
      const USERS = "/users";
      const r = Router();
      r.get(USERS, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      new ResolutionStore(),
    );
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/users" });
  });

  it("puts a resolved prefix into a path built from a template", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const BASE = "/api";
      const r = Router();
      r.get(\`\${BASE}/items/:id\`, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      new ResolutionStore(),
    );
    expect(units[0]?.routeInfo).toEqual({
      method: "GET",
      path: "/api/items/:id",
    });
  });

  it("drops a hole that resolves to the empty string", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const BASE = "";
      const r = Router();
      r.get(\`\${BASE}/items\`, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      new ResolutionStore(),
    );
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/items" });
  });

  it("writes a placeholder for a template hole nobody can follow", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      export function mount(prefix: string) {
        r.get(\`\${prefix}/items\`, (req, res) => { res.json({}); });
      }
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      new ResolutionStore(),
    );
    expect(units[0]?.routeInfo).toEqual({
      method: "GET",
      path: "{prefix}/items",
    });
  });

  it("lifts the path from a no-substitution template literal", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.post(\`/items\`, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units[0].routeInfo).toEqual({ method: "POST", path: "/items" });
  });

  it("reads the path through a local name", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const p = "/dynamic";
      r.get(p, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/dynamic" });
  });

  it("omits routeInfo when the path argument is a parameter", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      export function mount(p: string) {
        r.get(p, (req, res) => { res.json({}); });
      }
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("keeps the route when the handler comes from a parameter", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const register = (handle: any) => { r.get("/users", handle); };
      register((req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].func).toBeNull();
    expect(units[0].announcedAt?.getText()).toBe('r.get("/users", handle)');
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/users" });
  });

  it("announces nothing for a registration that names no handler", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/users");
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(0);
  });

  it("announces nothing for an argument a chain could still be followed to", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const pick = () => (req, res) => {};
      r.get("/users", pick());
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(0);
  });

  it("announces nothing when the call states no route to pair on", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const register = (handle: any) => { r.get(dynamicPath, handle); };
      declare const dynamicPath: string;
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(0);
  });

  it("omits routeInfo when no bindingExtraction is supplied", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/x", (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(sf, expressMatch, "handler");
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("reads the method from a numeric argument position when configured", () => {
    const sf = sourceFile(`
      import { App } from "framework";
      const app = App();
      app.route("PATCH", "/things/:id", (req, res) => {});
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "framework",
      importName: "App",
      registrationChain: [".route"],
    };
    const binding: BindingExtraction = {
      method: { type: "fromRegistration", position: 0 },
      path: { type: "fromArgument", position: 1 },
    };
    const units = discoverRegistrationCalls(sf, match, "handler", binding);
    expect(units[0].routeInfo).toEqual({
      method: "PATCH",
      path: "/things/:id",
    });
  });

  it("omits routeInfo when the numeric method argument isn't a literal", () => {
    const sf = sourceFile(`
      import { App } from "framework";
      const app = App();
      const verb = "GET";
      app.route(verb, "/x", (req, res) => {});
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "framework",
      importName: "App",
      registrationChain: [".route"],
    };
    const binding: BindingExtraction = {
      method: { type: "fromRegistration", position: 0 },
      path: { type: "fromArgument", position: 1 },
    };
    const units = discoverRegistrationCalls(sf, match, "handler", binding);
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("omits routeInfo when the binding doesn't come from the registration", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/x", (req, res) => { res.json({}); });
    `);
    const binding: BindingExtraction = {
      method: { type: "fromContract" },
      path: { type: "fromContract" },
    };
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      binding,
    );
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("discovers ts-rest object-arg handlers (method shorthand and arrow props), without routeInfo", () => {
    const sf = sourceFile(`
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        async getUser({ params }) { return { status: 200, body: {} }; },
        listUsers: async () => ({ status: 200, body: [] }),
      });
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "@ts-rest/express",
      importName: "initServer",
      registrationChain: [".router"],
    };
    const units = discoverRegistrationCalls(sf, match, "handler", httpBinding);
    expect(units.map((u) => u.name).sort()).toEqual(["getUser", "listUsers"]);
    for (const u of units) {
      expect(u.routeInfo).toBeUndefined();
    }
  });

  it("resolves the registration variable from a default import", () => {
    const sf = sourceFile(`
      import express from "express";
      const app = express();
      app.get("/", (req, res) => { res.json({}); });
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "express",
      importName: "express",
      registrationChain: [".get"],
    };
    const units = discoverRegistrationCalls(sf, match, "handler", httpBinding);
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/" });
  });

  it("returns nothing when the registration module isn't imported", () => {
    const sf = sourceFile(`
      const r = somethingElse();
      r.get("/x", (req, res) => {});
    `);
    expect(
      discoverRegistrationCalls(sf, expressMatch, "handler", httpBinding),
    ).toEqual([]);
  });

  it("ignores registration-shaped calls on a variable that isn't the routable", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const other = {};
      other.get("/x", (req, res) => {});
    `);
    expect(
      discoverRegistrationCalls(sf, expressMatch, "handler", httpBinding),
    ).toEqual([]);
  });
});

const useMount = { method: "use", prefixPosition: 0, targetPosition: 1 };

describe("discoverRegistrationCalls, mount prefix composition", () => {
  it("composes the prefix an index reports for the route's own router", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/_health", (req, res) => { res.json({}); });
    `);
    const routerInit = sf
      .getVariableDeclarations()
      .find((d) => d.getName() === "r")
      ?.getInitializer();
    if (routerInit === undefined) {
      throw new Error("expected an initializer for r");
    }

    const mountPrefixes: MountPrefixIndex = {
      effectivePrefixFor: (node) => (node === routerInit ? "/api/orders" : ""),
    };

    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      undefined,
      mountPrefixes,
    );
    expect(units[0]?.routeInfo).toEqual({
      method: "GET",
      path: "/api/orders/_health",
    });
  });

  it("leaves the path alone when the index reports no prefix", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/_health", (req, res) => { res.json({}); });
    `);
    const mountPrefixes: MountPrefixIndex = { effectivePrefixFor: () => "" };

    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
      undefined,
      mountPrefixes,
    );
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/_health" });
  });

  it("leaves the path alone when no index was built at all", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/_health", (req, res) => { res.json({}); });
    `);

    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/_health" });
  });
});

// express's own registrationCall matches, express() and Router(), the
// two import names a mount's subject or target can resolve to. Tests
// below union them the same way buildMountPrefixIndex does, so a
// target tracked under either name is a known subject.
const expressAppMatch: RegistrationMatch = {
  type: "registrationCall",
  importModule: "express",
  importName: "express",
  registrationChain: [".get"],
};
const expressRouterMatch: RegistrationMatch = {
  type: "registrationCall",
  importModule: "express",
  importName: "Router",
  registrationChain: [".get"],
};

function expressSubjectIds(sf: ReturnType<typeof sourceFile>) {
  return registrationSubjectIdsOf(sf, [expressAppMatch, expressRouterMatch]);
}

describe("discoverMountEdges", () => {
  it("finds a same-file mount and resolves both ends to their creation sites", () => {
    const sf = sourceFile(`
      import express, { Router } from "express";
      const app = express();
      const ordersRouter = Router();
      app.use("/api/orders", ordersRouter);
    `);
    const store = new ResolutionStore();

    const edges = discoverMountEdges(
      sf,
      expressAppMatch,
      useMount,
      expressSubjectIds(sf),
      store,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prefix).toBe("/api/orders");
  });

  it("records an edge for every argument that resolves to a known subject", () => {
    // app.use(prefix, r1, r2) mounts both r1 and r2 at prefix, the
    // way Express itself applies every handler argument there.
    const sf = sourceFile(`
      import express, { Router } from "express";
      const app = express();
      const r1 = Router();
      const r2 = Router();
      app.use("/a", r1, r2);
    `);
    const store = new ResolutionStore();

    const edges = discoverMountEdges(
      sf,
      expressAppMatch,
      useMount,
      expressSubjectIds(sf),
      store,
    );
    expect(edges).toHaveLength(2);
    expect(edges.every((edge) => edge.prefix === "/a")).toBe(true);

    const r1Init = sf
      .getVariableDeclarations()
      .find((d) => d.getName() === "r1")
      ?.getInitializer();
    const r2Init = sf
      .getVariableDeclarations()
      .find((d) => d.getName() === "r2")
      ?.getInitializer();
    if (r1Init === undefined || r2Init === undefined) {
      throw new Error("expected initializers for r1 and r2");
    }
    expect(edges.map((edge) => edge.childRouterId).sort()).toEqual(
      [nodeId(r1Init), nodeId(r2Init)].sort(),
    );
  });

  it("finds the router past middleware interposed between the prefix and it", () => {
    const sf = sourceFile(`
      import express, { Router } from "express";
      declare function requireAuth(req: any, res: any, next: any): void;
      const app = express();
      const adminRouter = Router();
      app.use("/admin", requireAuth, adminRouter);
    `);
    const store = new ResolutionStore();

    const edges = discoverMountEdges(
      sf,
      expressAppMatch,
      useMount,
      expressSubjectIds(sf),
      store,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prefix).toBe("/admin");

    const adminRouterInit = sf
      .getVariableDeclarations()
      .find((d) => d.getName() === "adminRouter")
      ?.getInitializer();
    expect(adminRouterInit).toBeDefined();
    if (adminRouterInit === undefined) {
      throw new Error("expected an initializer for adminRouter");
    }
    // The edge names adminRouter, not requireAuth: requireAuth never
    // resolves to a known subject, so it contributes no edge of its
    // own.
    expect(edges[0]?.childRouterId).toBe(nodeId(adminRouterInit));
  });

  it("skips a call-shaped middleware argument and still finds the router past it", () => {
    // createAuthMiddleware() is a call expression, the same shape a
    // router's own creation site is, so resolving it without checking
    // subject membership would record a phantom edge nothing ever
    // queries. With the membership check, the walk keeps going past
    // it and still finds adminRouter.
    const sf = sourceFile(`
      import express, { Router } from "express";
      declare function createAuthMiddleware(): any;
      const app = express();
      const adminRouter = Router();
      app.use("/admin", createAuthMiddleware(), adminRouter);
    `);
    const store = new ResolutionStore();

    const edges = discoverMountEdges(
      sf,
      expressAppMatch,
      useMount,
      expressSubjectIds(sf),
      store,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prefix).toBe("/admin");
  });

  it("finds nothing when every candidate argument is unknown", () => {
    const sf = sourceFile(`
      import express from "express";
      declare function requireAuth(req: any, res: any, next: any): void;
      declare function createAuthMiddleware(): any;
      const app = express();
      app.use("/admin", requireAuth, createAuthMiddleware());
    `);
    const store = new ResolutionStore();

    expect(
      discoverMountEdges(
        sf,
        expressAppMatch,
        useMount,
        expressSubjectIds(sf),
        store,
      ),
    ).toEqual([]);
  });

  it("records a router written directly at the mount call", () => {
    // A Router() no variable is set to is still a router this run
    // tracks: a project function returns one the same way, and a
    // route registered on what that function returned asks about
    // this creation site.
    const sf = sourceFile(`
      import express, { Router } from "express";
      const app = express();
      app.use("/api/orders", Router());
    `);
    const store = new ResolutionStore();

    const edges = discoverMountEdges(
      sf,
      expressAppMatch,
      useMount,
      expressSubjectIds(sf),
      store,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prefix).toBe("/api/orders");
  });

  it("records nothing when the prefix isn't a string literal", () => {
    const sf = sourceFile(`
      import express, { Router } from "express";
      const app = express();
      const ordersRouter = Router();
      declare function computePrefix(): string;
      const prefix = computePrefix();
      app.use(prefix, ordersRouter);
    `);
    const store = new ResolutionStore();

    expect(
      discoverMountEdges(
        sf,
        expressAppMatch,
        useMount,
        expressSubjectIds(sf),
        store,
      ),
    ).toEqual([]);
  });

  it("records nothing when the mounted value is a name nothing here resolves", () => {
    // ordersRouter is declared ambiently and never imported here, so
    // with no resolution store to follow it, the mount's target has
    // to be written out at the position itself, which this isn't.
    const sf = sourceFile(`
      import express from "express";
      const app = express();
      declare const ordersRouter: unknown;
      app.use("/api/orders", ordersRouter);
    `);

    expect(
      discoverMountEdges(sf, expressAppMatch, useMount, expressSubjectIds(sf)),
    ).toEqual([]);
  });

  it("returns nothing when nothing in the file is a registration subject", () => {
    const sf = sourceFile(`
      const app = somethingElse();
      app.use("/api/orders", somethingElse());
    `);

    expect(
      discoverMountEdges(sf, expressAppMatch, useMount, expressSubjectIds(sf)),
    ).toEqual([]);
  });
});

describe("joinMountedPath", () => {
  it("joins a plain prefix and path", () => {
    expect(joinMountedPath("/api/orders", "/_health")).toBe(
      "/api/orders/_health",
    );
  });

  it("strips the prefix's own trailing slash before joining", () => {
    expect(joinMountedPath("/api/orders/", "/_health")).toBe(
      "/api/orders/_health",
    );
  });

  it("composes a root prefix to the path unchanged", () => {
    expect(joinMountedPath("/", "/health")).toBe("/health");
  });

  it("leaves a root route's own slash in place, for the pairing engine's own normalizing to strip", () => {
    // "/api/orders" + "/" composes to "/api/orders/". The pairing
    // engine's path normalizer already strips a trailing slash off
    // any path before comparing two, the same treatment a route
    // written as "/api/orders" (no mount) gets, so this still pairs
    // with "GET /api/orders" even though the composed string has
    // the trailing slash.
    expect(joinMountedPath("/api/orders", "/")).toBe("/api/orders/");
  });
});

const honoMatch: RegistrationMatch = {
  type: "registrationCall",
  importModule: "hono",
  importName: "Hono",
  registrationChain: [".get", ".post"],
};

/** A project of several files, with the store warmed over all of them. */
function splitProject(files: Record<string, string>) {
  const project = createTestProject();
  const written = new Map<string, SourceFile>();
  for (const [name, code] of Object.entries(files)) {
    written.set(name, project.createSourceFile(name, code));
  }
  const resolution = new ResolutionStore();
  resolution.extractFiles(written.values());
  return {
    file: (name: string) => written.get(name) as SourceFile,
    resolution,
  };
}

describe("registrationSubjectsOf: an app registered on in another file", () => {
  it("resolves a parameter to the app the one caller passed it", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        import { registerRoutes } from "./routes";
        export function build(): Hono {
          const app = new Hono();
          registerRoutes(app);
          return app;
        }
      `,
      "routes.ts": `
        import type { Hono } from "hono";
        export function registerRoutes(app: Hono): void {
          app.get("/v1/things/:id", async (c) => c.json({}, 200));
        }
      `,
    });

    const created = file("app.ts")
      .getFunctionOrThrow("build")
      .getVariableDeclarationOrThrow("app")
      .getInitializerOrThrow();
    const subjects = registrationSubjectsOf(
      file("routes.ts"),
      "hono",
      "Hono",
      resolution,
    );

    expect(nodeId(subjects.get("app") as Node)).toBe(nodeId(created));
  });

  it("resolves a parameter to an app handed on at the top of a module", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        import { registerRoutes } from "./routes";
        const app = new Hono();
        registerRoutes(app);
        export default app;
      `,
      "routes.ts": `
        import type { Hono } from "hono";
        export function registerRoutes(app: Hono): void {
          app.get("/v1/things/:id", async (c) => c.json({}, 200));
        }
      `,
    });

    const created = file("app.ts")
      .getVariableDeclarationOrThrow("app")
      .getInitializerOrThrow();
    const subjects = registrationSubjectsOf(
      file("routes.ts"),
      "hono",
      "Hono",
      resolution,
    );

    expect(nodeId(subjects.get("app") as Node)).toBe(nodeId(created));
  });

  it("resolves to nothing when two callers pass two different apps", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        import { registerRoutes } from "./routes";
        export function build(): Hono {
          const publicApp = new Hono();
          const adminApp = new Hono();
          registerRoutes(publicApp);
          registerRoutes(adminApp);
          return publicApp;
        }
      `,
      "routes.ts": `
        import type { Hono } from "hono";
        export function registerRoutes(app: Hono): void {
          app.get("/v1/things/:id", async (c) => c.json({}, 200));
        }
      `,
    });

    const parameter = file("routes.ts")
      .getFunctionOrThrow("registerRoutes")
      .getParameters()[0] as Node;
    const subjects = registrationSubjectsOf(
      file("routes.ts"),
      "hono",
      "Hono",
      resolution,
    );

    expect(nodeId(subjects.get("app") as Node)).toBe(nodeId(parameter));
  });

  it("leaves a parameter as its own subject when there is no store", () => {
    const { file } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        import { registerRoutes } from "./routes";
        export function build(): Hono {
          const app = new Hono();
          registerRoutes(app);
          return app;
        }
      `,
      "routes.ts": `
        import type { Hono } from "hono";
        export function registerRoutes(app: Hono): void {
          app.get("/v1/things/:id", async (c) => c.json({}, 200));
        }
      `,
    });

    const parameter = file("routes.ts")
      .getFunctionOrThrow("registerRoutes")
      .getParameters()[0] as Node;
    const subjects = registrationSubjectsOf(file("routes.ts"), "hono", "Hono");

    expect(nodeId(subjects.get("app") as Node)).toBe(nodeId(parameter));
  });

  it("finds a router built inside a factory function, not only at the top level", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        export function build(): Hono {
          const users = new Hono();
          users.get("/:id", async (c) => c.json({}, 200));
          return users;
        }
      `,
    });

    const units = discoverRegistrationCalls(
      file("app.ts"),
      honoMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units).toHaveLength(1);
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/:id" });
  });

  it("keys a same-file app on its own creation site, as it always did", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        const app = new Hono();
        app.get("/v1/things/:id", async (c) => c.json({}, 200));
        export default app;
      `,
    });

    const created = file("app.ts")
      .getVariableDeclarationOrThrow("app")
      .getInitializerOrThrow();
    const subjects = registrationSubjectsOf(
      file("app.ts"),
      "hono",
      "Hono",
      resolution,
    );

    expect(nodeId(subjects.get("app") as Node)).toBe(nodeId(created));
  });

  it("mounts a sub-router built in another file under the prefix stated there", () => {
    const { file, resolution } = splitProject({
      "app.ts": `
        import { Hono } from "hono";
        import { mountUsers } from "./users";
        export function build(): Hono {
          const app = new Hono();
          mountUsers(app);
          return app;
        }
      `,
      "users.ts": `
        import { Hono } from "hono";
        export function mountUsers(app: Hono): void {
          const users = new Hono();
          users.get("/:id", async (c) => c.json({}, 200));
          app.route("/v1/users", users);
        }
      `,
    });

    const knownSubjectIds = new Set([
      ...registrationSubjectIdsOf(file("app.ts"), [honoMatch], resolution),
      ...registrationSubjectIdsOf(file("users.ts"), [honoMatch], resolution),
    ]);
    const edges = discoverMountEdges(
      file("users.ts"),
      honoMatch,
      { method: "route", prefixPosition: 0, targetPosition: 1 },
      knownSubjectIds,
      resolution,
    );

    const created = file("app.ts")
      .getFunctionOrThrow("build")
      .getVariableDeclarationOrThrow("app")
      .getInitializerOrThrow();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prefix).toBe("/v1/users");
    expect(edges[0]?.parentRouterId).toBe(nodeId(created));
  });
});

describe("discoverRegistrationCalls: a helper the app was passed to", () => {
  it("reads a route registered on a parameter typed with the library", () => {
    // Express names its type Express and its constructor express, so a
    // helper's only mention of the library is a name the pack never
    // asks about. Nothing here was read at all until #769.
    const { file, resolution } = splitProject({
      "index.ts": `
        import express from "express";
        import { registerHealth } from "./routes";
        const app = express();
        registerHealth(app);
      `,
      "routes.ts": `
        import type { Express } from "express";
        export function registerHealth(app: Express): void {
          app.get("/health", (_req, res) => { res.json({ ok: true }); });
        }
      `,
    });

    const units = discoverRegistrationCalls(
      file("routes.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units.map((one) => one.routeInfo)).toEqual([
      { method: "GET", path: "/health" },
    ]);
  });

  it("keys that route on the app's own creation site", () => {
    const { file, resolution } = splitProject({
      "index.ts": `
        import express from "express";
        import { registerHealth } from "./routes";
        const app = express();
        registerHealth(app);
      `,
      "routes.ts": `
        import type { Express } from "express";
        export function registerHealth(app: Express): void {
          app.get("/health", (_req, res) => { res.json({ ok: true }); });
        }
      `,
    });

    const created = file("index.ts")
      .getVariableDeclarationOrThrow("app")
      .getInitializerOrThrow();
    const units = discoverRegistrationCalls(
      file("routes.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units[0]?.registrationSubjectId).toBe(nodeId(created));
  });

  it("follows the app through two helpers in turn", () => {
    const { file, resolution } = splitProject({
      "index.ts": `
        import express from "express";
        import { registerAll } from "./all";
        const app = express();
        registerAll(app);
      `,
      "all.ts": `
        import type { Express } from "express";
        import { registerHealth } from "./routes";
        export function registerAll(app: Express): void {
          registerHealth(app);
        }
      `,
      "routes.ts": `
        import type { Express } from "express";
        export function registerHealth(app: Express): void {
          app.get("/health", (_req, res) => { res.json({ ok: true }); });
        }
      `,
    });

    const units = discoverRegistrationCalls(
      file("routes.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units.map((one) => one.routeInfo)).toEqual([
      { method: "GET", path: "/health" },
    ]);
  });

  it("reads nothing off a plain object with a get method", () => {
    // The file imports express for its request type, and the object it
    // was handed is spelled the way a routable is. Reporting a route
    // here would be a route the server never serves.
    const { file, resolution } = splitProject({
      "index.ts": `
        import { registerCache } from "./cache";
        const cache = { get(key: string, onHit: () => void) {} };
        registerCache(cache);
      `,
      "cache.ts": `
        import type { Request, Response } from "express";
        interface Cache {
          get(key: string, onHit: (req: Request, res: Response) => void): void;
        }
        export function registerCache(cache: Cache): void {
          cache.get("/health", (_req, res) => { res.json({ ok: true }); });
        }
      `,
    });

    const units = discoverRegistrationCalls(
      file("cache.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units).toEqual([]);
  });

  it("claims no route when two callers pass two different apps", () => {
    const { file, resolution } = twoApps();

    const units = discoverRegistrationCalls(
      file("routes.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units.map((unit) => unit.routeInfo)).toEqual([undefined]);
  });

  it("names the call it stopped at and counts the apps it found", () => {
    const { file, resolution } = twoApps();

    const units = discoverRegistrationCalls(
      file("routes.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units.map((unit) => unit.unfollowed)).toEqual([
      { callee: "app.get", reason: "multipleReceivers", candidates: 2 },
    ]);
  });

  it("says nothing about a receiver two callers hand two unrelated objects", () => {
    const { file, resolution } = splitProject({
      "index.ts": `
        import express from "express";
        import { registerCache } from "./cache";
        const memory = { get(_k: string, _f: () => void) {} };
        const disk = { get(_k: string, _f: () => void) {} };
        registerCache(memory);
        registerCache(disk);
        const app = express();
        app.get("/direct", (_req, res) => { res.json({}); });
      `,
      "cache.ts": `
        import type { Request, Response } from "express";
        interface Cache { get(key: string, onHit: (req: Request, res: Response) => void): void }
        export function registerCache(cache: Cache): void {
          cache.get("/health", (_req, res) => { res.json({ cached: true }); });
        }
      `,
    });

    const units = discoverRegistrationCalls(
      file("cache.ts"),
      expressAppMatch,
      "handler",
      httpBinding,
      resolution,
    );

    expect(units).toEqual([]);
  });
});

/** The two-app project both of the declining tests above read. */
function twoApps() {
  return splitProject({
    "index.ts": `
      import express from "express";
      import { registerHealth } from "./routes";
      const publicApp = express();
      const adminApp = express();
      registerHealth(publicApp);
      registerHealth(adminApp);
    `,
    "routes.ts": `
      import type { Express } from "express";
      export function registerHealth(app: Express): void {
        app.get("/health", (_req, res) => { res.json({ ok: true }); });
      }
    `,
  });
}

describe("storeCanFindSubjects", () => {
  const registrationMethods = ["get", "post", "use"];

  it("lets through a file that imports the library", () => {
    const sf = sourceFile(`
      import express from "express";
      export function mount(app: express.Application) {}
    `);
    expect(
      storeCanFindSubjects(sf, expressAppMatch, new ResolutionStore()),
    ).toBe(true);
  });

  it("lets through a file that registers on what a call returned", () => {
    const sf = sourceFile(`
      import { buildItems } from "./routers";
      const router = buildItems();
      router.get("/:id", () => {});
    `);
    expect(
      storeCanFindSubjects(
        sf,
        expressAppMatch,
        new ResolutionStore(),
        registrationMethods,
      ),
    ).toBe(true);
  });

  it("keeps out a file whose receiver was never set to a call", () => {
    const sf = sourceFile(`
      const cache = new Map<string, string>();
      cache.get("key");
    `);
    expect(
      storeCanFindSubjects(
        sf,
        expressAppMatch,
        new ResolutionStore(),
        registrationMethods,
      ),
    ).toBe(false);
  });

  it("keeps out a file whose calls are on nothing registration-shaped", () => {
    const sf = sourceFile(`
      import { openDb } from "./db";
      const db = openDb();
      db.query("select 1");
    `);
    expect(
      storeCanFindSubjects(
        sf,
        expressAppMatch,
        new ResolutionStore(),
        registrationMethods,
      ),
    ).toBe(false);
  });

  it("keeps out a non-importing file when no methods are given", () => {
    const sf = sourceFile(`
      import { buildItems } from "./routers";
      const router = buildItems();
      router.get("/:id", () => {});
    `);
    expect(
      storeCanFindSubjects(sf, expressAppMatch, new ResolutionStore()),
    ).toBe(false);
  });

  it("keeps out every file when there is no store", () => {
    const sf = sourceFile(`
      import express from "express";
      const app = express();
    `);
    expect(
      storeCanFindSubjects(sf, expressAppMatch, undefined, registrationMethods),
    ).toBe(false);
  });
});
