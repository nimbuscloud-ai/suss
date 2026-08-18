import path from "node:path";

import { type CallExpression, Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { readHttpMetadata, storageBinding } from "@suss/behavioral-ir";
import { assembleSummary } from "@suss/extractor";
import { createTestProject, testCompilerOptions } from "@suss/test-project";

import { createTypeScriptAdapter, extractCodeStructure } from "./adapter.js";
import { readContract } from "./contract.js";
import { discoverUnits } from "./discovery/index.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";
import type { DiscoveredUnit } from "./discovery/index.js";

function restMethodOf(
  target:
    | BehavioralSummary
    | { boundaryBinding: BoundaryBinding | null }
    | null
    | undefined,
): string | null {
  const binding =
    target && "identity" in target
      ? target.identity.boundaryBinding
      : (target?.boundaryBinding ?? null);
  const sem = binding?.semantics;
  return sem?.name === "rest" ? sem.method : null;
}

function restPathOf(
  target:
    | BehavioralSummary
    | { boundaryBinding: BoundaryBinding | null }
    | null
    | undefined,
): string | null {
  const binding =
    target && "identity" in target
      ? target.identity.boundaryBinding
      : (target?.boundaryBinding ?? null);
  const sem = binding?.semantics;
  return sem?.name === "rest" ? sem.path : null;
}

const zodOpenapiPack: PatternPack = {
  name: "hono",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "@hono/zod-openapi",
        importName: "OpenAPIHono",
        registrationChain: [".openapi"],
      },
      bindingExtraction: {
        method: {
          type: "fromArgumentProperty",
          position: 0,
          property: "method",
        },
        path: { type: "fromArgumentProperty", position: 0, property: "path" },
      },
    },
  ],
  terminals: [],
  contractReading: {
    discovery: {
      importModule: "@hono/zod-openapi",
      importName: "OpenAPIHono",
      registrationChain: [".openapi"],
    },
    responseExtraction: { property: "responses" },
    methodProperty: "method",
    pathProperty: "path",
    endpoint: { from: "registrationArgument", position: 0 },
  },
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "context" }],
  },
};

const tsRestPack: PatternPack = {
  name: "ts-rest",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "registrationCall",
        importModule: "@ts-rest/express",
        importName: "initServer",
        registrationChain: [".router"],
      },
      bindingExtraction: {
        method: { type: "fromContract" },
        path: { type: "fromContract" },
      },
    },
  ],
  terminals: [
    {
      kind: "response",
      match: {
        type: "returnShape",
        requiredProperties: ["status", "body"],
      },
      extraction: {
        statusCode: { from: "property", name: "status" },
        body: { from: "property", name: "body" },
      },
    },
  ],
  contractReading: {
    discovery: {
      importModule: "@ts-rest/core",
      importName: "initContract",
      registrationChain: [".router"],
    },
    responseExtraction: { property: "responses" },
    methodProperty: "method",
    pathProperty: "path",
    paramsExtraction: { property: "pathParams" },
  },
  inputMapping: {
    type: "destructuredObject",
    knownProperties: {
      params: "pathParams",
      body: "requestBody",
      query: "queryParams",
      headers: "headers",
    },
  },
};

function fixturesDir() {
  return path.resolve(__dirname, "../../../../fixtures/ts-rest");
}

function createFixtureProject(): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { ...testCompilerOptions },
  });

  project.addSourceFilesAtPaths(path.join(fixturesDir(), "*.ts"));
  return project;
}

const raise = (msg: string): never => {
  throw new Error(msg);
};

describe("extractCodeStructure", () => {
  it("extracts parameters from a destructured ts-rest handler", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params, body }) => {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);

    expect(units).toHaveLength(1);

    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.parameters).toEqual([
      { name: "params", position: 0, role: "pathParams", typeText: null },
      { name: "body", position: 0, role: "requestBody", typeText: null },
    ]);
    expect(raw.identity.name).toBe("getUser");
    expect(raw.identity.kind).toBe("handler");
  });

  it("gives each name an ArrayBindingPattern binds its own input under allPositional, skipping holes", async () => {
    const project = createTestProject();
    const source = `
      export const handler = ([state, setState, , rest]: [string, (s: string) => void, number, unknown]) => {
        return state;
      };
    `;
    const file = project.createSourceFile("test.ts", source);
    const allPositionalPack: PatternPack = {
      ...tsRestPack,
      name: "all-positional",
      discovery: [
        { kind: "handler", match: { type: "namedExport", names: ["handler"] } },
      ],
      inputMapping: { type: "allPositional" },
    };
    const units = discoverUnits(file, allPositionalPack.discovery);
    expect(units).toHaveLength(1);

    const raw = extractCodeStructure(units[0], allPositionalPack);
    expect(raw.parameters).toEqual([
      { name: "state", position: 0, role: "state", typeText: null },
      { name: "setState", position: 0, role: "setState", typeText: null },
      { name: "rest", position: 0, role: "rest", typeText: null },
    ]);
  });

  it("extracts dependency calls from function body", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): Promise<any> };
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const user = await db.findById(params.id);
          if (!user) return { status: 404, body: { error: "not found" } };
          return { status: 200, body: user };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.dependencyCalls).toHaveLength(1);
    expect(raw.dependencyCalls[0].name).toBe("db.findById");
    expect(raw.dependencyCalls[0].assignedTo).toBe("user");
    expect(raw.dependencyCalls[0].async).toBe(true);
  });

  it("extracts branches with conditions and terminals", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): Promise<any> };
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const user = await db.findById(params.id);
          if (!user) return { status: 404, body: { error: "not found" } };
          return { status: 200, body: user };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.branches).toHaveLength(2);

    expect(raw.branches[0].terminal.kind).toBe("response");
    expect(raw.branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(raw.branches[0].isDefault).toBe(false);
    expect(raw.branches[0].conditions.length).toBeGreaterThan(0);

    expect(raw.branches[1].terminal.kind).toBe("response");
    expect(raw.branches[1].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(raw.branches[1].isDefault).toBe(true);
  });

  it("extracts positional parameters (Express style)", async () => {
    const expressPack: PatternPack = {
      ...tsRestPack,
      name: "express",
      inputMapping: {
        type: "positionalParams",
        params: [
          { position: 0, role: "request" },
          { position: 1, role: "response" },
          { position: 2, role: "next" },
        ],
      },
      discovery: [
        {
          kind: "handler",
          match: { type: "namedExport", names: ["getUser"] },
        },
      ],
    };
    const project = createTestProject();
    const source = `
      export function getUser(req: any, res: any, next: any) {
        return { status: 200, body: {} };
      }
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, expressPack.discovery);
    const raw = extractCodeStructure(units[0], expressPack);

    expect(raw.parameters).toEqual([
      { name: "req", position: 0, role: "request", typeText: null },
      { name: "res", position: 1, role: "response", typeText: null },
      { name: "next", position: 2, role: "next", typeText: null },
    ]);
  });

  it("extracts non-destructured object parameter", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async (ctx) => {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.parameters).toEqual([
      { name: "ctx", position: 0, role: "request", typeText: null },
    ]);
  });

  it("handles expression-body arrow with no dependency calls", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        health: async () => ({ status: 200, body: { ok: true } }),
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.dependencyCalls).toHaveLength(0);
    expect(raw.branches).toHaveLength(1);
    expect(raw.branches[0].isDefault).toBe(true);
  });

  it("extracts multiple dependency calls including sync", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): Promise<any> };
      declare function validate(x: any): boolean;
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const isValid = validate(params.id);
          const user = await db.findById(params.id);
          if (!user) return { status: 404, body: { error: "not found" } };
          return { status: 200, body: user };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.dependencyCalls).toHaveLength(2);
    expect(raw.dependencyCalls[0].name).toBe("validate");
    expect(raw.dependencyCalls[0].async).toBe(false);
    expect(raw.dependencyCalls[1].name).toBe("db.findById");
    expect(raw.dependencyCalls[1].async).toBe(true);
  });

  it("handles handler with no parameters", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        health: async () => {
          return { status: 200, body: { ok: true } };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.parameters).toEqual([]);
  });

  it("extracts dependency calls nested inside if/try blocks", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): Promise<any>; log(msg: string): void };
      declare function validate(x: any): boolean;
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const isValid = validate(params.id);
          if (isValid) {
            const user = await db.findById(params.id);
            if (user) {
              return { status: 200, body: user };
            }
          }
          try {
            const fallback = db.log("miss");
          } catch (e) {}
          return { status: 404, body: { error: "not found" } };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.dependencyCalls).toHaveLength(3);
    expect(raw.dependencyCalls.map((d) => d.name)).toEqual([
      "validate",
      "db.findById",
      "db.log",
    ]);
    expect(raw.dependencyCalls[1].async).toBe(true);
    expect(raw.dependencyCalls[2].async).toBe(false);
  });

  it("extracts ternary return branches as separate branches with conditions", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): Promise<any> };
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const user = await db.findById(params.id);
          return user
            ? { status: 200, body: user }
            : { status: 404, body: { error: "not found" } };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.branches).toHaveLength(2);

    expect(raw.branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(raw.branches[0].conditions.length).toBeGreaterThan(0);
    expect(raw.branches[0].conditions[0].polarity).toBe("positive");

    expect(raw.branches[1].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(raw.branches[1].conditions.length).toBeGreaterThan(0);
    expect(raw.branches[1].conditions[0].polarity).toBe("negative");
  });

  it("extracts destructured dependency call assignedTo as null", async () => {
    const project = createTestProject();
    const source = `
      import { initServer } from "@ts-rest/express";
      declare const db: { find(id: string): Promise<{ name: string; email: string }> };
      const s = initServer();
      export const router = s.router({} as any, {
        getUser: async ({ params }) => {
          const { name, email } = await db.find(params.id);
          return { status: 200, body: { name, email } };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack);

    expect(raw.dependencyCalls).toHaveLength(1);
    expect(raw.dependencyCalls[0].name).toBe("db.find");
    expect(raw.dependencyCalls[0].assignedTo).toBeNull();
    expect(raw.dependencyCalls[0].async).toBe(true);
  });
});

