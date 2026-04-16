// discovery.test.ts — exhaustive tests for discoverUnits (Task 2.4)

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { discoverUnits } from "./discovery.js";

import type { DiscoveryPattern } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProject() {
  return new Project({ useInMemoryFileSystem: true });
}

function makeNamedExportPattern(
  names: string[],
  kind = "handler",
): DiscoveryPattern {
  return {
    kind,
    match: { type: "namedExport", names },
  };
}

function makeTsRestPattern(): DiscoveryPattern {
  return {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "@ts-rest/express",
      importName: "initServer",
      registrationChain: [".router"],
    },
  };
}

function makeExpressPattern(): DiscoveryPattern {
  return {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "express",
      importName: "Router",
      registrationChain: [".get", ".post", ".put", ".delete", ".patch"],
    },
  };
}

// ---------------------------------------------------------------------------
// namedExport — function declaration form
// ---------------------------------------------------------------------------

describe("namedExport — export function loader()", () => {
  it("finds exported function loader", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function loader(args: any) {
        return args;
      }
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["loader"])]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loader");
    expect(units[0].kind).toBe("handler");
  });

  it("does NOT find non-exported function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function loader(args: any) {
        return args;
      }
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["loader"])]);
    expect(units).toHaveLength(0);
  });

  it("does NOT find exported function with wrong name", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function action(args: any) {
        return args;
      }
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["loader"])]);
    expect(units).toHaveLength(0);
  });

  it("finds both loader and action when both exported", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function loader(args: any) { return args; }
      export function action(args: any) { return args; }
    `,
    );

    const units = discoverUnits(file, [
      makeNamedExportPattern(["loader", "action"]),
    ]);
    expect(units).toHaveLength(2);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["action", "loader"]);
  });
});

// ---------------------------------------------------------------------------
// namedExport — arrow function form
// ---------------------------------------------------------------------------

describe("namedExport — export const loader = async () => {}", () => {
  it("finds exported arrow function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export const action = async (args: any) => {
        return args;
      };
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["action"])]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("action");
  });

  it("does NOT find non-exported arrow function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const loader = async (args: any) => args;
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["loader"])]);
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// namedExport — function expression form
// ---------------------------------------------------------------------------

describe("namedExport — export const loader = async function() {}", () => {
  it("finds exported function expression", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export const loader = async function(args: any) {
        return args;
      };
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["loader"])]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loader");
  });
});

// ---------------------------------------------------------------------------
// namedExport — default export form
// ---------------------------------------------------------------------------

describe("namedExport — export default function", () => {
  it("finds default export function when name is 'default'", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export default function(args: any) {
        return args;
      }
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["default"])]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// registrationCall — ts-rest style
// ---------------------------------------------------------------------------

describe("registrationCall — ts-rest style (initServer / s.router)", () => {
  it("finds single handler in s.router(contract, { handlerA: async () => {} })", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const resource = s.router(apiContract.repository, {
        handlerA: async ({ params }: any) => {
          return { status: 200, body: {} };
        },
      });
    `,
    );

    const units = discoverUnits(file, [makeTsRestPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("handlerA");
    expect(units[0].kind).toBe("handler");
  });

  it("finds multiple handlers in s.router()", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const resource = s.router(apiContract, {
        getUser: async ({ params }: any) => ({ status: 200, body: {} }),
        createUser: async ({ body }: any) => ({ status: 201, body: {} }),
        deleteUser: async ({ params }: any) => ({ status: 204, body: null }),
      });
    `,
    );

    const units = discoverUnits(file, [makeTsRestPattern()]);
    expect(units).toHaveLength(3);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["createUser", "deleteUser", "getUser"]);
  });

  it("finds method shorthand handler in s.router()", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const resource = s.router(apiContract, {
        async getUser({ params }: any) {
          return { status: 200, body: {} };
        },
        createUser: async ({ body }: any) => ({ status: 201, body: {} }),
      });
    `,
    );

    const units = discoverUnits(file, [makeTsRestPattern()]);
    expect(units).toHaveLength(2);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["createUser", "getUser"]);
  });

  it("returns empty array when import is missing", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const s = { router: (a: any, b: any) => b };
      export const resource = s.router({}, {
        handler: async () => ({ status: 200, body: {} }),
      });
    `,
    );

    const units = discoverUnits(file, [makeTsRestPattern()]);
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// registrationCall — Express Router style
// ---------------------------------------------------------------------------

describe("registrationCall — Express Router style", () => {
  it("finds router.get() handler", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/users", (req: any, res: any) => {
        res.json({ users: [] });
      });
    `,
    );

    const units = discoverUnits(file, [makeExpressPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("get");
  });

  it("finds router.post() handler", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.post("/users", (req: any, res: any) => {
        res.status(201).json({ id: 1 });
      });
    `,
    );

    const units = discoverUnits(file, [makeExpressPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("post");
  });

  it("finds multiple routes", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/users", (req: any, res: any) => { res.json([]); });
      router.post("/users", (req: any, res: any) => { res.status(201).json({}); });
      router.delete("/users/:id", (req: any, res: any) => { res.status(204).send(); });
    `,
    );

    const units = discoverUnits(file, [makeExpressPattern()]);
    expect(units).toHaveLength(3);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["delete", "get", "post"]);
  });

  it("skips routes where last arg is NOT a function literal (named function ref)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      function myHandler(req: any, res: any) { res.json({}); }
      router.get("/path", myHandler);
    `,
    );

    const units = discoverUnits(file, [makeExpressPattern()]);
    // myHandler is an identifier, not an inline arrow/function — should be skipped
    expect(units).toHaveLength(0);
  });

  it("finds arrow function handler", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/path", (req: any, res: any) => res.json({ ok: true }));
    `,
    );

    const units = discoverUnits(file, [makeExpressPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("get");
  });
});

