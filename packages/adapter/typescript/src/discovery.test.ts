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

  it("discovers default export component using the function's own name", () => {
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
    // Component identity is the function name when one exists — the
    // React pack relies on this to distinguish default-exported
    // components across files.
    expect(units[0].name).toBe("UserPage");
    expect(units[0].kind).toBe("component");
  });

  it("falls back to 'default' for anonymous default exports", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "anon.ts",
      `
      export default () => null;
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
    kind: "client",
    match: {
      type: "clientCall",
      importModule: "global",
      importName: "fetch",
    },
  };
}

function makeClientCallPattern(): DiscoveryPattern {
  return {
    kind: "client",
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
    expect(units[0].kind).toBe("client");
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
    expect(units[0].kind).toBe("client");
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
      kind: "client",
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
      kind: "client",
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

  it("matches method calls directly on the imported binding (axios style)", () => {
    // axios pattern: `import axios from "axios"; axios.get(...)` — the import
    // itself is the client object, no construction call.
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import axios from "axios";

      export async function loadUser(id: string) {
        return axios.get("/users/" + id);
      }
    `,
    );

    const pattern: DiscoveryPattern = {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: ["get"],
      },
    };

    const units = discoverUnits(file, [pattern]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadUser");
    expect(units[0].callSite?.methodName).toBe("get");
  });

  it("attaches the source pattern to each discovered unit", () => {
    // Required so adapter.extractFromSourceFile picks the right
    // bindingExtraction when several discovery patterns share the same kind
    // (e.g. axios's per-verb patterns).
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      import axios from "axios";

      export async function getUser() {
        return axios.get("/u");
      }

      export async function createUser() {
        return axios.post("/u", {});
      }
    `,
    );

    const getPattern: DiscoveryPattern = {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: ["get"],
      },
    };
    const postPattern: DiscoveryPattern = {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: ["post"],
      },
    };

    const units = discoverUnits(file, [getPattern, postPattern]);
    expect(units).toHaveLength(2);

    const get = units.find((u) => u.name === "getUser");
    const post = units.find((u) => u.name === "createUser");
    expect(get?.pattern).toBe(getPattern);
    expect(post?.pattern).toBe(postPattern);
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

// ---------------------------------------------------------------------------
// resolverMap discovery
// ---------------------------------------------------------------------------

function makeResolverMapPattern(
  overrides: Partial<
    Extract<DiscoveryPattern["match"], { type: "resolverMap" }>
  > = {},
): DiscoveryPattern {
  return {
    kind: "resolver",
    match: {
      type: "resolverMap",
      importModule: "@apollo/server",
      importName: "ApolloServer",
      mapProperty: "resolvers",
      ...overrides,
    },
  };
}

describe("resolverMap discovery", () => {
  it("finds resolvers via shorthand `new ApolloServer({ resolvers })`", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      const resolvers = {
        Query: { ping: () => "pong", users: async () => [] },
        Mutation: { signIn: async () => ({ token: "x" }) },
      };
      new ApolloServer({ typeDefs: "", resolvers });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["Mutation.signIn", "Query.ping", "Query.users"]);
    for (const u of units) {
      expect(u.kind).toBe("resolver");
      expect(u.resolverInfo).toBeDefined();
    }
    const ping = units.find((u) => u.name === "Query.ping");
    expect(ping?.resolverInfo).toEqual({
      typeName: "Query",
      fieldName: "ping",
    });
  });

  it("finds resolvers via inline `resolvers: { ... }`", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query: { ping: () => "pong" },
        },
      });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("peels `satisfies Resolvers` around the resolvers const", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      type R = Record<string, Record<string, (...a: unknown[]) => unknown>>;
      const resolvers = {
        Query: { ping: () => "pong" },
      } satisfies R;
      new ApolloServer({ typeDefs: "", resolvers });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("discovers method-shorthand resolver functions", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({
        typeDefs: "",
        resolvers: {
          Mutation: {
            async signIn(_: unknown, args: { name: string }) {
              return { token: args.name };
            },
          },
        },
      });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units.map((u) => u.name)).toEqual(["Mutation.signIn"]);
  });

  it("honors excludeTypes", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query:        { ping: () => "pong" },
          Subscription: { onTick: () => "tick" },
        },
      });
    `,
    );
    const units = discoverUnits(file, [
      makeResolverMapPattern({ excludeTypes: ["Subscription"] }),
    ]);
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("skips non-function values inside a type's field map", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query: {
            ping: () => "pong",
            banner: "HELLO",       // string, not a function
          },
        },
      });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("returns nothing when the ApolloServer import is absent", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      const resolvers = { Query: { ping: () => "pong" } };
      const server = { resolvers };
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units).toEqual([]);
  });

  it("returns nothing when the constructor arg isn't an object literal", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      declare const config: any;
      new ApolloServer(config);
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units).toEqual([]);
  });

  it("returns nothing when resolvers is absent from the config", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({ typeDefs: "" });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units).toEqual([]);
  });

  it("returns nothing when resolvers can't be traced to an object literal", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      declare const dynamicResolvers: any;
      new ApolloServer({ typeDefs: "", resolvers: dynamicResolvers });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units).toEqual([]);
  });

  it("also matches a bare call (`apolloServer({ resolvers: {...} })`), not just `new`", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      ApolloServer({
        typeDefs: "",
        resolvers: { Query: { ping: () => "pong" } },
      });
    `,
    );
    const units = discoverUnits(file, [makeResolverMapPattern()]);
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });
});

// ---------------------------------------------------------------------------
// graphqlHookCall discovery (consumer side — Apollo client)
// ---------------------------------------------------------------------------

function makeGraphqlHookPattern(
  overrides: Partial<
    Extract<DiscoveryPattern["match"], { type: "graphqlHookCall" }>
  > = {},
): DiscoveryPattern {
  return {
    kind: "client",
    match: {
      type: "graphqlHookCall",
      importModule: "@apollo/client",
      hookNames: ["useQuery", "useMutation", "useSubscription"],
      ...overrides,
    },
  };
}

describe("graphqlHookCall discovery", () => {
  it("extracts operation identity from an inline gql tagged template", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function usePet() {
        return useQuery(gql\`query GetPet { pet { id } }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo).toMatchObject({
      operationType: "query",
      operationName: "GetPet",
    });
    expect(units[0].operationInfo?.document).toContain("query GetPet");
    expect(units[0].kind).toBe("client");
  });

  it("chases a const-bound gql document to its declaration", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      const GET_PET = gql\`query GetPet { pet { id } }\`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo?.operationName).toBe("GetPet");
  });

  it("resolves a TypedDocumentNode reference produced by GraphQL Code Generator", () => {
    // Codegen-shaped call sites pass a generated DocumentNode object
    // literal (not a `gql` template) to the hook. The discovery
    // walks the identifier to its declaration, evaluates the JSON-
    // shaped AST, and round-trips through `print()` so the operation
    // header matches the same code path as gql-tagged templates.
    const project = createProject();
    const generated = project.createSourceFile(
      "generated.ts",
      `
      export const GetPetDocument = {
        kind: "Document",
        definitions: [
          {
            kind: "OperationDefinition",
            operation: "query",
            name: { kind: "Name", value: "GetPet" },
            variableDefinitions: [
              {
                kind: "VariableDefinition",
                variable: { kind: "Variable", name: { kind: "Name", value: "id" } },
                type: { kind: "NonNullType", type: { kind: "NamedType", name: { kind: "Name", value: "ID" } } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "pet" }, selectionSet: { kind: "SelectionSet", selections: [{ kind: "Field", name: { kind: "Name", value: "id" } }] } },
              ],
            },
          },
        ],
      } as unknown as { kind: "Document"; definitions: unknown[] };
    `,
    );
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      import { GetPetDocument } from "./generated";
      export function usePet() {
        return useQuery(GetPetDocument);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    // Touch the generated file so the symbol resolution doesn't
    // garbage-collect it (avoids unused-import warnings in some
    // ts-morph configurations).
    expect(generated.getFilePath()).toContain("generated.ts");
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo).toMatchObject({
      operationType: "query",
      operationName: "GetPet",
    });
    expect(units[0].operationInfo?.variables[0]).toMatchObject({
      name: "id",
      type: "ID!",
      required: true,
    });
    expect(units[0].operationInfo?.rootFields).toEqual(["pet"]);
  });

  it("records mutation operationType", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useMutation } from "@apollo/client";
      export function useCreatePet() {
        return useMutation(gql\`mutation CreatePet { createPet { id } }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo).toMatchObject({
      operationType: "mutation",
      operationName: "CreatePet",
    });
  });

  it("records subscription operationType", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useSubscription } from "@apollo/client";
      export function useTicks() {
        return useSubscription(gql\`subscription OnTick { tick }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo?.operationType).toBe("subscription");
  });

  it("handles anonymous queries (no operation name)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function usePing() {
        return useQuery(gql\`query { ping }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo).toMatchObject({ operationType: "query" });
    expect(units[0].operationInfo?.operationName).toBeUndefined();
    expect(units[0].name).toBe("usePing.<anon-query>");
  });

  it("handles the shorthand `{ ... }` anonymous query", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function usePing() {
        return useQuery(gql\`{ ping }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo).toMatchObject({ operationType: "query" });
  });

  it("honors import aliases", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery as useApolloQuery } from "@apollo/client";
      export function usePet() {
        return useApolloQuery(gql\`query GetPet { pet { id } }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].callSite?.methodName).toBe("useQuery"); // canonical preserved
  });

  it("returns [] when the module isn't imported", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      declare function useQuery(doc: unknown): unknown;
      export function usePet() {
        return useQuery({ query: "x" });
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toEqual([]);
  });

  it("skips calls whose first argument isn't a gql-tagged template", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      declare const doc: unknown;
      export function usePet() {
        return useQuery(doc as any);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toEqual([]);
  });

  it("skips tagged templates whose tag isn't `gql`", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      function css(strings: TemplateStringsArray) { return strings[0]; }
      export function usePet() {
        return useQuery(css\`query GetPet { pet { id } }\` as any);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toEqual([]);
  });

  it("skips hook calls with no arguments", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      export function usePet() {
        return (useQuery as any)();
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toEqual([]);
  });

  it("skips calls whose enclosing scope isn't a function", () => {
    // Top-level `useQuery(GET)` not inside any function — rare but
    // possible in a module-scope setup. Discovery should bail rather
    // than attach to the module.
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      const GET = gql\`query G { a }\`;
      useQuery(GET);
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toEqual([]);
  });

  it("names via variable declaration when the enclosing function is an arrow", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export const usePet = () => useQuery(gql\`query GetPet { pet { id } }\`);
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].name).toBe("usePet.GetPet");
  });

  it("surfaces variable declarations from the operation header", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function usePet() {
        return useQuery(gql\`query GetPet($id: ID!, $name: String) { pet(id: $id) { id } }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo?.variables).toEqual([
      { name: "id", type: "ID!", required: true },
      { name: "name", type: "String", required: false },
    ]);
  });

  it("captures nested selection set per root field", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function usePet() {
        return useQuery(gql\`query GetPet { pet { id name } pets { count } }\`);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units[0].operationInfo?.rootFields).toEqual(["pet", "pets"]);
  });
});

// ---------------------------------------------------------------------------
// graphqlImperativeCall discovery
// ---------------------------------------------------------------------------

function makeImperativePattern(): DiscoveryPattern {
  return {
    kind: "client",
    match: {
      type: "graphqlImperativeCall",
      importModule: "@apollo/client",
      importName: "ApolloClient",
      methods: [
        {
          methodName: "query",
          documentKey: "query",
          operationType: "query",
        },
        {
          methodName: "mutate",
          documentKey: "mutation",
          operationType: "mutation",
        },
      ],
    },
  };
}

describe("graphqlImperativeCall discovery", () => {
  it("finds client.query({ query: gql`...` })", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: ApolloClient<unknown>;
      export async function loadPet() {
        return client.query({ query: gql\`query LoadPet { pet { id } }\` });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadPet.LoadPet");
    expect(units[0].operationInfo?.operationType).toBe("query");
  });

  it("finds client.mutate({ mutation: gql`...` })", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: ApolloClient<unknown>;
      export async function createPet() {
        return client.mutate({ mutation: gql\`mutation CreatePet { createPet { id } }\` });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units[0].operationInfo?.operationType).toBe("mutation");
    expect(units[0].operationInfo?.operationName).toBe("CreatePet");
  });

  it("resolves a const-bound document to its declaration", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      const LOAD = gql\`query LoadPet { pet { id } }\`;
      declare const client: ApolloClient<unknown>;
      export async function loadPet() {
        return client.query({ query: LOAD });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units[0].operationInfo?.operationName).toBe("LoadPet");
  });

  it("returns [] when ApolloClient isn't imported", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql } from "@apollo/client";
      declare const client: { query: (o: unknown) => Promise<unknown> };
      export async function loadPet() {
        return client.query({ query: gql\`query LoadPet { pet { id } }\` });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units).toEqual([]);
  });

  it("skips method calls whose method name isn't in the spec", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: any;
      export async function run() {
        return client.somethingElse({ query: gql\`query G { g }\` });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units).toEqual([]);
  });

  it("skips calls missing the document-key property", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: any;
      export async function run() {
        return client.query({ variables: {} } as any);
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units).toEqual([]);
  });

  it("uses the method spec's operationType for anonymous docs", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: ApolloClient<unknown>;
      export async function loadPet() {
        return client.query({ query: gql\`{ pet { id } }\` });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    // Anonymous doc — method spec declares operationType: "query".
    expect(units[0].operationInfo?.operationType).toBe("query");
    expect(units[0].operationInfo?.operationName).toBeUndefined();
  });

  it("resolves shorthand `{ query }` when the binding is a gql-tagged const", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      const query = gql\`query ShorthandQ { pet { id } }\`;
      declare const client: ApolloClient<unknown>;
      export async function run() {
        return client.query({ query });
      }
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units[0].operationInfo?.operationName).toBe("ShorthandQ");
  });

  it("names an anonymous-arrow-in-IIFE caller as <anon>", () => {
    // Exercises `functionNameOrAnon`'s fall-through branch — the
    // enclosing function is an arrow whose parent is NOT a
    // variable declaration (e.g. passed inline to an IIFE).
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { ApolloClient, gql } from "@apollo/client";
      declare const client: ApolloClient<unknown>;
      (async () => {
        await client.query({ query: gql\`query IIFE { pet { id } }\` });
      })();
    `,
    );
    const units = discoverUnits(file, [makeImperativePattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("<anon>.IIFE");
  });
});

