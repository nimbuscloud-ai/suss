// discovery.test.ts: exhaustive tests for discoverUnits (Task 2.4)

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { discoverUnits } from "./discovery/index.js";
import { ResolutionStore } from "./facts/store.js";

import type { DiscoveryPattern } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProject() {
  return createTestProject();
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
// namedExport: function declaration form
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
// namedExport: arrow function form
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
// namedExport: function expression form
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
// namedExport: default export form
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

  it("names the unit after the function the default export states", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function panel(args: any) {
        return args;
      }

      export default panel;
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["default"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("panel");
  });

  it("names the unit after the binding the default export states", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function panelImpl(args: any) {
        return args;
      }
      const panel = panelImpl;

      export default panel;
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["default"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("panel");
    expect(units[0].func?.getText()).toContain("panelImpl");
  });

  it("names the unit after the property the default export reads", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      function panelImpl(args: any) {
        return args;
      }
      const views = { panel: panelImpl };

      export default views.panel;
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["default"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("panel");
  });

  it("names a bound arrow reached as a default after its binding", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/panel.ts",
      `
      export const panel = (args: any) => args;

      export default panel;
    `,
    );
    const barrel = project.createSourceFile(
      "/index.ts",
      `export { default } from "./panel";`,
    );

    const store = new ResolutionStore();
    const declared = discoverUnits(
      file,
      [makeNamedExportPattern(["default"])],
      store,
    );
    expect(declared).toHaveLength(1);
    expect(declared[0].name).toBe("panel");

    // The barrel exports a name for a function it does not contain, so the file that
    // declares it is the one that claims it.
    expect(
      discoverUnits(barrel, [makeNamedExportPattern(["default"])], store),
    ).toHaveLength(0);
  });

  it("leaves a function with no name of its own as the default", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      "export default (args: any) => args;",
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["default"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("default");
  });
});

describe("namedExport, a name bound by taking a container apart", () => {
  it("finds a handler destructured off an object", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const impl = (args: any) => args;
      const { handler } = { handler: impl };

      export { handler };
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["handler"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("handler");
  });

  it("finds a handler bound with a default the container does not hold", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const impl = (args: any) => args;
      const holder: { handler?: (args: any) => any } = {};
      const { handler = impl } = holder;

      export { handler };
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["handler"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
  });

  it("finds nothing when a default sits beside a value the container holds", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      const supplied = (args: any) => args;
      const fallback = (args: any) => args;
      const holder = { handler: supplied };
      const { handler = fallback } = holder;

      export { handler };
    `,
    );

    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["handler"])],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(0);
  });
});

describe("namedExport, an overload set", () => {
  it("reads the declaration carrying the body, once", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export function handler(args: any): any;
      export function handler(args: any): any {
        return args;
      }
    `,
    );

    const units = discoverUnits(file, [makeNamedExportPattern(["handler"])]);
    expect(units).toHaveLength(1);
    expect(units[0].func?.getText()).toContain("return args");
  });
});

// ---------------------------------------------------------------------------
// registrationCall: ts-rest style
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
// registrationCall: Express Router style
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
    // myHandler is an identifier, not an inline arrow/function, should be skipped
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
// decorator and fileConvention: stubs
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
// namedExport: React Router discovery patterns
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
    // Component identity is the function name when one exists, the
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
// clientCall: global (fetch)
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
// clientCall: imported client (ts-rest style)
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
    // axios pattern: `import axios from "axios"; axios.get(...)`, the import
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
    // Two calls in the same function, should deduplicate to one unit
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("loadAll");
  });
});

// ---------------------------------------------------------------------------
// clientCall, an instance imported from another file
// ---------------------------------------------------------------------------

function makeAxiosLikePattern(): DiscoveryPattern {
  return {
    kind: "client",
    match: {
      type: "clientCall",
      importModule: "axios",
      importName: "axios",
      factoryMethods: ["create"],
    },
  };
}