// ---------------------------------------------------------------------------
// decorator and fileConvention — stubs
// ---------------------------------------------------------------------------

describe("decorator and fileConvention — stubs return []", () => {
  it("decorator pattern returns empty array", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function handler() {}
    `,
    );

    const pattern: DiscoveryPattern = {
      kind: "handler",
      match: {
        type: "decorator",
        decoratorModule: "nest",
        decoratorName: "Get",
      },
    };

    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(0);
  });

  it("fileConvention pattern returns empty array", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function handler() {}
    `,
    );

    const pattern: DiscoveryPattern = {
      kind: "handler",
      match: {
        type: "fileConvention",
        filePattern: "**/*.handler.ts",
        exportNames: ["handler"],
      },
    };

    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deduplication
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("deduplicates same function found by two namedExport patterns with same kind", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function loader(args: any) { return args; }
    `,
    );

    const pattern1 = makeNamedExportPattern(["loader"], "handler");
    const pattern2 = makeNamedExportPattern(["loader"], "handler");

    const units = discoverUnits(file, [pattern1, pattern2]);
    expect(units).toHaveLength(1);
  });

  it("keeps both entries when same function found with different kinds", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function loader(args: any) { return args; }
    `,
    );

    const pattern1 = makeNamedExportPattern(["loader"], "handler");
    const pattern2 = makeNamedExportPattern(["loader"], "loader");

    const units = discoverUnits(file, [pattern1, pattern2]);
    expect(units).toHaveLength(2);
    const kinds = units.map((u) => u.kind).sort();
    expect(kinds).toEqual(["handler", "loader"]);
  });
});

// ---------------------------------------------------------------------------
// namedExport — React Router discovery patterns
// ---------------------------------------------------------------------------

describe("namedExport — React Router style (loader, action, default)", () => {
  function makeReactRouterPatterns(): DiscoveryPattern[] {
    return [
      { kind: "loader", match: { type: "namedExport", names: ["loader"] } },
      { kind: "action", match: { type: "namedExport", names: ["action"] } },
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
      },
    ];
  }

  it("discovers loader and action from the same file", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export async function loader({ params }: any) {
        return { user: "test" };
      }
      export async function action({ request }: any) {
        return { ok: true };
      }
    `,
    );

    const units = discoverUnits(file, makeReactRouterPatterns());
    expect(units).toHaveLength(2);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["action", "loader"]);
    expect(units.find((u) => u.name === "loader")?.kind).toBe("loader");
    expect(units.find((u) => u.name === "action")?.kind).toBe("action");
  });

  it("discovers default export component", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export default function UserPage() {
        return null;
      }
    `,
    );

    const units = discoverUnits(file, makeReactRouterPatterns());
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("default");
    expect(units[0].kind).toBe("component");
  });

  it("discovers all three: loader, action, and default component", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export async function loader({ params }: any) {
        return { data: "loaded" };
      }
      export async function action({ request }: any) {
        return { ok: true };
      }
      export default function Page() {
        return null;
      }
    `,
    );

    const units = discoverUnits(file, makeReactRouterPatterns());
    expect(units).toHaveLength(3);
    const kinds = units.map((u) => u.kind).sort();
    expect(kinds).toEqual(["action", "component", "loader"]);
  });

  it("discovers arrow function loader", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export const loader = async ({ params }: any) => {
        return { data: params.id };
      };
    `,
    );

    const units = discoverUnits(file, makeReactRouterPatterns());
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loader");
    expect(units[0].kind).toBe("loader");
  });
});

// ---------------------------------------------------------------------------
// clientCall — global (fetch)
// ---------------------------------------------------------------------------

function makeFetchPattern(): DiscoveryPattern {
  return {
    kind: "consumer",
    match: {
      type: "clientCall",
      importModule: "global",
      importName: "fetch",
    },
  };
}

