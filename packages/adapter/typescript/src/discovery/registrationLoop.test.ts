import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverUnits } from "./index.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

function makeProject(): Project {
  return createTestProject();
}

function makeFile(source: string): SourceFile {
  return makeProject().createSourceFile("user.ts", source);
}

const PATTERN: DiscoveryPattern = {
  kind: "handler",
  match: {
    type: "registrationLoop",
    elementShape: {
      methodKey: "method",
      pathKey: "path",
      handlerKey: "handler",
    },
  },
};

describe("registrationLoop discovery", () => {
  it("expands a for-of loop over an inline array literal", () => {
    const file = makeFile(`
      function getUsers() {}
      function createUser() {}
      const app: any = {};
      for (const r of [
        { method: "get", path: "/users", handler: getUsers },
        { method: "post", path: "/users", handler: createUser },
      ]) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    const routes = units
      .map((u) => u.routeInfo)
      .filter((r): r is { method: string; path: string } => r !== undefined)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(routes).toEqual(["GET /users", "POST /users"]);
  });

  it("expands a for-of loop over a const-bound array literal", () => {
    const file = makeFile(`
      function listOrders() {}
      function createOrder() {}
      const app: any = {};
      const routes = [
        { method: "get", path: "/orders", handler: listOrders },
        { method: "post", path: "/orders", handler: createOrder },
      ];
      for (const r of routes) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    const routes = units
      .map((u) => u.routeInfo)
      .filter((r): r is { method: string; path: string } => r !== undefined)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(routes).toEqual(["GET /orders", "POST /orders"]);
  });

  it("skips loops whose body does NOT reference the loop variable", () => {
    const file = makeFile(`
      function unrelated() {}
      const app: any = {};
      const routes = [{ method: "get", path: "/x", handler: unrelated }];
      for (const r of routes) {
        // Body doesn't touch r, not a registration loop.
        unrelated();
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units).toHaveLength(0);
  });

  it("skips loops whose iterable can't be resolved to an array literal", () => {
    const file = makeFile(`
      function getRoutes(): Array<{method: string; path: string; handler: () => void}> {
        return [];
      }
      const app: any = {};
      for (const r of getRoutes()) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units).toHaveLength(0);
  });

  it("skips elements with non-literal method or path", () => {
    const file = makeFile(`
      function h() {}
      const dynamicMethod = "get";
      const app: any = {};
      const routes = [
        { method: "get", path: "/ok", handler: h },
        { method: dynamicMethod, path: "/skip", handler: h },
      ];
      for (const r of routes) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    const routes = units
      .map((u) => u.routeInfo)
      .filter((r): r is { method: string; path: string } => r !== undefined)
      .map((r) => `${r.method} ${r.path}`);
    expect(routes).toEqual(["GET /ok"]);
  });

  it("supports an inline arrow function as handler", () => {
    const file = makeFile(`
      const app: any = {};
      const routes = [
        { method: "get", path: "/inline", handler: () => {} },
      ];
      for (const r of routes) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units).toHaveLength(1);
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/inline" });
  });
});

describe("registrationLoop discovery, a route table the loop names", () => {
  it("expands a loop over an array another module exports", () => {
    const project = makeProject();
    project.createSourceFile(
      "routes.ts",
      `
      export function listOrders() {}
      export function createOrder() {}
      export const routes = [
        { method: "get", path: "/orders", handler: listOrders },
        { method: "post", path: "/orders", handler: createOrder },
      ];
    `,
    );
    const file = project.createSourceFile(
      "user.ts",
      `
      import { routes } from "./routes.js";
      const app: any = {};
      for (const r of routes) {
        app[r.method](r.path, r.handler);
      }
    `,
    );

    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    const found = units
      .map((u) => `${u.routeInfo?.method} ${u.routeInfo?.path} ${u.name}`)
      .sort();
    expect(found).toEqual([
      "GET /orders listOrders",
      "POST /orders createOrder",
    ]);
  });
});

describe("registrationLoop with a declared receiver", () => {
  const GUARDED: DiscoveryPattern = {
    kind: "handler",
    match: {
      type: "registrationLoop",
      elementShape: {
        methodKey: "method",
        pathKey: "path",
        handlerKey: "handler",
      },
      receiver: { importModule: "express", importNames: ["express", "Router"] },
    },
  };

  it("expands a loop that registers on the library's routable", () => {
    const file = makeFile(`
      import express from "express";
      function getUsers() {}
      const app = express();
      for (const r of [{ method: "get", path: "/users", handler: getUsers }]) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [GUARDED], new ResolutionStore());
    expect(units.map((u) => u.routeInfo?.path)).toEqual(["/users"]);
  });

  it("leaves an identical loop over an unrelated object alone", () => {
    // The keys match and the receiver does not. Expanding this would
    // report routes the server never serves, and every finding on them
    // would be wrong.
    const file = makeFile(`
      import express from "express";
      function onUsers() {}
      const app = express();
      app.get("/health", () => {});
      const registry: any = {};
      for (const r of [{ method: "get", path: "/users", handler: onUsers }]) {
        registry[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [GUARDED], new ResolutionStore());
    expect(units.filter((u) => u.routeInfo !== undefined)).toEqual([]);
  });

  it("skips a file that never constructs the routable", () => {
    const file = makeFile(`
      function onUsers() {}
      const registry: any = {};
      for (const r of [{ method: "get", path: "/users", handler: onUsers }]) {
        registry[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [GUARDED], new ResolutionStore());
    expect(units).toEqual([]);
  });

  it("takes a Router the same as the app", () => {
    const file = makeFile(`
      import { Router } from "express";
      function onOrders() {}
      const orders = Router();
      for (const r of [{ method: "get", path: "/orders", handler: onOrders }]) {
        orders[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(file, [GUARDED], new ResolutionStore());
    expect(units.map((u) => u.routeInfo?.path)).toEqual(["/orders"]);
  });
});

describe("registrationLoop with a receiver constructed by new", () => {
  it("expands a loop on an app made with new, the way Hono is", () => {
    const file = makeFile(`
      import { Hono } from "hono";
      function onUsers() {}
      const app = new Hono();
      for (const r of [{ method: "get", path: "/users", handler: onUsers }]) {
        app[r.method](r.path, r.handler);
      }
    `);
    const units = discoverUnits(
      file,
      [
        {
          kind: "handler",
          match: {
            type: "registrationLoop",
            elementShape: {
              methodKey: "method",
              pathKey: "path",
              handlerKey: "handler",
            },
            receiver: { importModule: "hono", importNames: ["Hono"] },
          },
        },
      ],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.routeInfo?.path)).toEqual(["/users"]);
  });
});
