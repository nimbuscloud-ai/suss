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

const CRUD_PATTERN: DiscoveryPattern = {
  kind: "handler",
  match: {
    type: "registrationTemplate",
    helperName: "registerCrud",
    registrations: [
      { method: "get", pathTemplate: "/{1}", handlerArg: "{2}.list" },
      { method: "post", pathTemplate: "/{1}", handlerArg: "{2}.create" },
      { method: "put", pathTemplate: "/{1}/:id", handlerArg: "{2}.update" },
      { method: "delete", pathTemplate: "/{1}/:id", handlerArg: "{2}.remove" },
    ],
  },
};

describe("registrationTemplate discovery", () => {
  it("expands four registrations from a single helper call (object-literal handlers)", () => {
    const file = makeFile(`
      function registerCrud(_app: unknown, _resource: string, _handlers: Record<string, () => void>) {}
      const app = {};
      registerCrud(app, "users", {
        list() {},
        create() {},
        update() {},
        remove() {},
      });
    `);
    const units = discoverUnits(file, [CRUD_PATTERN]);
    const routes = units
      .map((u) => u.routeInfo)
      .filter((r): r is { method: string; path: string } => r !== undefined)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(routes).toEqual([
      "DELETE /users/:id",
      "GET /users",
      "POST /users",
      "PUT /users/:id",
    ]);
  });

  it("expands handlers passed as identifier-resolvable object literal", () => {
    const file = makeFile(`
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      const app = {};
      const userHandlers = {
        list() {},
        create() {},
        update() {},
        remove() {},
      };
      registerCrud(app, "orders", userHandlers);
    `);
    const units = discoverUnits(file, [CRUD_PATTERN]);
    const routes = units
      .map((u) => u.routeInfo)
      .filter((r): r is { method: string; path: string } => r !== undefined)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(routes).toEqual([
      "DELETE /orders/:id",
      "GET /orders",
      "POST /orders",
      "PUT /orders/:id",
    ]);
  });

  it("skips registrations whose path slot resolves to a non-literal arg", () => {
    const file = makeFile(`
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      const app = {};
      const handlers = { list() {} };
      const dynamicResource = "users";
      registerCrud(app, dynamicResource, handlers);
    `);
    const units = discoverUnits(file, [CRUD_PATTERN]);
    expect(units).toHaveLength(0);
  });

  it("skips registrations whose handler arg can't be resolved", () => {
    const file = makeFile(`
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      function getHandlers(): { list: () => void } { return { list: () => {} }; }
      const app = {};
      // Handler arg is a call result — out of v0 scope.
      registerCrud(app, "users", getHandlers());
    `);
    const units = discoverUnits(file, [CRUD_PATTERN]);
    expect(units).toHaveLength(0);
  });

  it("respects importModule narrowing", () => {
    const matchingPattern: DiscoveryPattern = {
      kind: "handler",
      match: {
        type: "registrationTemplate",
        helperName: "registerCrud",
        importModule: "./helpers",
        registrations: [
          { method: "get", pathTemplate: "/{1}", handlerArg: "{2}.list" },
        ],
      },
    };
    const file = makeFile(`
      // No import from "./helpers" — should not match.
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      const app = {};
      const handlers = { list() {} };
      registerCrud(app, "users", handlers);
    `);
    const units = discoverUnits(file, [matchingPattern]);
    expect(units).toHaveLength(0);
  });

  it("supports a single-handler template without property access", () => {
    const pattern: DiscoveryPattern = {
      kind: "handler",
      match: {
        type: "registrationTemplate",
        helperName: "registerSimple",
        registrations: [
          { method: "get", pathTemplate: "{1}", handlerArg: "{2}" },
        ],
      },
    };
    const file = makeFile(`
      function registerSimple(_app: unknown, _path: string, _h: () => void) {}
      const app = {};
      function myHandler() {}
      registerSimple(app, "/health", myHandler);
    `);
    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(1);
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/health" });
  });
});