function makeClientCallPattern(): DiscoveryPattern {
  return {
    kind: "consumer",
    match: {
      type: "clientCall",
      importModule: "./api-client",
      importName: "initClient",
    },
  };
}

describe("clientCall — global fetch", () => {
  it("discovers function containing a bare fetch() call", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export async function loadUser(id: string) {
        const res = await fetch("/users/" + id);
        if (res.ok) {
          return res.json();
        }
        throw new Error("failed");
      }
    `,
    );

    const units = discoverUnits(file, [makeFetchPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadUser");
    expect(units[0].kind).toBe("consumer");
    expect(units[0].callSite).toBeDefined();
    expect(units[0].callSite?.methodName).toBeNull();
  });

  it("discovers arrow function containing fetch()", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export const getUsers = async () => {
        const res = await fetch("/users");
        return res.json();
      };
    `,
    );

    const units = discoverUnits(file, [makeFetchPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("getUsers");
  });

  it("does not discover fetch at top level (no enclosing function)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const res = await fetch("/health");
    `,
    );

    const units = discoverUnits(file, [makeFetchPattern()]);
    expect(units).toHaveLength(0);
  });

  it("ignores non-fetch global calls", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export async function doStuff() {
        const res = await setTimeout(() => {}, 100);
        return res;
      }
    `,
    );

    const units = discoverUnits(file, [makeFetchPattern()]);
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clientCall — imported client (ts-rest style)
// ---------------------------------------------------------------------------

describe("clientCall — imported client", () => {
  it("discovers function containing client.method() call", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient } from "./api-client";
      const client = initClient(contract);

      export async function loadUser(id: string) {
        const result = await client.getUser({ params: { id } });
        if (result.status === 404) {
          return null;
        }
        return result.body;
      }
    `,
    );

    const units = discoverUnits(file, [makeClientCallPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadUser");
    expect(units[0].kind).toBe("consumer");
    expect(units[0].callSite?.methodName).toBe("getUser");
  });

  it("discovers multiple consumer functions for different client methods", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient } from "./api-client";
      const client = initClient(contract);

      export async function loadUser(id: string) {
        return client.getUser({ params: { id } });
      }

      export async function createUser(data: any) {
        return client.createUser({ body: data });
      }
    `,
    );

    const units = discoverUnits(file, [makeClientCallPattern()]);
    expect(units).toHaveLength(2);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["createUser", "loadUser"]);
  });

  it("does not discover calls on non-matching variables", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient } from "./api-client";
      const client = initClient(contract);
      const other = someOtherThing();

      export async function doStuff() {
        return other.getUser({ params: { id: "1" } });
      }
    `,
    );

    const units = discoverUnits(file, [makeClientCallPattern()]);
    expect(units).toHaveLength(0);
  });

  it("respects methodFilter when set", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient } from "./api-client";
      const client = initClient(contract);

      export async function loadUser() {
        return client.getUser({ params: { id: "1" } });
      }

      export async function createUser() {
        return client.createUser({ body: {} });
      }
    `,
    );

    const pattern: DiscoveryPattern = {
      kind: "consumer",
      match: {
        type: "clientCall",
        importModule: "./api-client",
        importName: "initClient",
        methodFilter: ["getUser"],
      },
    };

    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(1);
    expect(units[0].callSite?.methodName).toBe("getUser");
  });

  it("handles aliased import", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient as createApi } from "./api-client";
      const api = createApi(contract);

      export async function loadUser() {
        return api.getUser({ params: { id: "1" } });
      }
    `,
    );

    // The pattern matches importName = the original name, but we resolve through aliases
    const pattern: DiscoveryPattern = {
      kind: "consumer",
      match: {
        type: "clientCall",
        importModule: "./api-client",
        importName: "initClient",
      },
    };

    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadUser");
  });

  it("deduplicates when two calls in the same function match", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { initClient } from "./api-client";
      const client = initClient(contract);

      export async function loadAll() {
        const user = await client.getUser({ params: { id: "1" } });
        const posts = await client.getPosts({ params: { userId: "1" } });
        return { user, posts };
      }
    `,
    );

    const units = discoverUnits(file, [makeClientCallPattern()]);
    // Two calls in the same function — should deduplicate to one unit
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadAll");
  });
});

// ---------------------------------------------------------------------------
// multiple patterns combined
// ---------------------------------------------------------------------------

describe("multiple patterns combined", () => {
  it("runs all patterns and collects results", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import { Router } from "express";
      const router = Router();
      router.get("/health", (req: any, res: any) => { res.json({ ok: true }); });

      export function loader(args: any) { return args; }
    `,
    );

    const units = discoverUnits(file, [
      makeExpressPattern(),
      makeNamedExportPattern(["loader"]),
    ]);
    expect(units).toHaveLength(2);
  });
});