describe("clientCall, an instance imported from another file", () => {
  it("resolves a subject brought in by a named import", () => {
    const project = createProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      export const client = axios.create({ baseURL: "/api" });
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import { client } from "./api";

      export async function getUser(id: string) {
        return client.get("/users/" + id);
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("getUser");
    expect(units[0].callSite?.methodName).toBe("get");
  });

  it("resolves a subject brought in by a default import", () => {
    const project = createProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      export default axios.create({ baseURL: "/api" });
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import api from "./api";

      export async function listOrders() {
        return api.get("/orders");
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("listOrders");
  });

  it("resolves a subject brought in by an aliased named import", () => {
    const project = createProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      export const client = axios.create({ baseURL: "/api" });
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import { client as http } from "./api";

      export async function getUser() {
        return http.get("/users/1");
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("getUser");
  });

  it("resolves a subject re-exported through a barrel", () => {
    const project = createProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      export const client = axios.create({ baseURL: "/api" });
    `,
    );
    project.createSourceFile(
      "barrel.ts",
      `
      export { client } from "./api";
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import { client } from "./barrel";

      export async function getReport() {
        return client.get("/reports/weekly");
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("getReport");
  });

  it("resolves an instance whose creating file aliases the default import", () => {
    const project = createProject();
    project.createSourceFile(
      "api.ts",
      `
      import ax from "axios";
      export const client = ax.create({ baseURL: "/api" });
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import { client } from "./api";

      export async function getUser() {
        return client.get("/users/1");
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("getUser");
  });

  it("stays silent on a subject the store never ties to a construction", () => {
    const project = createProject();
    project.createSourceFile(
      "other.ts",
      `
      function someOtherFactory() {
        return { get: (url: string) => Promise.resolve(url) };
      }
      export const notAClient = someOtherFactory();
    `,
    );
    const file = project.createSourceFile(
      "consumer.ts",
      `
      import { notAClient } from "./other";

      export async function getUser() {
        return notAClient.get("/users/1");
      }
    `,
    );

    const units = discoverUnits(
      file,
      [makeAxiosLikePattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(0);
  });

  it("resolves a path-shaped factory module by the file it names, and reuses that answer", () => {
    const project = createProject();
    project.createSourceFile(
      "apiClient.ts",
      `
      import axios from "axios";
      export function createApiClient() {
        return axios.create({ baseURL: "/api" });
      }
    `,
    );
    const first = project.createSourceFile(
      "nested/dir/consumer.ts",
      `
      import { createApiClient } from "../../apiClient";

      const api = createApiClient();

      export async function getUser() {
        return api.get("/users/1");
      }
    `,
    );
    const second = project.createSourceFile(
      "nested/other.ts",
      `
      import { createApiClient } from "../apiClient";

      const api = createApiClient();

      export async function listOrders() {
        return api.get("/orders");
      }
    `,
    );

    const factoryPattern: DiscoveryPattern = {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "./apiClient",
        importName: "createApiClient",
      },
    };

    // One store across both files, so the second lookup reads the
    // module resolution the first one cached.
    const store = new ResolutionStore();
    const firstUnits = discoverUnits(first, [factoryPattern], store);
    expect(firstUnits).toHaveLength(1);
    expect(firstUnits[0].name).toBe("getUser");

    const secondUnits = discoverUnits(second, [factoryPattern], store);
    expect(secondUnits).toHaveLength(1);
    expect(secondUnits[0].name).toBe("listOrders");
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

describe("resolverMap discovery, a map assembled across modules", () => {
  it("reads a resolver map another module exports", () => {
    const project = createProject();
    project.createSourceFile(
      "resolvers.ts",
      `
      export const resolvers = {
        Query: { ping: () => "pong" },
      };
    `,
    );
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      import { resolvers } from "./resolvers.js";
      new ApolloServer({ typeDefs: "type Query { ping: String }", resolvers });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("reads a per-type object another module exports", () => {
    const project = createProject();
    project.createSourceFile(
      "query.ts",
      `export const Query = { ping: () => "pong" };`,
    );
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      import { Query } from "./query.js";
      new ApolloServer({ typeDefs: "", resolvers: { Query } });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("reads a resolver the map names rather than writes out", () => {
    const project = createProject();
    project.createSourceFile(
      "ping.ts",
      `export function ping() { return "pong"; }`,
    );
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      import { ping } from "./ping.js";
      new ApolloServer({ typeDefs: "", resolvers: { Query: { ping } } });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
    expect(units[0]?.func?.getText()).toContain("pong");
  });

  it("reads a type's fields built elsewhere and spread in", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      const QueryFields = { ping: () => "pong" };
      const resolvers = { Query: { ...QueryFields, version: () => "1" } };
      new ApolloServer({ typeDefs: "", resolvers });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping", "Query.version"]);
  });

  it("reads whole types another module exports and spreads into the map", () => {
    const project = createProject();
    project.createSourceFile(
      "query.ts",
      `export const queryResolvers = { Query: { ping: () => "pong" } };`,
    );
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      import { queryResolvers } from "./query.js";
      new ApolloServer({ typeDefs: "", resolvers: { ...queryResolvers } });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("walks an object that spreads its way back to itself once", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      const fields: any = { ping: () => "pong", ...(fields ?? {}) };
      new ApolloServer({ typeDefs: "", resolvers: { Query: fields } });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });

  it("reads the schema off a constant another module exports", () => {
    const project = createProject();
    project.createSourceFile(
      "schema.ts",
      "export const typeDefs = `type Query { ping: String }`;",
    );
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      import { typeDefs } from "./schema.js";
      new ApolloServer({ typeDefs, resolvers: { Query: { ping: () => "pong" } } });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units[0]?.resolverInfo?.schemaSdl).toContain("type Query");
  });

  it("says which file declares the schema, so one summary can state it", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      new ApolloServer({
        typeDefs: "type Query { ping: String }",
        resolvers: { Query: { ping: () => "pong" } },
      });
    `,
    );

    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units[0]?.resolverInfo?.schemaDocument).toBe(file.getFilePath());
  });
});

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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
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
    const units = discoverUnits(
      file,
      [makeResolverMapPattern()],
      new ResolutionStore(),
    );
    expect(units.map((u) => u.name)).toEqual(["Query.ping"]);
  });
});

