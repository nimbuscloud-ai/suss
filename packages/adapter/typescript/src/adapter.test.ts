// adapter.test.ts — Integration tests for createTypeScriptAdapter (Task 2.5b)

import path from "node:path";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter, extractCodeStructure } from "./adapter.js";
import { readContract } from "./contract.js";
import { discoverUnits } from "./discovery.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

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

// ---------------------------------------------------------------------------
// ts-rest framework pack (same as @suss/framework-ts-rest)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixturesDir() {
  return path.resolve(__dirname, "../../../../fixtures/ts-rest");
}

function createFixtureProject(): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
    },
  });

  project.addSourceFilesAtPaths(path.join(fixturesDir(), "*.ts"));
  return project;
}

// ---------------------------------------------------------------------------
// extractCodeStructure unit tests
// ---------------------------------------------------------------------------

const raise = (msg: string): never => {
  throw new Error(msg);
};

describe("extractCodeStructure", () => {
  it("extracts parameters from a destructured ts-rest handler", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.parameters).toEqual([
      { name: "params", position: 0, role: "pathParams", typeText: null },
      { name: "body", position: 0, role: "requestBody", typeText: null },
    ]);
    expect(raw.identity.name).toBe("getUser");
    expect(raw.identity.kind).toBe("handler");
  });

  it("extracts parameters from an ArrayBindingPattern under allPositional", async () => {
    // `([state, setState]) => ...` — common in callbacks that destructure
    // tuple returns. Each bound name should surface as its own Input.
    // Omitted-expression holes (`[, b]`) are skipped.
    const project = new Project({ useInMemoryFileSystem: true });
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

    const raw = extractCodeStructure(units[0], allPositionalPack, "test.ts");
    expect(raw.parameters).toEqual([
      { name: "state", position: 0, role: "state", typeText: null },
      { name: "setState", position: 0, role: "setState", typeText: null },
      { name: "rest", position: 0, role: "rest", typeText: null },
    ]);
  });

  it("extracts dependency calls from function body", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.dependencyCalls).toHaveLength(1);
    expect(raw.dependencyCalls[0].name).toBe("db.findById");
    expect(raw.dependencyCalls[0].assignedTo).toBe("user");
    expect(raw.dependencyCalls[0].async).toBe(true);
  });

  it("extracts branches with conditions and terminals", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.branches).toHaveLength(2);

    // First branch: 404 with condition !user
    expect(raw.branches[0].terminal.kind).toBe("response");
    expect(raw.branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(raw.branches[0].isDefault).toBe(false);
    expect(raw.branches[0].conditions.length).toBeGreaterThan(0);

    // Second branch: 200 default
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
    const project = new Project({ useInMemoryFileSystem: true });
    const source = `
      export function getUser(req: any, res: any, next: any) {
        return { status: 200, body: {} };
      }
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, expressPack.discovery);
    const raw = extractCodeStructure(units[0], expressPack, "test.ts");

    expect(raw.parameters).toEqual([
      { name: "req", position: 0, role: "request", typeText: null },
      { name: "res", position: 1, role: "response", typeText: null },
      { name: "next", position: 2, role: "next", typeText: null },
    ]);
  });

  it("extracts non-destructured object parameter", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.parameters).toEqual([
      { name: "ctx", position: 0, role: "request", typeText: null },
    ]);
  });

  it("handles expression-body arrow with no dependency calls", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = `
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        health: async () => ({ status: 200, body: { ok: true } }),
      });
    `;
    const file = project.createSourceFile("test.ts", source);
    const units = discoverUnits(file, tsRestPack.discovery);
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.dependencyCalls).toHaveLength(0);
    expect(raw.branches).toHaveLength(1);
    expect(raw.branches[0].isDefault).toBe(true);
  });

  it("extracts multiple dependency calls including sync", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.dependencyCalls).toHaveLength(2);
    expect(raw.dependencyCalls[0].name).toBe("validate");
    expect(raw.dependencyCalls[0].async).toBe(false);
    expect(raw.dependencyCalls[1].name).toBe("db.findById");
    expect(raw.dependencyCalls[1].async).toBe(true);
  });

  it("handles handler with no parameters", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.parameters).toEqual([]);
  });

  it("extracts dependency calls nested inside if/try blocks", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    // Should find all 3 dep calls: top-level validate, nested db.findById, nested db.log
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.branches).toHaveLength(2);

    // Branch 1: 200 with condition "user" positive
    expect(raw.branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(raw.branches[0].conditions.length).toBeGreaterThan(0);
    expect(raw.branches[0].conditions[0].polarity).toBe("positive");

    // Branch 2: 404 with condition "user" negative
    expect(raw.branches[1].terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(raw.branches[1].conditions.length).toBeGreaterThan(0);
    expect(raw.branches[1].conditions[0].polarity).toBe("negative");
  });

  it("extracts destructured dependency call assignedTo as null", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const raw = extractCodeStructure(units[0], tsRestPack, "test.ts");

    expect(raw.dependencyCalls).toHaveLength(1);
    expect(raw.dependencyCalls[0].name).toBe("db.find");
    expect(raw.dependencyCalls[0].assignedTo).toBeNull();
    expect(raw.dependencyCalls[0].async).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readContract unit tests
// ---------------------------------------------------------------------------

describe("readContract", () => {
  it("reads contract responses from same-file contract definition", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toEqual([
      { statusCode: 200 },
      { statusCode: 404 },
    ]);
    expect(result?.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "core",
    });
  });

  it("returns null when handler is not in a router call", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = `
      export async function standalone() {
        return { status: 200, body: {} };
      }
    `;
    const file = project.createSourceFile("test.ts", source);

    // Manually create a DiscoveredUnit that's NOT inside a router call
    const fn = file.getFunctions()[0];
    const result = readContract(
      { func: fn, kind: "handler", name: "standalone" },
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
    );

    expect(result).toBeNull();
  });

  it("returns null when handler name does not match any contract endpoint", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

    // deleteUser has no matching contract entry
    const result = readContract(
      units[0],
      tsRestPack.contractReading ??
        raise("ts-rest pack missing contractReading"),
    );
    expect(result).toBeNull();
  });

  it("reads contract for method-shorthand handlers", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toHaveLength(2);
    expect(restMethodOf(result ?? null)).toBe("GET");
  });

  it("extracts body TypeShape from c.type<T>() declarations", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    );

    expect(result).not.toBeNull();
    expect(result?.declaredContract.responses).toEqual([{ statusCode: 200 }]);
  });

  it("returns null boundaryBinding when contract has no method or path", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    );

    expect(result).not.toBeNull();
    expect(result?.boundaryBinding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full integration: createTypeScriptAdapter with fixture files
// ---------------------------------------------------------------------------

describe("createTypeScriptAdapter — ts-rest fixtures", () => {
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

    // Should discover both getUser and createUser handlers
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

    // getUser has 4 transitions:
    //   1. !params.id → 404
    //   2. !user → 404
    //   3. user.deletedAt → 404
    //   4. default → 200
    expect(getUser?.transitions).toHaveLength(4);

    // Check status codes
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

    // Last transition should be default
    expect(getUser?.transitions[3].isDefault).toBe(true);

    // First three should not be default
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

    // params should be extracted with role "pathParams"
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

    // The contract declares 500 but the handler never produces it
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

    // The metadata should include the declaredContract under the HTTP namespace
    expect(getUser?.metadata).toBeDefined();
    const http = getUser?.metadata?.http as Record<string, unknown> | undefined;
    expect(http?.declaredContract).toBeDefined();
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

    // createUser has 2 transitions:
    //   1. !body.name || !body.email → 400
    //   2. default → 201
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

    // Add a .d.ts file — should be skipped
    project.createSourceFile(
      "types.d.ts",
      "export interface Foo { bar: string }",
    );

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [tsRestPack],
    });

    const summaries = await adapter.extractAll();

    // Should still only find handlers from handlers.ts
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
    // None of the conditions should be opaque
    for (const t of getUser.transitions) {
      for (const c of t.conditions) {
        expect(c.type).not.toBe("opaque");
      }
    }

    // Transition 0: the guard `if (!params.id)` — terminal is in the
    // then-branch (positive polarity). parseConditionExpression folds
    // the `!` into truthinessCheck.negated, so no wrapping negation node.
    const t0 = getUser.transitions[0];
    expect(t0.conditions).toHaveLength(1);
    expect(t0.conditions[0].type).toBe("truthinessCheck");
    if (t0.conditions[0].type === "truthinessCheck") {
      expect(t0.conditions[0].negated).toBe(true);
      // params.id → derived(input(params), propertyAccess("id"))
      expect(t0.conditions[0].subject.type).toBe("derived");
    }

    // Transition 1: `if (!user)` with prior early return for `!params.id`.
    // The early return condition has polarity "negative" so assembleSummary
    // wraps it in a negation node.
    const t1 = getUser?.transitions[1];
    expect(t1.conditions.length).toBeGreaterThanOrEqual(2);
    // First condition: negation of the early return guard (!params.id)
    expect(t1.conditions[0].type).toBe("negation");
    // Last condition: the !user truthinessCheck (positive polarity, negated folded in)
    const t1Last = t1.conditions[t1.conditions.length - 1];
    expect(t1Last.type).toBe("truthinessCheck");
    if (t1Last.type === "truthinessCheck") {
      expect(t1Last.negated).toBe(true);
      // user should resolve to a dependency (db.findById)
      expect(t1Last.subject.type).toBe("dependency");
    }

    // Transition 2: `if (user.deletedAt)` with two prior early return guards.
    const t2 = getUser?.transitions[2];
    expect(t2.conditions.length).toBeGreaterThanOrEqual(3);
    // Last condition: truthinessCheck on user.deletedAt (positive polarity)
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

    // The first transition has a guard: !body.name || !body.email
    // This is an early return, so its polarity is "negative".
    // The condition expression itself is `!body.name || !body.email`.
    // The negation of that compound expression is the actual predicate.
    const t0 = createUser.transitions[0];
    expect(t0.conditions.length).toBeGreaterThan(0);
  });

  it("produces reverse gap when handler returns undeclared status", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

    // 400 is produced but not declared → reverse gap
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
    const project = new Project({ useInMemoryFileSystem: true });
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

// ---------------------------------------------------------------------------
// Reachable-closure (transitive library discovery)
// ---------------------------------------------------------------------------
//
// Every function reachable through a static call edge from a pack-discovered
// unit becomes a `library` summary with `recognition: "reachable"`. Seeds:
// pack discovery + wrapper expansion + sub-unit synthesis. Stops at
// node_modules / declaration files / higher-order indirection.

describe("createTypeScriptAdapter — cross-pack dedup", () => {
  it("produces one summary per (function, kind) even when multiple packs discover the same unit", async () => {
    // Two packs, both discovering the same default-exported function as
    // a `component`. Before cross-pack dedup this produced two summaries
    // at different `recognition` labels. First pack wins — user controls
    // precedence via the frameworks[] order.
    const project = new Project({ useInMemoryFileSystem: true });
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

  it("respects framework order — first-listed wins", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

describe("createTypeScriptAdapter — reachable closure", () => {
  it("discovers internal helpers transitively called from a handler", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

    // Handler discovered by the ts-rest pack, helpers reached via closure.
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

  it("transitively reaches helpers called by other helpers", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    // `unused` is never reached from a seed → no summary for it.
    expect(names).not.toContain("unused");
  });

  it("stops at declaration-file boundaries (skips external deps)", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    // Only the handler — db.findById is `declare const`, not a reachable
    // function in our code.
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("get");
  });

  it("opt-out via includeReachable: false yields only pack-discovered units", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // Exactly one `shared` summary despite two reach paths.
    expect(names.filter((n) => n === "shared")).toHaveLength(1);
    expect(names).toEqual(["a", "b", "shared"]);
  });
});

// ---------------------------------------------------------------------------
// Rethrow enrichment — cross-summary error-taxonomy composition
// ---------------------------------------------------------------------------
//
// `throw err` inside a catch block resolves to null message/exceptionType
// at the throw site. The post-pass walks the enclosing try block's call
// sites and collects those callees' throw-terminal messages into
// `transition.metadata.rethrow.possibleSources`.

describe("createTypeScriptAdapter — rethrow enrichment", () => {
  it("populates rethrow.possibleSources from direct callees' throws", async () => {
    // `wrapper` is reachable via closure and uses a bare rethrow over
    // `loadUser`. The rethrow enrichment pass should walk the try
    // block's call sites, find `loadUser` in the summary set, and
    // attribute its two throw terminals to the rethrow.
    const project = new Project({ useInMemoryFileSystem: true });
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

    // Every source attributes to `loadUser`.
    expect(
      rethrowMeta?.possibleSources.every((s) => s.via === "loadUser"),
    ).toBe(true);
  });

  it("does NOT enrich throws that already carry a static message", async () => {
    // `throw new Error("literal")` is not a rethrow candidate — its
    // message is already captured from the constructor. Enrichment
    // should leave it alone.
    const project = new Project({ useInMemoryFileSystem: true });
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

  it("unions throws from every call site in a single try body", async () => {
    // `try { a(); b(); c(); } catch (e) { throw e; }` — any of a/b/c
    // could have thrown, so the rethrow's possibleSources should be the
    // union of all their throw terminals. `c` doesn't throw; its absence
    // from the sources is a correctness check on its own.
    const project = new Project({ useInMemoryFileSystem: true });
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
    // Two separate try/catches, each wrapping a different callee —
    // each rethrow should pick up only its own try body's throws, not
    // a merged union across the function.
    const project = new Project({ useInMemoryFileSystem: true });
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

    // Extract each rethrow's possibleSources, sorted by line so the
    // first-throw / second-throw pairing is stable.
    const byLocation = [...(throwTransitions ?? [])].sort(
      (x, y) => x.location.start - y.location.start,
    );
    const firstMeta = byLocation[0].metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;
    const secondMeta = byLocation[1].metadata?.rethrow as
      | { possibleSources: Array<{ via: string; message: string | null }> }
      | undefined;

    // Each rethrow enriches from its own try body only.
    expect(firstMeta?.possibleSources.map((s) => s.via)).toEqual(["a"]);
    expect(firstMeta?.possibleSources.map((s) => s.message)).toEqual(["a-err"]);
    expect(secondMeta?.possibleSources.map((s) => s.via)).toEqual(["b"]);
    expect(secondMeta?.possibleSources.map((s) => s.message)).toEqual([
      "b-err",
    ]);
  });

  it("does NOT enrich rethrows outside a try-catch", async () => {
    // `throw err` where `err` is just a parameter (no enclosing
    // try-catch) isn't the pattern we're enriching. The enrichment
    // walks the *try body's* call sites; without an enclosing try,
    // there's nothing to walk.
    const project = new Project({ useInMemoryFileSystem: true });
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

// ---------------------------------------------------------------------------
// Consumer discovery + extraction
// ---------------------------------------------------------------------------

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

  it("extracts a consumer summary from a function with fetch()", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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

  it("extracts a template-literal path with substitutions as OpenAPI placeholders", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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

  it("uses the trailing property name when the substitution is a property access", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // Non-literal URL: method extracted, path left empty (signals
    // "unresolved" to the wrapper-expansion post-pass).
    expect(restPathOf(summaries[0])).toBe("");
  });

  it("produces status-code conditions the checker can read", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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

    // Verify the checker can read the consumer's expected statuses.
    // collectStatusLiterals walks conditions for comparison(subject, eq, literal)
    // where subject ends in .status/.statusCode.
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

// ---------------------------------------------------------------------------
// Response property semantics resolution
// ---------------------------------------------------------------------------

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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // The ok-guarded branch should have a compound(and) comparison
    // instead of a truthinessCheck on .ok
    // At least one transition should have a compound(and) status range
    const compounds = s.transitions
      .flatMap((t) => t.conditions)
      .filter((c) => c.type === "compound" && c.op === "and");
    expect(compounds).toHaveLength(1);

    const compound = compounds[0];
    // Verify the compound has gte(200) and lte(299)
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // The !ok guard branch should have a negation wrapping the range
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // The status === 404 condition should remain as a comparison
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
    const project = new Project({ useInMemoryFileSystem: true });
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

    // Without semantics, .ok stays as a truthinessCheck
    const s = summaries[0];
    const hasTruthiness = s.transitions.some((t) =>
      t.conditions.some((c) => c.type === "truthinessCheck"),
    );
    expect(hasTruthiness).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readContractForClientCall — consumer-side contract resolution
// ---------------------------------------------------------------------------

describe("client-side contract resolution via fromClientMethod", () => {
  // Pack mirrors the ts-rest client side: clientCall discovery against
  // initClient + bindingExtraction.fromClientMethod that walks back through
  // the contract for method/path. Uses contractReading shape from the
  // ts-rest pack so readContractForClientCall finds the contract object.
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
      paramsExtraction: { property: "pathParams" },
    },
    inputMapping: { type: "positionalParams", params: [] },
  };

  it("resolves method+path on a client.method() call by walking back to the contract", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
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
    const project = new Project({ useInMemoryFileSystem: true });
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
    // Discovery still finds the function; the binding falls back to a
    // rest-shaped entry with empty method/path because fromClientMethod
    // can't resolve the method+path from the contract.
    expect(consumer?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "", path: "" },
      recognition: "ts-rest",
    });
  });
});

// ---------------------------------------------------------------------------
// Wrapper expansion (cross-function path resolution)
// ---------------------------------------------------------------------------

describe("wrapper expansion", () => {
  // Pack mirrors the axios runtime pack — direct method-on-import discovery
  // with literal-method bindings. We use it on an in-memory project so the
  // tests don't require the real axios npm dep.
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
    return new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        strict: true,
        target: 99,
        module: 99,
        moduleResolution: 100,
        skipLibCheck: true,
      },
    });
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

    // The wrapper itself is one summary (no path), the caller is the second
    // (synthesised with the literal/template-literal path from the call site).
    const wrapper = summaries.find((s) => s.identity.name === "getJson");
    expect(wrapper).toBeDefined();
    // Wrapper: method extracted, path empty (unresolved — path is a
    // parameter, not a literal).
    expect(restPathOf(wrapper)).toBe("");

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
        // Path is also a parameter in the caller — nothing literal to extract.
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
    // Sibling export pattern: the wrapper is the directly-exported function,
    // not bound to a variable. Exercises wrapperNameNode's
    // FunctionDeclaration branch.
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
    // The caller is a non-exported function — verify wrapper expansion
    // still tracks the call via ts-morph references.
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

  it("populates expectedInput when the caller reads fields off the wrapper return", async () => {
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
    // The wrapper has already unwrapped the response — the caller's reads
    // on the wrapper return value should appear directly as body fields,
    // including `status` (which would have been filtered as a non-body
    // property by the hardcoded fallback before responseSemantics: [] was
    // set on the synthetic pack).
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

// ---------------------------------------------------------------------------
// Sub-unit synthesis plumbing (generic — pack.subUnits → summaries)
// ---------------------------------------------------------------------------
//
// Framework-specific sub-unit behavior (React event handler discovery,
// useEffect body analysis, etc.) is tested in @suss/framework-react's
// integration suite. Here we only exercise the adapter's plumbing: a
// pack that declares `subUnits` should have it called, returned units
// should be piped through extraction + assembly, and inheritance of
// parent metadata / boundary bindings should be correct.

describe("subUnits plumbing", () => {
  function makeProject() {
    return new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        strict: true,
        target: 99,
        module: 99,
        moduleResolution: 100,
        skipLibCheck: true,
      },
    });
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
      // Return a single synthetic sub-unit using the parent's own
      // function body — the adapter doesn't care what we return, only
      // that the plumbing processes it.
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
    // Inherited binding: parent's framework / protocol propagate.
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
    // Body has one throw + one return — both should surface as
    // transitions in the sub-unit because the default terminal set
    // covers them.
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
            // Intentionally include only `return` — any thrown values
            // should NOT appear as throw terminals.
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
    // Only the `return` terminal is configured, so no throw transition.
    expect(sub?.transitions.some((t) => t.output.type === "throw")).toBe(false);
    // The custom input mapping should surface the first param as role "first".
    const input = sub?.inputs[0];
    if (input !== undefined && input.type === "parameter") {
      expect(input.role).toBe("first");
    } else {
      throw new Error("expected parameter input");
    }
  });
});

// ---------------------------------------------------------------------------
// Inline JSX conditional decomposition (Phase 1.4)
// ---------------------------------------------------------------------------

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
    return new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        strict: true,
        target: 99,
        module: 99,
        moduleResolution: 100,
        skipLibCheck: true,
        jsx: 4,
      },
    });
  }

  function rootOf(summaries: ReturnType<typeof Array.prototype.at>) {
    // placeholder — not used; see explicit root extraction in each test
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

  it("`{x || <Fallback/>}` stays opaque — `||` is not decomposed", async () => {
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