describe("readContract", () => {
  it("reads contract responses from same-file contract definition", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: {
            200: null as any,
            404: null as any,
          },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        getUser: async ({ params }) => {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);

    expect(units).toHaveLength(1);

    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toEqual([
      { statusCode: 200 },
      { statusCode: 404 },
    ]);
    expect(result?.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "ts-rest",
    });
  });

  it("returns null when handler is not in a router call", async () => {
    const project = createTestProject();
    const source = `
      export async function standalone() {
        return { status: 200, body: {} };
      }
    `;
    const file = project.createSourceFile("test.ts", source);

    const fn = file.getFunctions()[0];
    const result = readContract(
      { func: fn, kind: "handler", name: "standalone" },
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).toBeNull();
  });

  it("returns null when handler name does not match any contract endpoint", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: { 200: null as any },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        deleteUser: async () => {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);

    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("deleteUser");

    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );
    expect(result).toBeNull();
  });

  it("reads the responses off a registration-argument route object", () => {
    const project = createTestProject();
    const source = `
      import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
      const routes = {
        provision: createRoute({
          method: "post",
          path: "/v1/tenants/{tenantId}/provision",
          responses: { 200: { description: "ok" }, 409: { description: "conflict" } },
        }),
      } as const;
      export function register(app: OpenAPIHono): void {
        app.openapi(routes.provision as any, async (c) => c.json({}, 200));
      }
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, zodOpenapiPack.discovery);
    expect(units).toHaveLength(1);

    const result = readContract(
      units[0],
      zodOpenapiPack.contractReading ??
        raise("zod-openapi pack missing contractReading"),
      zodOpenapiPack.name,
    );
    expect(result?.declaredContract.responses).toEqual([
      { statusCode: 200 },
      { statusCode: 409 },
    ]);
    expect(result?.declaredContract.provenance).toBe("independent");
  });

  it("returns null when a registration-argument handler stands alone", () => {
    const project = createTestProject();
    const source = `
      export async function standalone() {
        return null;
      }
    `;
    const file = project.createSourceFile("test.ts", source);
    const fn = file.getFunctions()[0];

    const result = readContract(
      { func: fn, kind: "handler", name: "standalone" },
      zodOpenapiPack.contractReading ??
        raise("zod-openapi pack missing contractReading"),
      zodOpenapiPack.name,
    );
    expect(result).toBeNull();
  });

  it("reads contract for method-shorthand handlers", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: { 200: null as any, 404: null as any },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        async getUser({ params }) {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);

    expect(units).toHaveLength(1);

    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toHaveLength(2);
    expect(restMethodOf(result ?? null)).toBe("GET");
  });

  it("extracts body TypeShape from c.type<T>() declarations", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: {
            200: c.type<{ id: string; name: string }>(),
            404: c.type<{ error: string }>(),
          },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        getUser: async () => ({ status: 200, body: { id: "x", name: "y" } }),
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected contract result");
    }
    const [ok, notFound] = result.declaredContract.responses;
    expect(ok).toEqual({
      statusCode: 200,
      body: {
        type: "record",
        properties: { id: { type: "text" }, name: { type: "text" } },
      },
    });
    expect(notFound).toEqual({
      statusCode: 404,
      body: {
        type: "record",
        properties: { error: { type: "text" } },
      },
    });
  });

  it("omits body when response schema is not a c.type<T>() call", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: {
            200: null as any,
          },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        getUser: async () => ({ status: 200, body: {} }),
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toEqual([{ statusCode: 200 }]);
  });

  it("returns null boundaryBinding when contract has no method or path", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        process: {
          responses: { 200: null as any },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        process: async () => {
          return { status: 200, body: {} };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
      tsRestPack.name,
    );

    expect(result).not.toBeNull();
    expect(result?.boundaryBinding).toBeNull();
  });
});

describe("module imports on summaries", () => {
  it("records which project files a summary's own file imports", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/helper.ts",
      "export const helper = (): number => 1;",
    );
    project.createSourceFile(
      "/api.ts",
      `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";
      import { helper } from "./helper";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: { 200: null as any },
        },
      });
      const s = initServer();
      export const router = s.router(contract, {
        getUser: async () => {
          return { status: 200, body: { n: helper() } };
        },
      });
      `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser?.metadata?.moduleImports).toEqual(["/helper.ts"]);
  });
});

describe("library env-read markers", () => {
  const { contractReading: _dropped, ...zodOpenapiBase } = zodOpenapiPack;
  const packWithLibraryVars: PatternPack = {
    ...zodOpenapiBase,
    name: "aws-lambda",
    discovery: [],
    libraryEnvVars: [
      { module: "@aws-lambda-powertools/", prefixes: ["POWERTOOLS_"] },
    ],
  };

  it("emits one marker when a project file imports the declared library", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/handler.ts",
      `
      import { Logger } from "@aws-lambda-powertools/logger";
      export const logger = new Logger();
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [packWithLibraryVars],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();
    const marker = summaries.find(
      (s) => s.metadata?.libraryEnvReads !== undefined,
    );
    expect(marker?.metadata?.libraryEnvReads).toEqual({
      module: "@aws-lambda-powertools/",
      prefixes: ["POWERTOOLS_"],
    });
    expect(marker?.location.file).toBe("/handler.ts");
  });

  it("emits nothing when no file imports the library", async () => {
    const project = createTestProject();
    project.createSourceFile("/plain.ts", "export const x = 1;");
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [packWithLibraryVars],
      cacheDir: null,
    });
    const summaries = await adapter.extractAll();
    expect(
      summaries.find((s) => s.metadata?.libraryEnvReads !== undefined),
    ).toBeUndefined();
  });
});