// ---------------------------------------------------------------------------
// graphqlHookCall discovery (consumer side, Apollo client)
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
      hooks: [
        { hookName: "useQuery", operationType: "query" },
        { hookName: "useMutation", operationType: "mutation" },
        { hookName: "useSubscription", operationType: "subscription" },
      ],
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

  it("reports a call whose first argument is not a document as a gap", () => {
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
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo?.operationName).toBeUndefined();
    expect(units[0].operationInfo?.unresolved?.reference).toBe("doc");
  });

  it("does not read a tagged template whose tag isn't a document tag", () => {
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
    expect(units[0]?.operationInfo?.operationName).toBeUndefined();
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
    // Top-level `useQuery(GET)` not inside any function, rare but
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

  it("chases a gql const exported from another module", () => {
    const project = createProject();
    project.createSourceFile(
      "operations.ts",
      `
      import { gql } from "@apollo/client";
      export const GET_PET = gql\`query GetPet($id: ID!) { pet(id: $id) { id } }\`;
    `,
    );
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      import { GET_PET } from "./operations";
      export function usePet(id: string) {
        return useQuery(GET_PET, { variables: { id } });
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
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
    expect(units[0].operationInfo?.unresolved).toBeUndefined();
  });

  it("falls back to TypedDocumentNode type arguments when the body isn't a readable object", () => {
    const project = createProject();
    project.createSourceFile(
      "generated.ts",
      `
      export type TypedDocumentNode<R, V> = { __r?: R; __v?: V };
      export type GetPetQuery = { pet: { id: string } };
      export type GetPetQueryVariables = { id: string };
      declare function build(source: string): unknown;
      export const GetPetDocument = build("query GetPet { pet { id } }") as unknown as TypedDocumentNode<GetPetQuery, GetPetQueryVariables>;
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
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo).toMatchObject({
      operationType: "query",
      operationName: "GetPet",
    });
    // Header-only: no document body, no variables read, gap recorded.
    expect(units[0].operationInfo?.document).toBeUndefined();
    expect(units[0].operationInfo?.variables).toEqual([]);
    expect(units[0].operationInfo?.unresolved).toMatchObject({
      reference: "GetPetDocument",
    });
  });

  it("takes the operation type from the hook when neither body nor type args are readable", () => {
    const project = createProject();
    project.createSourceFile(
      "generated.ts",
      `
      export type TypedDocumentNode<R, V> = { __r?: R; __v?: V };
      declare function build(source: string): unknown;
      export const AdoptDocument = build("mutation { adopt { id } }") as unknown as TypedDocumentNode<{ adopt: unknown }, Record<string, never>>;
    `,
    );
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useMutation } from "@apollo/client";
      import { AdoptDocument } from "./generated";
      export function useAdopt() {
        return useMutation(AdoptDocument);
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units).toHaveLength(1);
    // Operation type from `useMutation`; no name recoverable; gap recorded.
    expect(units[0].operationInfo?.operationType).toBe("mutation");
    expect(units[0].operationInfo?.operationName).toBeUndefined();
    expect(units[0].operationInfo?.unresolved?.reference).toBe("AdoptDocument");
    expect(units[0].name).toBe("useAdopt.AdoptDocument");
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
    // Anonymous doc: method spec declares operationType: "query".
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
    // Exercises `functionNameOrAnon`'s fall-through branch, the
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
      methodDecoratorTypeMap: {
        Query: "Query",
        Mutation: "Mutation",
        Subscription: "Subscription",
      },
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
      // No @nestjs/graphql import: the file just happens to have
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
    // A project-internal decorator factory composed from `@Resolver()`
    // in `@nestjs/graphql`, named through the pack's options. The gate
    // accepts the wrapper because at least one method decorator
    // (`Query`) is imported from the framework module.
    const project = createProject();
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Query } from "@nestjs/graphql";
      import { InternalResolver } from "src/internal/internal-resolver.decorator";

      @InternalResolver(() => Foo)
      class FooResolver {
        @Query()
        all(): Foo[] { return []; }
      }
      declare class Foo {}
    `,
    );
    const units = discoverUnits(file, [
      makeDecoratedMethodPattern({
        classDecorators: ["Resolver", "InternalResolver"],
      }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].resolverInfo).toEqual({
      typeName: "Foo",
      fieldName: "all",
    });
  });

  it("accepts a project decorator built from the framework's own", () => {
    // Nothing refers to the wrapper by name. It is recognized because calling it
    // calls `Resolver` from `@nestjs/graphql`, which is what makes the
    // class a resolver in the first place.
    const project = createProject();
    project.createSourceFile(
      "src/audited.ts",
      `
      import { applyDecorators, SetMetadata } from "@nestjs/common";
      import { Resolver } from "@nestjs/graphql";

      export const AuditedResolver = (typeFunc?: () => unknown) =>
        applyDecorators(
          typeFunc ? Resolver(typeFunc) : Resolver(),
          SetMetadata("audited", true),
        );
    `,
    );
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Query } from "@nestjs/graphql";
      import { AuditedResolver } from "./audited";

      @AuditedResolver(() => Foo)
      class FooResolver {
        @Query()
        all(): Foo[] { return []; }
      }
      declare class Foo {}
    `,
    );
    const units = discoverUnits(
      file,
      [makeDecoratedMethodPattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(1);
    expect(units[0].resolverInfo).toEqual({
      typeName: "Foo",
      fieldName: "all",
    });
  });

  it("reads the type from the wrapper when the class states none", () => {
    // The class says nothing, so what the wrapper hands the framework
    // is what the class means.
    const project = createProject();
    project.createSourceFile(
      "src/scoped.ts",
      `
      import { Resolver } from "@nestjs/graphql";
      export const ScopedResolver = () => Resolver(() => Foo);
      declare class Foo {}
    `,
    );
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Query } from "@nestjs/graphql";
      import { ScopedResolver } from "./scoped";

      @ScopedResolver()
      class FooResolver {
        @Query()
        all(): unknown[] { return []; }
      }
    `,
    );
    const units = discoverUnits(
      file,
      [makeDecoratedMethodPattern()],
      new ResolutionStore(),
    );
    expect(units[0].resolverInfo).toEqual({
      typeName: "Foo",
      fieldName: "all",
    });
  });

  it("takes no type from a wrapper that forwards its own parameter", () => {
    // `@Scoped()` with nothing in the parentheses means a bare
    // `@Resolver()`, and the parameter the wrapper passes along names
    // no type at all. Reading it would report the resolver against a
    // type called `typeFunc`.
    const project = createProject();
    project.createSourceFile(
      "src/scoped.ts",
      `
      import { Resolver } from "@nestjs/graphql";
      export const Scoped = (typeFunc?: () => unknown) => Resolver(typeFunc);
    `,
    );
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Mutation } from "@nestjs/graphql";
      import { Scoped } from "./scoped";

      @Scoped()
      class FooResolver {
        @Mutation()
        signOut(): boolean { return true; }
      }
    `,
    );
    const units = discoverUnits(
      file,
      [makeDecoratedMethodPattern()],
      new ResolutionStore(),
    );
    expect(units[0].resolverInfo).toEqual({
      typeName: "Mutation",
      fieldName: "signOut",
    });
  });

  it("ignores a project decorator that reaches no framework decorator", () => {
    const project = createProject();
    project.createSourceFile(
      "src/logged.ts",
      `
      import { SetMetadata } from "@nestjs/common";
      export const Logged = () => SetMetadata("logged", true);
    `,
    );
    const file = project.createSourceFile(
      "src/foo.resolver.ts",
      `
      import { Query } from "@nestjs/graphql";
      import { Logged } from "./logged";

      @Logged()
      class NotAResolver {
        @Query()
        all(): unknown[] { return []; }
      }
    `,
    );
    const units = discoverUnits(
      file,
      [makeDecoratedMethodPattern()],
      new ResolutionStore(),
    );
    expect(units).toHaveLength(0);
  });

  it("reads typeName off the operation decorator when @Resolver() is bare", () => {
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

  it("reads a resolver written as a property holding an arrow", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { Query, Resolver } from "@nestjs/graphql";
      @Resolver(() => Pet)
      class PetResolver {
        @Query(() => [Pet])
        all = () => [];
      }
      declare class Pet { id: string; }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("PetResolver.all");
    expect(units[0].resolverInfo).toEqual({
      typeName: "Pet",
      fieldName: "all",
    });
  });

  it("names no type for a field resolver on a class that names none", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { ResolveField, Resolver } from "@nestjs/graphql";
      @Resolver()
      class Bare {
        @ResolveField(() => String)
        label() { return "widget"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units[0].resolverInfo).toEqual({
      typeName: null,
      fieldName: "label",
    });
  });

  it("keeps the class's type for a field resolver that has one", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { ResolveField, Resolver } from "@nestjs/graphql";
      @Resolver(() => Widget)
      class WidgetResolver {
        @ResolveField(() => String)
        label() { return "widget"; }
      }
      declare class Widget { id: string; }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedMethodPattern()]);
    expect(units[0].resolverInfo).toEqual({
      typeName: "Widget",
      fieldName: "label",
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

        // No GraphQL decorator: a plain method on the class
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

// ---------------------------------------------------------------------------
// decoratedRoute discovery (NestJS-style REST controllers)
// ---------------------------------------------------------------------------

function makeDecoratedRoutePattern(
  overrides: Partial<
    Extract<DiscoveryPattern["match"], { type: "decoratedRoute" }>
  > = {},
): DiscoveryPattern {
  return {
    kind: "handler",
    match: {
      type: "decoratedRoute",
      importModule: "@nestjs/common",
      classDecorators: ["Controller"],
      methodDecoratorRouteMap: {
        Get: "GET",
        Post: "POST",
        Put: "PUT",
        Delete: "DELETE",
      },
      ...overrides,
    },
  };
}

describe("decoratedRoute discovery", () => {
  it("returns no units when the framework module isn't imported", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      // No @nestjs/common import: the file just happens to have
      // a class with a Controller decorator from elsewhere.
      declare const Controller: ClassDecorator;
      declare const Get: MethodDecorator;
      @Controller
      class Stub {
        @Get
        ping() { return "pong"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    expect(units).toHaveLength(0);
  });

  it("returns no units when a class lacks the controller decorator", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "stub.ts",
      `
      import { Get } from "@nestjs/common";
      class NotAController {
        @Get()
        ping() { return "pong"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    expect(units).toHaveLength(0);
  });

  it("joins class-prefix and method-suffix into a leading-slash path", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "users.controller.ts",
      `
      import { Controller, Get, Post } from "@nestjs/common";
      @Controller("users")
      class UsersController {
        @Get(":id")
        one() { return null; }

        @Post()
        create() { return null; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    const byName = Object.fromEntries(units.map((u) => [u.name, u.routeInfo]));
    expect(byName).toEqual({
      "UsersController.one": { method: "GET", path: "/users/:id" },
      "UsersController.create": { method: "POST", path: "/users" },
    });
  });

  it("handles bare @Controller() and bare @Get() as path '/'", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "root.controller.ts",
      `
      import { Controller, Get } from "@nestjs/common";
      @Controller()
      class RootController {
        @Get()
        index() { return null; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/" });
  });

  it("reads a handler written as a property holding an arrow", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "users.controller.ts",
      `
      import { Controller, Get } from "@nestjs/common";
      @Controller("users")
      class UsersController {
        @Get(":id")
        one = () => null;

        @Get()
        list = function () { return []; };
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    const byName = Object.fromEntries(units.map((u) => [u.name, u.routeInfo]));
    expect(byName).toEqual({
      "UsersController.one": { method: "GET", path: "/users/:id" },
      "UsersController.list": { method: "GET", path: "/users" },
    });
  });

  it("ignores a decorated property that holds something other than a function", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "users.controller.ts",
      `
      import { Controller, Get } from "@nestjs/common";
      @Controller("users")
      class UsersController {
        @Get()
        options = { cache: true };
      }
    `,
    );
    expect(discoverUnits(file, [makeDecoratedRoutePattern()])).toHaveLength(0);
  });

  it("ignores methods without a recognised verb decorator", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "users.controller.ts",
      `
      import { Controller, Get } from "@nestjs/common";
      @Controller("users")
      class UsersController {
        @Get()
        list() { return []; }

        // No verb decorator: a plain helper on the controller
        // shouldn't surface as a route.
        format(_id: string): string { return "ok"; }
      }
    `,
    );
    const units = discoverUnits(file, [makeDecoratedRoutePattern()]);
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo?.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// graphqlHookCall discovery, documents held in named constants
// ---------------------------------------------------------------------------

describe("graphqlHookCall discovery through the fact layer", () => {
  it("reads a document a gql tag call built in the same module", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      declare function gql(source: string): unknown;
      const WIDGET_SETTINGS_QUERY_DOCUMENT = gql(/* GraphQL */ \`
        query WidgetSettings { widgetSettings { id } }
      \`);
      export function useWidgetSettings() {
        return useQuery(WIDGET_SETTINGS_QUERY_DOCUMENT);
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo?.operationName).toBe("WidgetSettings");
  });

  it("reads a document imported from another module through a barrel", () => {
    const project = createProject();
    project.createSourceFile(
      "documents.ts",
      `
      declare function gql(source: string): unknown;
      export const WIDGET_SETTINGS_QUERY_DOCUMENT = gql(\`
        query WidgetSettings($region: String!) { widgetSettings(region: $region) { id } }
      \`);
    `,
    );
    project.createSourceFile(
      "barrel.ts",
      `export { WIDGET_SETTINGS_QUERY_DOCUMENT } from "./documents.js";`,
    );
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      import { WIDGET_SETTINGS_QUERY_DOCUMENT } from "./barrel.js";
      export function useWidgetSettings(region: string) {
        return useQuery(WIDGET_SETTINGS_QUERY_DOCUMENT, { variables: { region } });
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo?.operationName).toBe("WidgetSettings");
    expect(units[0].operationInfo?.variables.map((v) => v.name)).toEqual([
      "region",
    ]);
  });

  it("reads a document the generated `graphql` function built", () => {
    const project = createProject();
    project.createSourceFile(
      "generated/gql.ts",
      "export declare function graphql(source: string): unknown;",
    );
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useMutation } from "@apollo/client";
      import { graphql } from "./generated/gql.js";
      const CREATE_WIDGET = graphql(\`mutation CreateWidget { createWidget { id } }\`);
      export function useCreateWidget() {
        return useMutation(CREATE_WIDGET);
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units[0]?.operationInfo?.operationName).toBe("CreateWidget");
  });

  it("does not take a locally declared `graphql` for a document tag", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useMutation } from "@apollo/client";
      function graphql(source: string): unknown { return { source }; }
      const CREATE_WIDGET = graphql(\`mutation CreateWidget { createWidget { id } }\`);
      export function useCreateWidget() {
        return useMutation(CREATE_WIDGET);
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units[0]?.operationInfo?.operationName).toBeUndefined();
    expect(units[0]?.operationInfo?.unresolved?.reference).toBe(
      "CREATE_WIDGET",
    );
  });

  it("recognizes a tag imported under another name", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql as apolloGql, useQuery } from "@apollo/client";
      const GET_PET = apolloGql\`query GetPet { pet { id } }\`;
      export function usePet() {
        return useQuery(GET_PET);
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units[0]?.operationInfo?.operationName).toBe("GetPet");
  });

  it("reports a document the code computes as a gap rather than an operation", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      declare function gql(source: string): unknown;
      declare const legacy: boolean;
      const A = gql(\`query A { a }\`);
      const B = gql(\`query B { b }\`);
      const CHOSEN = legacy ? A : B;
      export function useChosen() {
        return useQuery(CHOSEN);
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units).toHaveLength(1);
    expect(units[0].operationInfo?.operationName).toBeUndefined();
    expect(units[0].operationInfo?.operationType).toBe("query");
    expect(units[0].operationInfo?.unresolved?.reference).toBe("CHOSEN");
  });

  it("keeps two hook calls in one function apart", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { useQuery } from "@apollo/client";
      declare function gql(source: string): unknown;
      const SEARCH = gql(\`query SearchUsers { searchUsers { id } }\`);
      const USER = gql(\`query User { user { id } }\`);
      export function UserPicker() {
        return [useQuery(SEARCH), useQuery(USER)];
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeGraphqlHookPattern()], store);
    expect(units.map((u) => u.name).sort()).toEqual([
      "UserPicker.SearchUsers",
      "UserPicker.User",
    ]);
  });

  it("reads a document a named constant holds for an imperative call", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "loader.ts",
      `
      import { ApolloClient } from "@apollo/client";
      declare function gql(source: string): unknown;
      const LOAD_PET = gql(\`query LoadPet { pet { id } }\`);
      declare const client: ApolloClient<unknown>;
      export async function loadPet() {
        return await client.query({ query: LOAD_PET });
      }
    `,
    );
    const store = new ResolutionStore();
    const units = discoverUnits(file, [makeImperativePattern()], store);
    expect(units[0]?.operationInfo?.operationName).toBe("LoadPet");
  });
});

// ---------------------------------------------------------------------------
// Unit identity
// ---------------------------------------------------------------------------

describe("unit identity", () => {
  it("keeps two hook calls in one component apart", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "page.ts",
      `
      import { gql, useQuery } from "@apollo/client";
      export function WidgetPanel() {
        const a = useQuery(gql\`query WidgetItem { widget { id } }\`);
        const b = useQuery(gql\`query WidgetOwner { owner { id } }\`);
        return [a, b];
      }
    `,
    );
    const units = discoverUnits(file, [makeGraphqlHookPattern()]);
    expect(units.map((u) => u.name).sort()).toEqual([
      "WidgetPanel.WidgetItem",
      "WidgetPanel.WidgetOwner",
    ]);
  });
});