// ---------------------------------------------------------------------------
// decoratedMethod discovery (NestJS-style)
// ---------------------------------------------------------------------------

function makeDecoratedMethodPattern(
  overrides: Partial<
    Extract<DiscoveryPattern["match"], { type: "decoratedMethod" }>
  > = {},
): DiscoveryPattern {
  return {
    kind: "resolver",
    match: {
      type: "decoratedMethod",
      importModule: "@nestjs/graphql",
      classDecorators: ["Resolver"],
      methodDecorators: ["Query", "Mutation", "ResolveField", "Subscription"],
      ...overrides,
    },
  };
}

describe("decoratedMethod discovery", () => {
  it("returns no units when the framework module isn't imported", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      // No @nestjs/graphql import — the file just happens to have
      // a class with a Resolver decorator from elsewhere.
      declare const Resolver: ClassDecorator;
      declare const Query: MethodDecorator;
      @Resolver
      class Stub {
        @Query
        ping() { return "pong"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units).toHaveLength(0);
  });

  it("returns no units when a class lacks the class-level decorator", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { Query } from "@nestjs/graphql";
      class NotAResolver {
        @Query()
        ping() { return "pong"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units).toHaveLength(0);
  });

  it("accepts wrapper class decorators imported from project paths", () => {
    // Match the Twenty pattern: project-internal `@MetadataResolver`
    // factory composed from `@Resolver()` from `@nestjs/graphql`. The
    // gate accepts the wrapper because at least one method decorator
    // (`Query`) is imported from the framework module.
    const project = createProject();
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Query } from "@nestjs/graphql";
      import { MetadataResolver } from "src/internal/metadata-resolver.decorator";

      @MetadataResolver(() => Foo)
      class FooResolver {
        @Query()
        all(): Foo[] { return []; }
      }
      declare class Foo {}
    `,
    );
    const units = discoverUnits(file, [
      makeDecoratedMethodPattern({
        classDecorators: ["Resolver", "MetadataResolver"],
      }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].resolverInfo).toEqual({
      typeName: "Foo",
      fieldName: "all",
    });
  });

  it("falls back to the operation kind for typeName when @Resolver() is bare", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { Mutation, Resolver } from "@nestjs/graphql";
      @Resolver()
      class Bare {
        @Mutation()
        signOut() { return true; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units[0].resolverInfo).toEqual({
      typeName: "Mutation",
      fieldName: "signOut",
    });
  });

  it("ignores methods without a recognised method-level decorator", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { Query, Resolver } from "@nestjs/graphql";
      @Resolver(() => Pet)
      class PetResolver {
        @Query()
        all(): Pet[] { return []; }

        // No GraphQL decorator — a plain method on the class
        // shouldn't surface as a resolver.
        format(p: Pet): string { return p.id; }
      }
      declare class Pet { id: string; }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].resolverInfo?.fieldName).toBe("all");
  });
});
