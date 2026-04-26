import { Project, ScriptTarget, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { discoverUnits } from "./index.js";

import type { DiscoveryPattern } from "@suss/extractor";

function makeFile(source: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100,
    },
    useInMemoryFileSystem: true,
  });
  return project.createSourceFile("user.ts", source);
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
    const units = discoverUnits(file, [PATTERN]);
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
    const units = discoverUnits(file, [PATTERN]);
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
        // Body doesn't touch r — not a registration loop.
        unrelated();
      }
    `);
    const units = discoverUnits(file, [PATTERN]);
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
    const units = discoverUnits(file, [PATTERN]);
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
    const units = discoverUnits(file, [PATTERN]);
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
    const units = discoverUnits(file, [PATTERN]);
    expect(units).toHaveLength(1);
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/inline" });
  });
});