describe("createTypeScriptAdapter: ts-rest fixtures", () => {
  it("extracts summaries from fixture handler file", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const handlerPath = project
      .getSourceFiles()
      .find((f) => f.getFilePath().endsWith("handlers.ts"))
      ?.getFilePath();

    const resolvedHandlerPath =
      handlerPath ?? raise("handlers.ts source file not loaded");

    const summaries = await adapter.extractFromFiles([resolvedHandlerPath]);

    expect(summaries).toHaveLength(2);

    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["createUser", "getUser"]);
  });

  it("getUser handler has correct transitions", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();
    expect(getUser?.kind).toBe("handler");

    expect(getUser?.transitions).toHaveLength(4);

    const statusCodes = getUser?.transitions.map((t) => {
      if (
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal"
      ) {
        return t.output.statusCode.value;
      }
      return null;
    });
    expect(statusCodes).toEqual([404, 404, 404, 200]);

    expect(getUser?.transitions[3].isDefault).toBe(true);

    expect(getUser?.transitions[0].isDefault).toBe(false);
    expect(getUser?.transitions[1].isDefault).toBe(false);
    expect(getUser?.transitions[2].isDefault).toBe(false);
  });

  it("getUser handler has correct inputs", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();

    const paramsInput = getUser?.inputs.find(
      (i) => i.type === "parameter" && i.name === "params",
    );
    expect(paramsInput).toBeDefined();
    expect(paramsInput?.type).toBe("parameter");
    if (paramsInput?.type === "parameter") {
      expect(paramsInput?.role).toBe("pathParams");
    }
  });

  it("getUser handler detects contract gap for undeclared 500", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();

    const gap500 = getUser?.gaps.find((g) => g.description.includes("500"));
    expect(gap500).toBeDefined();
    expect(gap500?.type).toBe("unhandledCase");
    expect(gap500?.description).toContain("never produced");
  });

  it("getUser handler has dependency call for db.findById", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();

    expect(getUser?.metadata).toBeDefined();
    if (getUser === undefined) {
      return;
    }
    expect(readHttpMetadata(getUser)?.declaredContract).toBeDefined();
  });

  it("getUser handler has high confidence when all conditions are structured", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();
    expect(getUser?.confidence.level).toBe("high");
  });

  it("createUser handler has correct transitions", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const createUser = summaries.find((s) => s.identity.name === "createUser");

    expect(createUser).toBeDefined();
    expect(createUser?.kind).toBe("handler");

    expect(createUser?.transitions).toHaveLength(2);

    const statusCodes = createUser?.transitions.map((t) => {
      if (
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal"
      ) {
        return t.output.statusCode.value;
      }
      return null;
    });
    expect(statusCodes).toEqual([400, 201]);
  });

  it("getUser handler has boundary binding from contract", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();
    expect(getUser?.identity.boundaryBinding).toBeDefined();
    expect(restMethodOf(getUser)).toBe("GET");
    expect(restPathOf(getUser)).toBe("/users/:id");
  });

  it("extractAll skips declaration files", async () => {
    const project = createFixtureProject();

    project.createSourceFile(
      "types.d.ts",
      "export interface Foo { bar: string }",
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();

    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["createUser", "getUser"]);
  });

  it("getUser conditions are structured predicates, not opaque", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();

    if (getUser === undefined) {
      throw new Error("expected getUser summary");
    }
    for (const t of getUser.transitions) {
      for (const c of t.conditions) {
        expect(c.type).not.toBe("opaque");
      }
    }

    const t0 = getUser.transitions[0];
    expect(t0.conditions).toHaveLength(1);
    expect(t0.conditions[0].type).toBe("truthinessCheck");
    if (t0.conditions[0].type === "truthinessCheck") {
      expect(t0.conditions[0].negated).toBe(true);
      expect(t0.conditions[0].subject.type).toBe("derived");
    }

    const t1 = getUser?.transitions[1];
    expect(t1.conditions.length).toBeGreaterThanOrEqual(2);
    expect(t1.conditions[0].type).toBe("negation");
    const t1Last = t1.conditions[t1.conditions.length - 1];
    expect(t1Last.type).toBe("truthinessCheck");
    if (t1Last.type === "truthinessCheck") {
      expect(t1Last.negated).toBe(true);
      expect(t1Last.subject.type).toBe("dependency");
    }

    const t2 = getUser?.transitions[2];
    expect(t2.conditions.length).toBeGreaterThanOrEqual(3);
    const t2Last = t2.conditions[t2.conditions.length - 1];
    expect(t2Last.type).toBe("truthinessCheck");
    if (t2Last.type === "truthinessCheck") {
      expect(t2Last.negated).toBe(false);
      expect(t2Last.subject.type).toBe("derived");
      if (t2Last.subject.type === "derived") {
        expect(t2Last.subject.derivation.type).toBe("propertyAccess");
        if (t2Last.subject.derivation.type === "propertyAccess") {
          expect(t2Last.subject.derivation.property).toBe("deletedAt");
        }
      }
    }
  });

  it("createUser guard condition has compound or predicate", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const createUser = summaries.find((s) => s.identity.name === "createUser");
    expect(createUser).toBeDefined();
    if (createUser === undefined) {
      throw new Error("expected createUser summary");
    }

    const t0 = createUser.transitions[0];
    expect(t0.conditions.length).toBeGreaterThan(0);
  });

  it("produces reverse gap when handler returns undeclared status", async () => {
    const project = createTestProject();
    const source = `
      import { initContract } from "@ts-rest/core";
      import { initServer } from "@ts-rest/express";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: {
            200: null as any,
          },
        },
      });

      const s = initServer();
      export const router = s.router(contract, {
        getUser: async ({ params }) => {
          if (!params.id) return { status: 400 as const, body: { error: "bad" } };
          return { status: 200 as const, body: { id: params.id } };
        },
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });
    const summaries = await adapter.extractFromFiles([file.getFilePath()]);

    expect(summaries).toHaveLength(1);

    const reverseGap = summaries[0].gaps.find((g) =>
      g.description.includes("400"),
    );
    expect(reverseGap).toBeDefined();
    expect(reverseGap?.description).toContain("not declared");
  });

  it("gapHandling: silent suppresses all gaps", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
      extractorOptions: { gapHandling: "silent" },
    });

    const summaries = await adapter.extractAll();
    const getUser = summaries.find((s) => s.identity.name === "getUser");

    expect(getUser).toBeDefined();
    expect(getUser?.gaps).toEqual([]);
  });

  it("file with no matching handlers produces empty result", async () => {
    const project = createTestProject();
    const source = `
      export function helper(x: number) { return x + 1; }
    `;
    project.createSourceFile("utils.ts", source);

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    expect(summaries).toEqual([]);
  });

  it("extractFromFiles silently skips nonexistent paths", async () => {
    const project = createFixtureProject();
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractFromFiles(["/does/not/exist.ts"]);
    expect(summaries).toEqual([]);
  });
});

describe("createTypeScriptAdapter: cross-pack dedup", () => {
  it("produces one summary per (function, kind) even when multiple packs discover the same unit", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "Button.tsx",
      `
      export default function Button({ label }: { label: string }) {
        return <button>{label}</button>;
      }
    `,
    );

    const packA: PatternPack = {
      name: "pack-a",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [
        {
          kind: "component",
          match: { type: "namedExport", names: ["default"] },
        },
      ],
      terminals: [
        { kind: "render", match: { type: "jsxReturn" }, extraction: {} },
      ],
      inputMapping: { type: "componentProps", paramPosition: 0 },
    };
    const packB: PatternPack = { ...packA, name: "pack-b" };

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [packA, packB],
    });

    const summaries = (await adapter.extractAll()).filter(
      (s) => s.identity.name === "Button",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.boundaryBinding?.recognition).toBe("pack-a");
  });

  it("respects framework order: first-listed wins", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "Thing.tsx",
      "export default function Thing() { return <div />; }",
    );
    const makePack = (name: string): PatternPack => ({
      name,
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [
        {
          kind: "component",
          match: { type: "namedExport", names: ["default"] },
        },
      ],
      terminals: [
        { kind: "render", match: { type: "jsxReturn" }, extraction: {} },
      ],
      inputMapping: { type: "componentProps", paramPosition: 0 },
    });

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [makePack("react-router"), makePack("react")],
    });

    const summaries = (await adapter.extractAll()).filter(
      (s) => s.identity.name === "Thing",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.boundaryBinding?.recognition).toBe(
      "react-router",
    );
  });
});

/**
 * A stand-in for a storage pack: it fires on `query({ TableName, IndexName })`
 * and reads the table and the index straight off the literal.
 */
const storagePack: PatternPack = {
  name: "storage",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [],
  terminals: [],
  inputMapping: { type: "allPositional" },
  accessRecognizers: [
    (access) => {
      const node = access as Node;
      if (
        !Node.isCallExpression(node) ||
        node.getExpression().getText() !== "query"
      ) {
        return null;
      }
      const input = node.getArguments()[0];
      if (input === undefined || !Node.isObjectLiteralExpression(input)) {
        return null;
      }
      const literal = (name: string): string | null => {
        const property = input.getProperty(name);
        const value = Node.isPropertyAssignment(property)
          ? property.getInitializer()
          : undefined;
        return value !== undefined && Node.isStringLiteral(value)
          ? value.getLiteralValue()
          : null;
      };
      return [
        {
          type: "interaction",
          binding: storageBinding({
            recognition: "storage",
            storageSystem: "aws.dynamodb",
            scope: "default",
            container: literal("TableName"),
            accessPath: literal("IndexName"),
          }),
          callee: "query",
          interaction: {
            class: "storage-access",
            kind: "read",
            fields: ["*"],
            operation: "Query",
          },
        },
      ];
    },
  ],
};

describe("createTypeScriptAdapter: reachable closure", () => {
  it("discovers internal helpers transitively called from a handler", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function fetchFromDb(id: string): { id: string } | null {
        if (id === "") return null;
        return { id };
      }
      export function formatResponse(row: { id: string }) {
        return { id: row.id, label: "ok" };
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { fetchFromDb, formatResponse } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        getThing: async ({ params }: { params: { id: string } }) => {
          const row = fetchFromDb(params.id);
          if (!row) return { status: 404 as const, body: { error: "missing" } };
          return { status: 200 as const, body: formatResponse(row) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const byName = Object.fromEntries(
      summaries.map((s) => [s.identity.name, s]),
    );

    expect(byName.getThing).toBeDefined();
    expect(byName.fetchFromDb).toBeDefined();
    expect(byName.formatResponse).toBeDefined();

    expect(byName.fetchFromDb.kind).toBe("library");
    expect(byName.fetchFromDb.identity.boundaryBinding).toEqual({
      transport: "in-process",
      semantics: { name: "function-call" },
      recognition: "reachable",
    });
  });

  it("runs pack recognizers over a reached helper's body", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function enqueue(id: string) {
        sendIt(id);
        return { id };
      }
      export function sendIt(id: string) {
        return id;
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { enqueue } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        go: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: enqueue(params.id) };
        },
      });
    `,
    );

    const recognizerPack: PatternPack = {
      name: "sender",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [],
      terminals: [],
      inputMapping: { type: "positionalParams", params: [] },
      invocationRecognizers: [
        (call) => {
          const node = call as CallExpression;
          if (node.getExpression().getText() !== "sendIt") {
            return null;
          }
          return [
            {
              type: "interaction",
              binding: {
                transport: "sqs",
                semantics: {
                  name: "message-bus",
                  messageBus: "aws_sqs",
                  channel: "thing.done",
                },
                recognition: "sender",
              },
              callee: "sendIt",
              interaction: { class: "message-send" },
            },
          ];
        },
      ],
    };

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack, recognizerPack],
    });

    const summaries = await adapter.extractAll();
    const helper = summaries.find((s) => s.identity.name === "enqueue");
    expect(helper).toBeDefined();
    const sends = (helper?.transitions ?? []).flatMap((t) =>
      t.effects.filter(
        (e) =>
          e.type === "interaction" && e.interaction.class === "message-send",
      ),
    );
    expect(sends).toHaveLength(1);
  });

  it("lets a recognizer in a reached body ask what a value was written as", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "dao.ts",
      `
      export class Dao {
        private readonly tableName: string;
        constructor() {
          const stage = "prod";
          this.tableName = \`\${stage}-orders-v1\`;
        }
        read() {
          return query(this.tableName);
        }
      }
      export function query(table: string) {
        return table;
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { Dao } from "./dao";
      const s = initServer();
      const dao = new Dao();
      export const router = s.router({} as any, {
        go: async () => {
          return { status: 200 as const, body: dao.read() };
        },
      });
    `,
    );

    // A storage pack in miniature: the value it wants is behind a
    // field, so it has to ask what that field was written as.
    let resolvedText: string | null = null;
    const readerPack: PatternPack = {
      name: "reader",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [],
      terminals: [],
      inputMapping: { type: "positionalParams", params: [] },
      invocationRecognizers: [
        (call, ctx) => {
          const node = call as CallExpression;
          if (node.getExpression().getText() !== "query") {
            return null;
          }
          const argument = node.getArguments()[0];
          const resolve = (
            ctx as { resolveWrittenValue?: (v: Node) => Node | null }
          ).resolveWrittenValue;
          const written =
            argument === undefined || resolve === undefined
              ? null
              : resolve(argument);
          resolvedText = written === null ? null : written.getText();
          return null;
        },
      ],
    };

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack, readerPack],
    });
    await adapter.extractAll();

    expect(resolvedText).toBe("`${stage}-orders-v1`");
  });

  it("transitively reaches helpers called by other helpers", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function outer(ctx: { id: string }) {
        return inner(ctx.id);
      }
      export function inner(id: string) {
        return { id, inner: true };
      }
      export function unused(x: string) {
        return x;
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { outer } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        go: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: outer(params) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const names = (await adapter.extractAll()).map((s) => s.identity.name);
    expect(names).toContain("outer");
    expect(names).toContain("inner");
    expect(names).not.toContain("unused");
  });

  it("stops at declaration-file boundaries (skips external deps)", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      declare const db: { findById(id: string): { id: string } | null };
      const s = initServer();
      export const router = s.router({} as any, {
        get: async ({ params }: { params: { id: string } }) => {
          const row = db.findById(params.id);
          return { status: 200 as const, body: row };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("get");
  });

  it("opt-out via includeReachable: false yields only pack-discovered units", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      "export function helper(x: string) { return x; }",
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { helper } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        go: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: { v: helper(params.id) } };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
      includeReachable: false,
    });

    const summaries = await adapter.extractAll();
    expect(summaries.map((s) => s.identity.name)).toEqual(["go"]);
  });

  it("deduplicates when the same helper is reached from multiple seeds", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      "export function shared(x: string) { return x.toUpperCase(); }",
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { shared } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        a: async () => ({ status: 200 as const, body: shared("a") }),
        b: async () => ({ status: 200 as const, body: shared("b") }),
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const names = (await adapter.extractAll())
      .map((s) => s.identity.name)
      .sort();
    expect(names.filter((n) => n === "shared")).toHaveLength(1);
    expect(names).toEqual(["a", "b", "shared"]);
  });

  it("walks into the class a handler constructed its service with", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "dao.ts",
      `
      export interface OrdersReader {
        findByCustomer(id: string): Promise<string>;
      }
      export class OrdersDao implements OrdersReader {
        async findByCustomer(id: string): Promise<string> {
          return query({ TableName: "orders-v1", IndexName: "byCustomer" });
        }
      }
      export function query(input: { TableName: string; IndexName: string }) {
        return JSON.stringify(input);
      }
    `,
    );
    project.createSourceFile(
      "service.ts",
      `
      import type { OrdersReader } from "./dao";
      export class OrdersService {
        constructor(private readonly dao: OrdersReader) {}
        async forCustomer(id: string) {
          return this.dao.findByCustomer(id);
        }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { OrdersDao } from "./dao";
      import { OrdersService } from "./service";
      const s = initServer();
      export const router = s.router({} as any, {
        list: async ({ params }: { params: { id: string } }) => {
          const service = new OrdersService(new OrdersDao());
          return { status: 200 as const, body: await service.forCustomer(params.id) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack, storagePack],
    });

    const summaries = await adapter.extractAll();
    const dao = summaries.find(
      (summary) => summary.identity.name === "findByCustomer",
    );
    expect(dao).toBeDefined();
    const accesses = (dao?.transitions ?? []).flatMap((transition) =>
      transition.effects.flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access"
          ? [effect.binding.semantics]
          : [],
      ),
    );
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({
      container: "orders-v1",
      accessPath: "byCustomer",
    });
  });

  it("leaves a gap where a method on an injected interface has nothing wiring it up", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "dao.ts",
      `
      export interface EditionDao {
        getEditions(publicationId: string): Promise<string[]>;
      }
    `,
    );
    project.createSourceFile(
      "service.ts",
      `
      import type { EditionDao } from "./dao";
      export class EditionService {
        constructor(private readonly dao: EditionDao) {}
        listForPublication(id: string) {
          return this.dao.getEditions(id);
        }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { EditionService } from "./service";
      const s = initServer();
      declare const service: EditionService;
      export const router = s.router({} as any, {
        listEditions: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: await service.listForPublication(params.id) };
        },
      });
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const service = summaries.find(
      (summary) => summary.identity.name === "listForPublication",
    );
    expect(service).toBeDefined();
    expect(
      (service?.transitions ?? []).flatMap((transition) => transition.effects),
    ).toEqual([]);

    const unfollowed = (service?.gaps ?? []).filter(
      (gap) => gap.type === "unfollowedCall",
    );
    expect(unfollowed).toHaveLength(1);
    expect(unfollowed[0]?.description).toContain("this.dao.getEditions");
    expect(unfollowed[0]?.description).toContain("no body");
  });
});

