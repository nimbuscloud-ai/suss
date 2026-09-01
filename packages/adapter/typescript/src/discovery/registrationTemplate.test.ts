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
    const units = discoverUnits(file, [CRUD_PATTERN], new ResolutionStore());
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
    const units = discoverUnits(file, [CRUD_PATTERN], new ResolutionStore());
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
    const units = discoverUnits(file, [CRUD_PATTERN], new ResolutionStore());
    expect(units).toHaveLength(0);
  });

  it("skips registrations whose handler arg can't be resolved", () => {
    const file = makeFile(`
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      function getHandlers(): { list: () => void } { return { list: () => {} }; }
      const app = {};
      // Handler arg is a call result, out of v0 scope.
      registerCrud(app, "users", getHandlers());
    `);
    const units = discoverUnits(file, [CRUD_PATTERN], new ResolutionStore());
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
      // No import from "./helpers", should not match.
      function registerCrud(_app: unknown, _resource: string, _handlers: any) {}
      const app = {};
      const handlers = { list() {} };
      registerCrud(app, "users", handlers);
    `);
    const units = discoverUnits(file, [matchingPattern], new ResolutionStore());
    expect(units).toHaveLength(0);
  });

  it("matches a helper the config's own path points at", () => {
    const { file, pattern } = projectWithHelperIn("/routes/crud.ts");

    const units = discoverUnits(file, [pattern], new ResolutionStore());

    expect(units.map((unit) => unit.routeInfo)).toEqual([
      { method: "GET", path: "/users" },
    ]);
  });

  it("matches nothing when the config's path is not where the helper is", () => {
    const { file, pattern } = projectWithHelperIn("/routes/crud.ts", "/nope");

    expect(discoverUnits(file, [pattern], new ResolutionStore())).toEqual([]);
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
    const units = discoverUnits(file, [pattern], new ResolutionStore());
    expect(units).toHaveLength(1);
    expect(units[0]?.routeInfo).toEqual({ method: "GET", path: "/health" });
  });
});

describe("registrationTemplate discovery, a handler the call names", () => {
  it("reads handlers off an object another module exports", () => {
    const project = makeProject();
    project.createSourceFile(
      "handlers.ts",
      `
      export const userHandlers = {
        list() {},
        create() {},
        update() {},
        remove() {},
      };
    `,
    );
    const file = project.createSourceFile(
      "user.ts",
      `
      import { userHandlers } from "./handlers.js";
      function registerCrud(_app: unknown, _resource: string, _handlers: unknown) {}
      const app = {};
      registerCrud(app, "users", userHandlers);
    `,
    );

    const units = discoverUnits(file, [CRUD_PATTERN], new ResolutionStore());
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
});

/**
 * A route a helper registers belongs to the app the call site passed,
 * which is what a middleware registered on the same app is keyed on.
 */
describe("registrationTemplate discovery, the app the call passed", () => {
  const withSubject: DiscoveryPattern = {
    kind: "handler",
    match: {
      type: "registrationTemplate",
      helperName: "registerCrud",
      subject: {
        argument: 0,
        importModule: "express",
        importNames: ["Router", "express"],
      },
      registrations: [
        { method: "get", pathTemplate: "/{1}", handlerArg: "{2}.list" },
      ],
    },
  };

  function callingWithApp(): SourceFile {
    const project = makeProject();
    project.createSourceFile(
      "/node_modules/express/package.json",
      JSON.stringify({ name: "express", types: "index.d.ts" }),
    );
    project.createSourceFile(
      "/node_modules/express/index.d.ts",
      `
        export interface Express { get(p: string, h: unknown): void }
        export function Router(): Express;
        declare function express(): Express;
        export default express;
      `,
    );
    return project.createSourceFile(
      "/app.ts",
      `
        import express from "express";
        function registerCrud(_app: unknown, _resource: string, _handlers: unknown) {}
        const app = express();
        registerCrud(app, "users", { list() {} });
      `,
    );
  }

  it("keys the unit on the app's own creation site", () => {
    const [unit] = discoverUnits(
      callingWithApp(),
      [withSubject],
      new ResolutionStore(),
    );

    expect(unit?.registrationSubjectId).toContain("/app.ts");
  });

  it("keys on nothing when the pattern does not say which argument", () => {
    const [unit] = discoverUnits(
      callingWithApp(),
      [CRUD_PATTERN],
      new ResolutionStore(),
    );

    expect(unit?.registrationSubjectId).toBeUndefined();
  });
});

/**
 * A project whose helper is written in `helperFile` and imported by the
 * call site, with a pattern whose `importModule` is the resolved path a
 * pack hands over. `configPath` defaults to the helper's own file.
 */
function projectWithHelperIn(helperFile: string, configPath?: string) {
  const project = makeProject();
  project.createSourceFile(
    helperFile,
    `
      export function registerCrud(_app: unknown, _resource: string, _handlers: unknown) {}
    `,
  );
  const file = project.createSourceFile(
    "user.ts",
    `
      import { registerCrud } from ".${helperFile.replace(/\.ts$/, "")}";
      const app = {};
      registerCrud(app, "users", { list() {} });
    `,
  );
  const pattern: DiscoveryPattern = {
    kind: "handler",
    match: {
      type: "registrationTemplate",
      helperName: "registerCrud",
      importModule: configPath ?? helperFile.replace(/\.ts$/, ""),
      registrations: [
        { method: "get", pathTemplate: "/{1}", handlerArg: "{2}.list" },
      ],
    },
  };
  return { file, pattern };
}
