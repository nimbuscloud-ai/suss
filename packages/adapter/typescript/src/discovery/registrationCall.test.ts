import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { nodeId } from "../facts/extract.js";
import { ResolutionStore } from "../facts/store.js";
import {
  discoverMountEdges,
  discoverRegistrationCalls,
  joinMountedPath,
  type MountPrefixIndex,
  registrationSubjectIdsOf,
} from "./registrationCall.js";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";

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

  it("omits routeInfo when the path argument isn't a literal", () => {
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

  it("records nothing for an inline router the subjects map never named", () => {
    // Router() written directly at the call, with no variable
    // set to it, is not in registrationSubjectsOf's map: nothing
    // else in the file could ever ask "is this router mounted"
    // about a node with no name to look it up by, so the mount
    // scan does not track it either.
    const sf = sourceFile(`
      import express, { Router } from "express";
      const app = express();
      app.use("/api/orders", Router());
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