describe("createTypeScriptAdapter: boundary effects closure", () => {
  it("surfaces an effect two calls deep on the entry summary, marked transitive", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      declare const audit: { log: (m: string) => void };

      export function persist(id: string) {
        audit.log("saved");
        return { id };
      }

      export function orchestrate(id: string) {
        return persist(id);
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { orchestrate } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: orchestrate(params.id) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const handler = summaries.find((s) => s.kind === "handler");
    const closure = handler?.metadata?.effectsClosure as
      | Array<{ kind: string; target: string; transitive: boolean }>
      | undefined;
    expect(closure).toBeDefined();
    const audit = closure?.find((e) => e.target === "audit.log");
    expect(audit?.kind).toBe("invocation");
    expect(audit?.transitive).toBe(true);
  });
});

describe("createTypeScriptAdapter: rethrow enrichment", () => {
  it("populates rethrow.possibleSources from direct callees' throws", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function loadUser(id: string) {
        if (!id) throw new Error("missing id");
        if (id.length < 3) throw new Error("id too short");
        return { id };
      }

      export function wrapper(id: string) {
        try {
          return loadUser(id);
        } catch (err) {
          throw err;
        }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { wrapper } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: wrapper(params.id) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const wrapperSummary = summaries.find((s) => s.identity.name === "wrapper");
    expect(wrapperSummary).toBeDefined();

    const rethrowTransition = wrapperSummary?.transitions.find(
      (t) => t.output.type === "throw",
    );
    expect(rethrowTransition).toBeDefined();

    const rethrowMeta = rethrowTransition?.metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;
    expect(rethrowMeta).toBeDefined();

    const messages = rethrowMeta?.possibleSources.map((s) => s.message).sort();
    expect(messages).toEqual(["id too short", "missing id"]);

    expect(
      rethrowMeta?.possibleSources.every((s) => s.via === "loadUser"),
    ).toBe(true);
  });

  it("resolves transitive rethrow chains (A → B → C)", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function deepest(id: string) {
        if (!id) throw new Error("deep failure");
        return { id };
      }

      export function middle(id: string) {
        try {
          return deepest(id);
        } catch (err) {
          throw err;
        }
      }

      export function outer(id: string) {
        try {
          return middle(id);
        } catch (err) {
          throw err;
        }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { outer } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async ({ params }: { params: { id: string } }) => {
          return { status: 200 as const, body: outer(params.id) };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();
    const outerSummary = summaries.find((s) => s.identity.name === "outer");
    const rethrowTransition = outerSummary?.transitions.find(
      (t) => t.output.type === "throw",
    );
    const rethrowMeta = rethrowTransition?.metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;
    expect(rethrowMeta).toBeDefined();

    const deep = rethrowMeta?.possibleSources.find(
      (s) => s.message === "deep failure",
    );
    expect(deep).toBeDefined();
    expect(deep?.via).toBe("middle");
  });

  it("does NOT enrich throws that already carry a static message", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function direct() {
        throw new Error("direct");
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { direct } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async () => {
          return { status: 200 as const, body: { v: direct() } };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const helper = (await adapter.extractAll()).find(
      (s) => s.identity.name === "direct",
    );
    const throwTransition = helper?.transitions.find(
      (t) => t.output.type === "throw",
    );
    expect(throwTransition).toBeDefined();
    expect(throwTransition?.metadata?.rethrow).toBeUndefined();
  });

  it("unions throws from every call site in a single try body, leaving out a callee that never throws", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function a() { throw new Error("a-err"); }
      export function b() { throw new Error("b-err"); }
      export function c() { return 42; }

      export function tryAll() {
        try {
          a();
          b();
          c();
        } catch (err) {
          throw err;
        }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { tryAll } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async () => {
          tryAll();
          return { status: 200 as const, body: { ok: true } };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const fn = (await adapter.extractAll()).find(
      (s) => s.identity.name === "tryAll",
    );
    const rethrow = fn?.transitions.find((t) => t.output.type === "throw");
    const meta = rethrow?.metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;
    expect(meta).toBeDefined();

    const sources = [...(meta?.possibleSources ?? [])].sort((x, y) =>
      x.via.localeCompare(y.via),
    );
    expect(sources.map((s) => s.via)).toEqual(["a", "b"]);
    expect(sources.map((s) => s.message)).toEqual(["a-err", "b-err"]);
  });

  it("enriches each rethrow independently when a function has multiple try-catches", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function a() { throw new Error("a-err"); }
      export function b() { throw new Error("b-err"); }

      export function twoRethrows() {
        try { a(); } catch (e) { throw e; }
        try { b(); } catch (e) { throw e; }
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { twoRethrows } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async () => {
          twoRethrows();
          return { status: 200 as const, body: { ok: true } };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const fn = (await adapter.extractAll()).find(
      (s) => s.identity.name === "twoRethrows",
    );
    expect(fn).toBeDefined();

    const throwTransitions = fn?.transitions.filter(
      (t) => t.output.type === "throw",
    );
    expect(throwTransitions).toHaveLength(2);

    const byLocation = [...(throwTransitions ?? [])].sort(
      (x, y) => x.location.start - y.location.start,
    );
    const firstMeta = byLocation[0].metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;
    const secondMeta = byLocation[1].metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;

    expect(firstMeta?.possibleSources.map((s) => s.via)).toEqual(["a"]);
    expect(firstMeta?.possibleSources.map((s) => s.message)).toEqual(["a-err"]);
    expect(secondMeta?.possibleSources.map((s) => s.via)).toEqual(["b"]);
    expect(secondMeta?.possibleSources.map((s) => s.message)).toEqual([
      "b-err",
    ]);
  });

  it("does NOT enrich a throw of a parameter with no enclosing try-catch", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "helpers.ts",
      `
      export function rethrowsInput(err: Error) {
        throw err;
      }
    `,
    );
    project.createSourceFile(
      "handlers.ts",
      `
      import { initServer } from "@ts-rest/express";
      import { rethrowsInput } from "./helpers";
      const s = initServer();
      export const router = s.router({} as any, {
        get: async () => {
          return { status: 200 as const, body: { v: rethrowsInput(new Error("x")) } };
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const helper = (await adapter.extractAll()).find(
      (s) => s.identity.name === "rethrowsInput",
    );
    const throwTransition = helper?.transitions.find(
      (t) => t.output.type === "throw",
    );
    expect(throwTransition).toBeDefined();
    expect(throwTransition?.metadata?.rethrow).toBeUndefined();
  });
});

describe("access recognizers", () => {
  it("resolves a name through the context's fact lookup", async () => {
    const { runtimeConfigBinding } = await import("@suss/behavioral-ir");
    const seen: string[] = [];
    const recognizingPack: PatternPack = {
      name: "test-config",
      protocol: "http",
      languages: ["typescript"],
      discovery: [
        {
          kind: "handler",
          match: { type: "namedExport", names: ["handler"] },
          requiresImport: [],
        },
      ],
      terminals: [
        { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      ],
      inputMapping: { type: "positionalParams", params: [] },
      accessRecognizers: [
        (access, rawCtx) => {
          const node = access as Node;
          const ctx = rawCtx as {
            resolveWrittenValue: (value: Node) => Node | null;
          };
          if (!Node.isCallExpression(node)) {
            return null;
          }
          if (node.getExpression().getText() !== "track") {
            return null;
          }
          const arg = node.getArguments()[0];
          const resolved =
            arg === undefined ? null : ctx.resolveWrittenValue(arg);
          const name =
            resolved !== null && Node.isStringLiteral(resolved)
              ? resolved.getLiteralValue()
              : null;
          if (name === null) {
            return null;
          }
          seen.push(name);
          return [
            {
              type: "interaction",
              binding: runtimeConfigBinding({
                recognition: "test-config",
                deploymentTarget: "lambda",
                instanceName: "<runtime>",
              }),
              callee: node.getExpression().getText(),
              interaction: { class: "config-read", name, defaulted: false },
            },
          ];
        },
      ],
    };

    const project = createTestProject();
    project.createSourceFile(
      "handler.ts",
      `
      const EVENT_NAME = "user.created";
      function track(name: string) { return name; }
      export function handler() {
        track(EVENT_NAME);
        return { ok: true };
      }
    `,
    );
    await createTypeScriptAdapter({
      project,
      frameworks: [recognizingPack],
    }).extractAll();
    expect(seen).toEqual(["user.created"]);
  });
});

describe("consumer extraction", () => {
  const fetchPack: PatternPack = {
    name: "fetch",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "global",
          importName: "fetch",
        },
        bindingExtraction: {
          method: {
            type: "fromArgumentProperty",
            position: 1,
            property: "method",
            default: "GET",
          },
          path: { type: "fromArgumentLiteral", position: 0 },
        },
      },
    ],
    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],
    inputMapping: {
      type: "positionalParams",
      params: [],
    },
  };

  it("resolves a URL bound to a constant, same-module or imported", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "urls.ts",
      'export const ORDERS_URL = "/api/orders";\n',
    );
    project.createSourceFile(
      "consumer.ts",
      `
      import { ORDERS_URL } from "./urls.js";
      const USERS_URL = "/api/users";
      export async function loadUsers() {
        return fetch(USERS_URL);
      }
      export async function loadOrders() {
        return fetch(ORDERS_URL, { method: "POST" });
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    const paths = summaries
      .map((s) => {
        const sem = s.identity.boundaryBinding?.semantics;
        return sem?.name === "rest" ? `${sem.method} ${sem.path}` : null;
      })
      .sort();
    expect(paths).toEqual(["GET /api/users", "POST /api/orders"]);
  });

  it("extracts a consumer summary from a function with fetch()", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser(id: string) {
        const res = await fetch("/users/" + id);
        if (!res.ok) {
          throw new Error("failed");
        }
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe("client");
    expect(summaries[0].identity.name).toBe("loadUser");
  });

  it("extracts boundary binding from literal URL argument", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getHealth() {
        const res = await fetch("/health");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/health" },
      recognition: "fetch",
    });
  });

  it("stamps a service-call interaction effect on the default branch (#180 unified-shape migration)", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser(id: string) {
        const res = await fetch("/users/" + id);
        return res.json();
      }
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    const summary =
      summaries.find((s) => s.identity.name === "loadUser") ??
      raise("loadUser summary missing");
    const defaultTransition =
      summary.transitions.find((t) => t.isDefault) ??
      raise("no default transition");
    const serviceCall = defaultTransition.effects.find(
      (e) => e.type === "interaction" && e.interaction.class === "service-call",
    );
    expect(serviceCall).toBeDefined();
    if (
      serviceCall === undefined ||
      serviceCall.type !== "interaction" ||
      serviceCall.interaction.class !== "service-call"
    ) {
      throw new Error("expected service-call interaction");
    }
    expect(serviceCall.interaction.method).toBe("GET");
    expect(serviceCall.binding.semantics.name).toBe("rest");
  });

  it("extracts a template-literal path with substitutions as OpenAPI placeholders", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getPet(petId: string) {
        const res = await fetch(\`/pet/\${petId}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(restPathOf(summaries[0])).toBe("/pet/{petId}");
  });

  it("extracts a template literal with no substitutions as the literal text", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function ping() {
        const res = await fetch(\`/health\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/health");
  });

  it("extracts a template-literal path with multiple substitutions", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getComment(petId: string, commentId: string) {
        const res = await fetch(\`/pet/\${petId}/comments/\${commentId}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/pet/{petId}/comments/{commentId}");
  });

  it("narrows an absolute URL with a query string to its pathname", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getOrder(id: string) {
        const res = await fetch("https://shop.example.com/api/orders/123?verbose=true");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/api/orders/123");
  });

  it("strips the query string from a relative literal", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function search(term: string) {
        const res = await fetch("/search?q=widgets&limit=10");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/search");
  });

  it("narrows an absolute template-literal URL with a parameter to its pathname", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getOrder(id: string) {
        const res = await fetch(\`https://shop.example.com/api/orders/\${id}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/api/orders/{id}");
  });

  it("answers a null path, and survives, when an absolute URL names no path at all", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function openApp() {
        const res = await fetch("myapp://host");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(restPathOf(summaries[0])).toBeNull();
  });

  it("keeps '/' as the path for a bare absolute URL with a real host", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function ping() {
        const res = await fetch("https://host");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/");
  });

  it("keeps '/' as the path for a bare absolute URL with a query string", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function ping() {
        const res = await fetch("https://host?q=1");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/");
  });

  it("treats a protocol-relative literal as absolute", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getOrder() {
        const res = await fetch("//api.example.com/orders/123");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/orders/123");
  });

  it("drops the host placeholder when a template literal's substitution is the host itself", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getX(host: string) {
        const res = await fetch(\`https://\${host}/api/x\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/api/x");
  });

  it("drops the host remainder when a template literal's substitution sits in the middle of the host", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getX(env: string) {
        const res = await fetch(\`https://\${env}.example.com/api/x\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/api/x");
  });

  const originShapes = [
    {
      what: "leaves the scheme to whatever loads the page",
      url: "//${host}/api/x",
      path: "/api/x",
    },
    {
      what: "writes host text before the substitution",
      url: "https://api-${env}.example.com/api/x",
      path: "/api/x",
    },
    {
      what: "splits the host across a substitution",
      url: "https://api${shard}.example.com/x",
      path: "/x",
    },
    {
      what: "substitutes the port",
      url: "https://example.com:${port}/x",
      path: "/x",
    },
    {
      what: "brackets a literal address and names a port",
      url: "https://[${host}]:8080/x",
      path: "/x",
    },
    {
      what: "substitutes the scheme",
      url: "${scheme}://example.com/x",
      path: "/x",
    },
    {
      what: "builds the scheme out of literal text and a substitution",
      url: "http${secure}://example.com/x",
      path: "/x",
    },
    {
      what: "carries userinfo",
      url: "https://${user}@example.com/x",
      path: "/x",
    },
    {
      what: "substitutes the path, after a host written out in full",
      url: "https://shop.example.com/orders/${id}",
      path: "/orders/{id}",
    },
    {
      what: "claims no path when the authority never ends",
      url: "https://example.com${suffix}",
      path: null,
    },
  ];

  function fetchSource(url: string): string {
    return [
      "export async function getX(",
      "  host: any, shard: any, port: any, scheme: any,",
      "  user: any, env: any, id: any, suffix: any, secure: any,",
      ") {",
      `  const res = await fetch(\`${url}\`);`,
      "  return res.json();",
      "}",
    ].join("\n");
  }

  it.each([
    { what: "a scheme with nothing after it", url: "https://" },
    { what: "an authority opener with nothing after it", url: "//" },
  ])("claims no path for $what", async ({ url }) => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      [
        "export async function getX() {",
        `  const res = await fetch("${url}");`,
        "  return res.json();",
        "}",
      ].join("\n"),
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBeNull();
  });

  it.each(originShapes)("$what", async ({ url, path }) => {
    const project = createTestProject();
    project.createSourceFile("consumer.ts", fetchSource(url));

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe(path);
  });

  it("stops composing a template literal's path at a query string, dropping the substitution after it", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function search(fmt: string) {
        const res = await fetch(\`/report?format=\${fmt}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/report");
  });

  it("uses the trailing property name when the substitution is a property access", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      interface Req { params: { id: string } }
      export async function handler(req: Req) {
        const res = await fetch(\`/users/\${req.params.id}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/users/{id}");
  });

  it("falls back to {param} when the substitution is not a simple identifier", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function search() {
        const res = await fetch(\`/search/\${"x".toUpperCase()}\`);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(restPathOf(summaries[0])).toBe("/search/{param}");
  });

  it("extracts method from options argument", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function createUser(data: any) {
        const res = await fetch("/users", { method: "POST", body: JSON.stringify(data) });
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(restMethodOf(summaries[0])).toBe("POST");
    expect(restPathOf(summaries[0])).toBe("/users");
  });

  it("defaults method to GET when no options argument", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getUser() {
        const res = await fetch("/users/1");
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(restMethodOf(summaries[0])).toBe("GET");
  });

  it("omits path when URL is non-literal", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function getUser(id: string) {
        const url = "/users/" + id;
        const res = await fetch(url);
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
    expect(restPathOf(summaries[0])).toBeNull();
  });

  it("produces status-code conditions the checker can read", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser(id: string) {
        const result = await fetch("/users/" + id);
        if (result.status === 404) {
          return null;
        }
        if (result.status === 200) {
          return result.json();
        }
        throw new Error("unexpected status");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    expect(s.transitions.length).toBeGreaterThanOrEqual(2);

    const statusesPerTransition = s.transitions.map((t) => {
      const statuses: number[] = [];
      for (const c of t.conditions) {
        const json = JSON.stringify(c);
        const match = json.match(/"value":(\d{3})/);
        if (match !== null && json.includes("status")) {
          statuses.push(Number(match[1]));
        }
      }
      return statuses;
    });

    const allStatuses = statusesPerTransition.flat();
    expect(allStatuses).toContain(404);
    expect(allStatuses).toContain(200);
  });
});

describe("response property semantics", () => {
  const fetchPackWithSemantics: PatternPack = {
    name: "fetch",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "global",
          importName: "fetch",
        },
        bindingExtraction: {
          method: {
            type: "fromArgumentProperty",
            position: 1,
            property: "method",
            default: "GET",
          },
          path: { type: "fromArgumentLiteral", position: 0 },
        },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    responseSemantics: [
      {
        name: "ok",
        access: "property",
        semantics: { type: "statusRange", min: 200, max: 299 },
      },
      {
        name: "status",
        access: "property",
        semantics: { type: "statusCode" },
      },
      {
        name: "json",
        access: "method",
        semantics: { type: "body" },
      },
      {
        name: "headers",
        access: "property",
        semantics: { type: "headers" },
      },
    ],
  };

  it("resolves response.ok to a status range comparison", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const res = await fetch("/users/1");
        if (res.ok) {
          return res.json();
        }
        throw new Error("request failed");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPackWithSemantics],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    const compounds = s.transitions
      .flatMap((t) => t.conditions)
      .filter((c) => c.type === "compound" && c.op === "and");
    expect(compounds).toHaveLength(1);

    const compound = compounds[0];
    if (compound.type === "compound") {
      expect(compound.operands).toHaveLength(2);
      const [gte, lte] = compound.operands;
      expect(gte).toMatchObject({
        type: "comparison",
        op: "gte",
        right: { type: "literal", value: 200 },
      });
      expect(lte).toMatchObject({
        type: "comparison",
        op: "lte",
        right: { type: "literal", value: 299 },
      });
    }
  });

  it("resolves negated !response.ok to negation(status range)", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const res = await fetch("/users/1");
        if (!res.ok) {
          throw new Error("request failed");
        }
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPackWithSemantics],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    const negations = s.transitions
      .flatMap((t) => t.conditions)
      .filter((c) => c.type === "negation");
    expect(negations.length).toBeGreaterThanOrEqual(1);

    const negation = negations.find(
      (c) => c.type === "negation" && c.operand.type === "compound",
    );
    expect(negation).toBeDefined();
    if (negation?.type === "negation" && negation.operand.type === "compound") {
      expect(negation.operand.op).toBe("and");
      expect(negation.operand.operands).toHaveLength(2);
    }
  });

  it("leaves status comparisons unchanged", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const res = await fetch("/users/1");
        if (res.status === 404) {
          return null;
        }
        return res.json();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [fetchPackWithSemantics],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    const statusBranch = s.transitions.find((t) =>
      t.conditions.some(
        (c) =>
          c.type === "comparison" &&
          c.op === "eq" &&
          c.right.type === "literal" &&
          c.right.value === 404,
      ),
    );
    expect(statusBranch).toBeDefined();
  });

  it("does not resolve when pack has no responseSemantics", async () => {
    const { responseSemantics: _, ...packWithoutSemantics } =
      fetchPackWithSemantics;
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      export async function loadUser() {
        const res = await fetch("/users/1");
        if (res.ok) {
          return res.json();
        }
        throw new Error("failed");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [packWithoutSemantics],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);

    const s = summaries[0];
    const hasTruthiness = s.transitions.some((t) =>
      t.conditions.some((c) => c.type === "truthinessCheck"),
    );
    expect(hasTruthiness).toBe(true);
  });
});

describe("client-side contract resolution via fromClientMethod", () => {
  const tsRestClientPack: PatternPack = {
    name: "ts-rest",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "@ts-rest/core",
          importName: "initClient",
        },
        bindingExtraction: {
          method: { type: "fromClientMethod" },
          path: { type: "fromClientMethod" },
        },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    contractReading: {
      discovery: {
        importModule: "@ts-rest/core",
        importName: "initContract",
        registrationChain: [".router"],
      },
      responseExtraction: { property: "responses" },
      methodProperty: "method",
      pathProperty: "path",
      paramsExtraction: { property: "pathParams" },
    },
    inputMapping: { type: "positionalParams", params: [] },
  };

  it("resolves method+path on a client.method() call by walking back to the contract", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import { initClient, initContract } from "@ts-rest/core";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: { 200: null as any, 404: null as any },
        },
      });

      const client = initClient(contract, { baseUrl: "" });

      export async function loadUser(id: string) {
        return client.getUser({ params: { id } });
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestClientPack],
    });
    const summaries = await adapter.extractAll();
    const consumer = summaries.find((s) => s.identity.name === "loadUser");
    expect(consumer).toBeDefined();
    expect(consumer?.kind).toBe("client");
    expect(consumer?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "ts-rest",
    });
  });

  it("returns no binding when the called method isn't in the contract", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "consumer.ts",
      `
      import { initClient, initContract } from "@ts-rest/core";

      const c = initContract();
      const contract = c.router({
        getUser: {
          method: "GET",
          path: "/users/:id",
          responses: { 200: null as any },
        },
      });

      const client = initClient(contract, { baseUrl: "" });

      export async function ping() {
        return client.healthCheck();
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestClientPack],
    });
    const summaries = await adapter.extractAll();
    const consumer = summaries.find((s) => s.identity.name === "ping");
    expect(consumer?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: null, path: null },
      recognition: "ts-rest",
    });
  });
});