// ---------------------------------------------------------------------------
// registrationCall: how the handler reaches the registration
// ---------------------------------------------------------------------------

describe("a handler named at the registration rather than written there", () => {
  const HANDLER = "(req: any, res: any) => { res.json({ ok: true }); }";

  /** One entry file plus whatever other files the shape needs. */
  function discoverIn(
    entry: string,
    others: Record<string, string> = {},
  ): ReturnType<typeof discoverUnits> {
    const project = createProject();
    for (const [name, text] of Object.entries(others)) {
      project.createSourceFile(name, text);
    }
    const file = project.createSourceFile(
      "entry.ts",
      `import { Router } from "express";\nconst router = Router();\n${entry}`,
    );
    return discoverUnits(file, [makeExpressPattern()], new ResolutionStore());
  }

  const unitFile = `export const handler = ${HANDLER};\n`;

  const reaches: Array<[string, string, Record<string, string>]> = [
    ["written at the call", `router.get("/p", ${HANDLER});`, {}],
    ["a name", `const handler = ${HANDLER};\nrouter.get("/p", handler);`, {}],
    [
      "a property read",
      `const routes = { list: ${HANDLER} };\nrouter.get("/p", routes.list);`,
      {},
    ],
    [
      "an array index",
      `const routes = [${HANDLER}];\nrouter.get("/p", routes[0]);`,
      {},
    ],
    [
      "an alias of a name",
      `const handler = ${HANDLER};\nconst alias = handler;\nrouter.get("/p", alias);`,
      {},
    ],
    [
      "an import",
      `import { handler } from "./unit.js";\nrouter.get("/p", handler);`,
      { "unit.ts": unitFile },
    ],
    [
      "a barrel",
      `import { handler } from "./barrel.js";\nrouter.get("/p", handler);`,
      {
        "unit.ts": unitFile,
        "barrel.ts": `export { handler } from "./unit.js";\n`,
      },
    ],
    [
      "two barrels",
      `import { handler } from "./second.js";\nrouter.get("/p", handler);`,
      {
        "unit.ts": unitFile,
        "barrel.ts": `export { handler } from "./unit.js";\n`,
        "second.ts": `export { handler } from "./barrel.js";\n`,
      },
    ],
  ];

  for (const [how, entry, others] of reaches) {
    it(`finds a handler that reaches the call through ${how}`, () => {
      const units = discoverIn(entry, others);
      expect(units).toHaveLength(1);
      expect(units[0].name).toBe("get");
    });
  }

  it("keeps both routes when one function serves two of them", () => {
    // The same function now reaches two registrations. Each route is
    // its own boundary even though the body behind them is shared, and
    // the route the pack lifts out of the call is what tells them
    // apart.
    const project = createProject();
    const file = project.createSourceFile(
      "entry.ts",
      [
        'import { Router } from "express";',
        "const router = Router();",
        `const handler = ${HANDLER};`,
        'router.get("/a", handler);',
        'router.get("/b", handler);',
      ].join("\n"),
    );
    const routed: DiscoveryPattern = {
      ...makeExpressPattern(),
      bindingExtraction: {
        method: { type: "fromRegistration", position: "methodName" },
        path: { type: "fromRegistration", position: 0 },
      },
    };
    const units = discoverUnits(file, [routed], new ResolutionStore());
    expect(units.map((u) => u.routeInfo?.path).sort()).toEqual(["/a", "/b"]);
  });

  it("finds nothing when two candidates both look valid", () => {
    // Reporting a route's behaviour from the wrong one of two functions
    // is worse than reporting nothing.
    const units = discoverIn(
      [
        `const first = ${HANDLER};`,
        "const second = (req: any, res: any) => { res.status(500).send(); };",
        "const routes: any = { pick: first };",
        "const other: any = { pick: second };",
        "const chosen: any = Math.random() ? routes : other;",
        'router.get("/p", chosen.pick);',
      ].join("\n"),
    );
    expect(units).toHaveLength(0);
  });

  it("finds nothing when the handler arrives as a parameter", () => {
    // Whoever calls `register` supplies the function, and this file
    // cannot see where it came from.
    const units = discoverIn(
      [
        "const register = (handle: any) => {",
        '  router.get("/p", handle);',
        "};",
        `register(${HANDLER});`,
      ].join("\n"),
    );
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// namedExport, where a binding is written again after it is declared
// ---------------------------------------------------------------------------

describe("namedExport of a binding written more than once", () => {
  it("finds the write that survives, not the initializer", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      async function laterAction(args: any) { return { later: args }; }
      export let action = async (args: any) => ({ first: args });
      action = laterAction;
    `,
    );

    const store = new ResolutionStore();
    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["action"])],
      store,
    );
    expect(units).toHaveLength(1);
    expect(units[0].func?.getText()).toContain("later");
  });

  it("finds nothing when a branch decides which write runs", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      declare const flag: boolean;
      async function laterAction(args: any) { return { later: args }; }
      export let action = async (args: any) => ({ first: args });
      if (flag) { action = laterAction; }
    `,
    );

    const store = new ResolutionStore();
    const units = discoverUnits(
      file,
      [makeNamedExportPattern(["action"])],
      store,
    );
    expect(units).toHaveLength(0);
  });
});