describe("wrapper expansion", () => {
  const axiosLikePack: PatternPack = {
    name: "axios",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "client",
        match: {
          type: "clientCall",
          importModule: "axios",
          importName: "axios",
          methodFilter: ["get"],
          factoryMethods: ["create"],
        },
        bindingExtraction: {
          method: { type: "literal", value: "GET" },
          path: { type: "fromArgumentLiteral", position: 0 },
        },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    responseSemantics: [
      { name: "data", access: "property", semantics: { type: "body" } },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
    ],
  };

  function makeProject(): Project {
    return createTestProject();
  }

  it("synthesises a caller summary for a single-hop path-passthrough wrapper", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function getPet(id: number) {
        return getJson<unknown>(\`/pet/\${id}\`);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();

    const wrapper = summaries.find((s) => s.identity.name === "getJson");
    expect(wrapper).toBeDefined();
    expect(restPathOf(wrapper)).toBeNull();

    const caller = summaries.find((s) => s.identity.name === "getPet");
    expect(caller).toBeDefined();
    expect(caller?.kind).toBe("client");
    expect(caller?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/pet/{id}" },
      recognition: "axios",
    });
    expect(caller?.confidence.level).toBe("low");
    expect(
      (caller?.metadata as { derivedFromWrapper?: { name: string } })
        ?.derivedFromWrapper?.name,
    ).toBe("getJson");
  });

  it("emits a synthetic summary for every distinct caller", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function getPet(id: number) {
        return getJson<unknown>(\`/pet/\${id}\`);
      }

      export async function listPets() {
        return getJson<unknown>("/pet/findByStatus");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();

    const callerPaths = summaries
      .filter(
        (s) =>
          (s.metadata as { derivedFromWrapper?: unknown } | undefined)
            ?.derivedFromWrapper !== undefined,
      )
      .map((s) => restPathOf(s))
      .sort();
    expect(callerPaths).toEqual(["/pet/findByStatus", "/pet/{id}"]);
  });

  it("does not synthesise a caller summary when the call site has no literal path", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function getMystery(p: string) {
        // Path is a parameter in the caller too, so nothing is literal.
        return getJson<unknown>(p);
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();

    const synthesised = summaries.filter(
      (s) =>
        (s.metadata as { derivedFromWrapper?: unknown } | undefined)
          ?.derivedFromWrapper !== undefined,
    );
    expect(synthesised).toHaveLength(0);
  });

  it("resolves caller args even when the wrapper is a sibling export", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function getCount() {
        return getJson<number>("/count");
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();
    const caller = summaries.find((s) => s.identity.name === "getCount");
    expect(restPathOf(caller)).toBe("/count");
  });

  it("respects export-keyword boundary on enclosing function lookup", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function fetchAndProcess() {
        const internal = await getJson<unknown>("/internal");
        return internal;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();
    expect(
      summaries.find((s) => s.identity.name === "fetchAndProcess"),
    ).toBeDefined();
  });

  it("populates expectedInput with every field the caller reads off the wrapper return, `status` included", async () => {
    const project = makeProject();
    project.createSourceFile(
      "api.ts",
      `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });

      export async function getJson<T>(path: string): Promise<T> {
        const { data } = await api.get(path);
        return data;
      }
    `,
    );
    project.createSourceFile(
      "client.ts",
      `
      import { getJson } from "./api";

      export async function describePet(petId: number) {
        const pet = await getJson<{ id: number; status: string }>(\`/pet/\${petId}\`);
        return \`\${pet.id}:\${pet.status}\`;
      }
    `,
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [axiosLikePack],
    });
    const summaries = await adapter.extractAll();

    const caller = summaries.find((s) => s.identity.name === "describePet");
    expect(caller).toBeDefined();
    const withInput = caller?.transitions.find(
      (t) => t.expectedInput?.type === "record",
    );
    expect(withInput).toBeDefined();
    if (withInput?.expectedInput?.type === "record") {
      expect(withInput.expectedInput.properties).toHaveProperty("id");
      expect(withInput.expectedInput.properties).toHaveProperty("status");
    } else {
      throw new Error("expected record expectedInput on wrapper-call branch");
    }
  });
});

describe("subUnits plumbing", () => {
  function makeProject() {
    return createTestProject();
  }

  const testPack: PatternPack = {
    name: "test-pack",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [
      { kind: "handler", match: { type: "namedExport", names: ["default"] } },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    subUnits: (parent) => {
      return [
        {
          func: parent.func,
          kind: "handler",
          name: `${parent.name}.synthetic`,
          metadata: { custom: { note: "from-subUnits" } },
        },
      ];
    },
  };

  it("calls pack.subUnits and produces a summary per returned unit", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Subject.ts",
      `
        export default function subject() {
          return 42;
        }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [testPack],
    });
    const summaries = await adapter.extractAll();

    const synthetic = summaries.find((s) =>
      s.identity.name.endsWith(".synthetic"),
    );
    expect(synthetic).toBeDefined();
    expect(synthetic?.kind).toBe("handler");
    const meta = synthetic?.metadata?.custom as { note?: string } | undefined;
    expect(meta?.note).toBe("from-subUnits");
  });

  it("sub-unit summaries inherit the parent's boundary binding", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Subject.ts",
      `
        export default function subject() { return 42; }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [testPack],
    });
    const summaries = await adapter.extractAll();

    const parent = summaries.find((s) => s.identity.name === "subject");
    const sub = summaries.find((s) => s.identity.name === "subject.synthetic");
    expect(sub?.identity.boundaryBinding).toEqual(
      parent?.identity.boundaryBinding,
    );
  });

  it("packs without subUnits produce no sub-units", async () => {
    const { subUnits: _omit, ...rest } = testPack;
    const noSubUnitsPack: PatternPack = rest;
    const project = makeProject();
    project.createSourceFile(
      "/Subject.ts",
      `
        export default function subject() { return 42; }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [noSubUnitsPack],
    });
    const summaries = await adapter.extractAll();
    expect(summaries).toHaveLength(1);
  });

  it("sub-unit terminals default to `return` + `throw` when unset", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Subject.ts",
      `
        export default function subject() {
          if (true) { throw new Error("bad"); }
          return 42;
        }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [testPack],
    });
    const summaries = await adapter.extractAll();
    const sub = summaries.find((s) => s.identity.name === "subject.synthetic");
    const outputTypes = new Set(sub?.transitions.map((t) => t.output.type));
    expect(outputTypes.has("throw")).toBe(true);
    expect(outputTypes.has("return")).toBe(true);
  });

  it("sub-unit custom terminals / inputMapping override the adapter defaults", async () => {
    const customPack: PatternPack = {
      ...testPack,
      subUnits: (parent) => [
        {
          func: parent.func,
          kind: "handler",
          name: `${parent.name}.custom`,
          terminals: [
            {
              kind: "return",
              match: { type: "returnStatement" },
              extraction: {},
            },
          ],
          inputMapping: {
            type: "positionalParams",
            params: [{ position: 0, role: "first" }],
          },
        },
      ],
    };
    const project = makeProject();
    project.createSourceFile(
      "/Subject.ts",
      `
        export default function subject(x: number) {
          if (x < 0) { throw new Error("bad"); }
          return x;
        }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [customPack],
    });
    const summaries = await adapter.extractAll();
    const sub = summaries.find((s) => s.identity.name === "subject.custom");
    expect(sub).toBeDefined();
    expect(sub?.transitions.some((t) => t.output.type === "throw")).toBe(false);
    const input = sub?.inputs[0];
    if (input !== undefined && input.type === "parameter") {
      expect(input.role).toBe("first");
    } else {
      throw new Error("expected parameter input");
    }
  });
});

describe("inline JSX conditional decomposition", () => {
  const reactPack: PatternPack = {
    name: "react",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [
      { kind: "component", match: { type: "namedExport", names: ["default"] } },
    ],
    terminals: [
      { kind: "render", match: { type: "jsxReturn" }, extraction: {} },
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    inputMapping: { type: "componentProps", paramPosition: 0 },
  };

  function makeProject() {
    return createTestProject();
  }

  function rootOf(summaries: ReturnType<typeof Array.prototype.at>) {
    return summaries;
  }
  void rootOf; // silence unused-lint if we don't reach the helper path

  it("expression that isn't a JSX pattern stays as an opaque `expression` node", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Map.tsx",
      `
        export default function Map(props: { items: string[] }) {
          return <ul>{props.items.map((i) => i)}</ul>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "Map") ??
      raise("Map summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.children[0].type).toBe("expression");
  });

  it("`{x || <Fallback/>}` stays opaque: `||` is not decomposed", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Or.tsx",
      `
        export default function Or(props: { label: string }) {
          return <div>{props.label || <span>fallback</span>}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "Or") ??
      raise("Or summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.children[0].type).toBe("expression");
  });

  it("`{cond ? nonJsx : <Fallback/>}` negates the condition and promotes the JSX branch", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Neg.tsx",
      `
        export default function Neg(props: { label: string; has: boolean }) {
          return <div>{props.has ? props.label : <span>empty</span>}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "Neg") ??
      raise("Neg summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const child = root.children[0];
    if (child.type !== "conditional") {
      throw new Error("expected conditional with negated condition");
    }
    expect(child.condition).toBe("!(props.has)");
    expect(child.whenFalse).toBeNull();
    if (child.whenTrue.type !== "element") {
      throw new Error("expected element whenTrue");
    }
    expect(child.whenTrue.tag).toBe("span");
  });

  it("`undefined` identifier in a ternary branch reads as no-render", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Undef.tsx",
      `
        export default function Undef(props: { show: boolean }) {
          return <div>{props.show ? <span>hi</span> : undefined}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "Undef") ??
      raise("Undef summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const child = root.children[0];
    if (child.type !== "conditional") {
      throw new Error("expected conditional");
    }
    expect(child.condition).toBe("props.show");
    expect(child.whenFalse).toBeNull();
  });

  it("`cond && <nonJsx>` stays opaque when the right side isn't statically JSX", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/AndNonJsx.tsx",
      `
        export default function AndNonJsx(props: { show: boolean; label: string }) {
          return <div>{props.show && props.label}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "AndNonJsx") ??
      raise("AndNonJsx summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.children[0].type).toBe("expression");
  });

  it("ternary with neither branch statically JSX stays opaque", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/DataTernary.tsx",
      `
        export default function DataTernary(props: { show: boolean; a: string; b: string }) {
          return <div>{props.show ? props.a : props.b}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "DataTernary") ??
      raise("DataTernary summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.children[0].type).toBe("expression");
  });

  it("`false` literal in a ternary branch reads as no-render", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/FalseLit.tsx",
      `
        export default function FalseLit(props: { show: boolean }) {
          return <div>{props.show ? <span>hi</span> : false}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp =
      summaries.find((s) => s.identity.name === "FalseLit") ??
      raise("FalseLit summary not found");
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const child = root.children[0];
    if (child.type !== "conditional") {
      throw new Error("expected conditional");
    }
    expect(child.condition).toBe("props.show");
    expect(child.whenFalse).toBeNull();
  });

  it("parenthesised JSX inside a conditional unwraps correctly", async () => {
    const project = makeProject();
    project.createSourceFile(
      "/Paren.tsx",
      `
        export default function Paren(props: { ok: boolean }) {
          return <div>{props.ok && (<span>yes</span>)}</div>;
        }
      `,
    );
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [reactPack],
    }).extractAll();
    const comp = summaries.find((s) => s.identity.name === "Paren");
    if (!comp) {
      throw new Error("Paren summary missing");
    }
    const out = comp.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const child = root.children[0];
    if (child.type !== "conditional") {
      throw new Error("expected conditional");
    }
    expect(child.condition).toBe("props.ok");
    if (child.whenTrue.type !== "element") {
      throw new Error("expected element whenTrue");
    }
    expect(child.whenTrue.tag).toBe("span");
  });
});

const expressResPack: PatternPack = {
  name: "express",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["handleUser"] } },
  ],
  terminals: [
    {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition: 1,
        methodChain: ["json"],
      },
      extraction: {
        body: { from: "argument", position: 0 },
        defaultStatusCode: 200,
      },
    },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [
      { position: 0, role: "request" },
      { position: 1, role: "response" },
    ],
  },
};

describe("walker descent", () => {
  it("(a) finds a handler's terminal produced inside a Promise executor", () => {
    const project = createTestProject();
    const source = `
      declare function loadUser(id: string): { name: string };
      export function handleUser(req: any, res: any) {
        new Promise<void>((resolve) => {
          const user = loadUser(req.params.id);
          res.json({ name: user.name });
          resolve();
        });
      }
    `;
    const file = project.createSourceFile("handler.ts", source);
    const units = discoverUnits(file, expressResPack.discovery);
    const raw = extractCodeStructure(units[0], expressResPack);

    const responseBranches = raw.branches.filter(
      (b) => b.terminal.kind === "response",
    );
    expect(responseBranches).toHaveLength(1);
    const shape = responseBranches[0].terminal.body?.shape;
    expect(shape?.type).toBe("record");
    if (shape?.type === "record") {
      expect(Object.keys(shape.properties)).toContain("name");
    }

    const summary = assembleSummary(raw);
    const responses = summary.transitions.filter(
      (t) => t.output.type === "response",
    );
    expect(responses).toHaveLength(1);
    const out = responses[0].output;
    if (out.type !== "response") {
      throw new Error("expected response output");
    }
    expect(out.statusCode).toEqual({ type: "literal", value: 200 });
  });

  it("(c) descends a class method's nested arrow to find the terminal", () => {
    const project = createTestProject();
    const source = `
      declare function loadUser(id: string): Promise<{ name: string }>;
      export class UserController {
        getUser(req: any, res: any) {
          loadUser(req.params.id).then((user) => {
            res.json({ name: user.name });
          });
        }
      }
    `;
    const file = project.createSourceFile("controller.ts", source);
    const method = file
      .getClassOrThrow("UserController")
      .getMethodOrThrow("getUser");
    const unit: DiscoveredUnit = {
      func: method as FunctionRoot,
      kind: "handler",
      name: "UserController.getUser",
    };
    const raw = extractCodeStructure(unit, expressResPack);

    const responseBranches = raw.branches.filter(
      (b) => b.terminal.kind === "response",
    );
    expect(responseBranches).toHaveLength(1);
    const shape = responseBranches[0].terminal.body?.shape;
    expect(shape?.type).toBe("record");
    if (shape?.type === "record") {
      expect(Object.keys(shape.properties)).toContain("name");
    }

    const summary = assembleSummary(raw);
    expect(summary.transitions).not.toHaveLength(0);
    expect(summary.transitions.some((t) => t.output.type === "response")).toBe(
      true,
    );
  });

  it("attributes an effect inside a `.then` callback to the enclosing unit", () => {
    const project = createTestProject();
    const source = `
      declare const audit: { record(msg: string): void };
      declare function loadUser(id: string): Promise<{ name: string }>;
      export function handleUser(req: any, res: any) {
        loadUser(req.params.id).then((user) => {
          audit.record("loaded");
          res.json({ name: user.name });
        });
      }
    `;
    const file = project.createSourceFile("handler.ts", source);
    const units = discoverUnits(file, expressResPack.discovery);
    const raw = extractCodeStructure(units[0], expressResPack);

    const defaultBranch = raw.branches.find((b) => b.isDefault);
    const callees = (defaultBranch?.effects ?? []).flatMap((e) =>
      e.type === "invocation" ? [e.callee] : [],
    );
    expect(callees).toContain("audit.record");
  });

  it("stops descent at a pack-declared sub-unit boundary", () => {
    const deferPack: PatternPack = {
      ...expressResPack,
      name: "defer-pack",
      subUnits: (parent, ctx) => {
        const c = ctx as {
          findCallExpressionsByName: (
            f: unknown,
            name: string,
          ) => Array<unknown>;
          getCallArgumentFunction: (call: unknown, position: number) => unknown;
        };
        const out: Array<{ func: unknown; kind: string; name: string }> = [];
        for (const call of c.findCallExpressionsByName(parent.func, "defer")) {
          const fn = c.getCallArgumentFunction(call, 0);
          if (fn !== null) {
            out.push({
              func: fn,
              kind: "handler",
              name: `${parent.name}.defer`,
            });
          }
        }
        return out as never;
      },
    };

    const project = createTestProject();
    const source = `
      declare function defer(cb: () => void): void;
      declare const audit: { record(msg: string): void };
      export function handleUser(req: any, res: any) {
        defer(() => {
          audit.record("deferred");
        });
        res.json({ ok: true });
      }
    `;
    project.createSourceFile("handler.ts", source);
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [deferPack],
      includeReachable: false,
    });

    return adapter.extractAll().then((summaries) => {
      const parent = summaries.find((s) => s.identity.name === "handleUser");
      expect(parent).toBeDefined();
      const parentCallees = (parent?.transitions ?? []).flatMap((t) =>
        t.effects.flatMap((e) => (e.type === "invocation" ? [e.callee] : [])),
      );
      expect(parentCallees).not.toContain("audit.record");
      const sub = summaries.find((s) => s.identity.name === "handleUser.defer");
      expect(sub).toBeDefined();
      const subCallees = (sub?.transitions ?? []).flatMap((t) =>
        t.effects.flatMap((e) => (e.type === "invocation" ? [e.callee] : [])),
      );
      expect(subCallees).toContain("audit.record");
    });
  });
});

describe("discoverUnits callback with routeInfo + metadata", () => {
  const manifestPack: PatternPack = {
    name: "manifest-lambda",
    protocol: "http",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [
      {
        kind: "response",
        match: { type: "returnShape", requiredProperties: ["statusCode"] },
        extraction: {
          statusCode: { from: "property", name: "statusCode" },
          body: { from: "property", name: "body", unwrapJsonStringify: true },
        },
      },
    ],
    inputMapping: {
      type: "positionalParams",
      params: [{ position: 0, role: "event" }],
    },
    discoverUnits: (sf, ctx) => {
      const c = ctx as {
        exportedFunctions: (
          s: unknown,
        ) => Array<{ name: string; func: unknown }>;
      };
      const handler = c.exportedFunctions(sf).find((f) => f.name === "handler");
      if (handler === undefined) {
        return [];
      }
      const base = {
        func: handler.func,
        kind: "handler",
        name: "Fn.handler",
        metadata: { manifest: { fn: "Fn" } },
      };
      return [
        { ...base, routeInfo: { method: "GET", path: "/things/{id}" } },
        { ...base, routeInfo: { method: "DELETE", path: "/things/{id}" } },
      ];
    },
  };

  async function run(): Promise<BehavioralSummary[]> {
    const project = createTestProject();
    project.createSourceFile(
      "handler.ts",
      `
      export const handler = async (event: any) => {
        if (!event.id) {
          return { statusCode: 400, body: JSON.stringify({ error: "no id" }) };
        }
        return { statusCode: 200, body: JSON.stringify({ id: event.id }) };
      };
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [manifestPack],
    });
    return await adapter.extractAll();
  }

  it("emits one REST-bound summary per routeInfo on a shared function", async () => {
    const summaries = await run();
    const get = summaries.find(
      (s) => restMethodOf(s) === "GET" && restPathOf(s) === "/things/{id}",
    );
    const del = summaries.find(
      (s) => restMethodOf(s) === "DELETE" && restPathOf(s) === "/things/{id}",
    );
    expect(get).toBeDefined();
    expect(del).toBeDefined();
    expect(summaries).toHaveLength(2);
  });

  it("merges the callback's unit metadata onto the summary", async () => {
    const summaries = await run();
    const get = summaries.find((s) => restMethodOf(s) === "GET");
    expect(get?.metadata?.manifest).toEqual({ fn: "Fn" });
  });

  it("unwraps JSON.stringify bodies through the callback-discovered unit", async () => {
    const summaries = await run();
    const get = summaries.find((s) => restMethodOf(s) === "GET");
    const ok = get?.transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );
    expect(ok?.output.type).toBe("response");
    if (ok?.output.type === "response") {
      expect(JSON.stringify(ok.output.body)).toContain("id");
      expect(JSON.stringify(ok.output.body)).not.toContain("JSON.stringify");
    }
  });
});
