import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { apolloFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — loads fixtures/apollo/*.ts into an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/apollo");

async function runAdapter(): Promise<BehavioralSummary[]> {
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
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloFramework()],
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack-shape sanity
// ---------------------------------------------------------------------------

describe("apolloFramework — pack shape", () => {
  const pack = apolloFramework();

  it("declares the apollo identity on http transport", async () => {
    expect(pack.name).toBe("apollo");
    expect(pack.protocol).toBe("http");
  });

  it("has one resolverMap discovery pattern per Apollo import path", async () => {
    const modules = pack.discovery
      .map((d) =>
        d.match.type === "resolverMap" ? d.match.importModule : null,
      )
      .filter((m): m is string => m !== null)
      .sort();
    expect(modules).toEqual([
      "@apollo/server",
      "apollo-server",
      "apollo-server-express",
    ]);
  });

  it("names the canonical (parent, args, context, info) positional roles", async () => {
    if (pack.inputMapping.type !== "positionalParams") {
      throw new Error("expected positionalParams");
    }
    expect(pack.inputMapping.params.map((p) => p.role)).toEqual([
      "parent",
      "args",
      "context",
      "info",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the fixture
// ---------------------------------------------------------------------------

describe("apolloFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers one resolver summary per (typeName, fieldName) pair", async () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "Mutation.createUser",
      "Query.user",
      "Query.users",
      "User.fullName",
    ]);
    for (const s of summaries) {
      expect(s.kind).toBe("resolver");
    }
  });

  it("binds each resolver via graphql-resolver semantics", async () => {
    const userQuery = summaries.find((s) => s.identity.name === "Query.user");
    expect(userQuery).toBeDefined();
    expect(userQuery?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-resolver",
        typeName: "Query",
        fieldName: "user",
      },
      recognition: "apollo",
    });
  });

  it("captures (parent, args, context, info) positional inputs by role", async () => {
    const userQuery = summaries.find((s) => s.identity.name === "Query.user");
    expect(userQuery).toBeDefined();
    const roles = userQuery?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    // Only 3 params declared in the fixture — `info` is not present.
    expect(roles).toEqual(["parent", "args", "context"]);
  });

  it("Query.user branches on args.id — one throw transition, one return", async () => {
    const userQuery = summaries.find((s) => s.identity.name === "Query.user");
    expect(userQuery).toBeDefined();
    const outputs = userQuery?.transitions.map((t) => t.output.type);
    expect(outputs).toContain("throw");
    expect(outputs).toContain("return");
  });

  it("discovers Mutation.createUser via method-shorthand property", async () => {
    const createUser = summaries.find(
      (s) => s.identity.name === "Mutation.createUser",
    );
    expect(createUser).toBeDefined();
    expect(createUser?.kind).toBe("resolver");
    // Throws on unauthenticated; returns a User otherwise.
    const outputs = createUser?.transitions.map((t) => t.output.type) ?? [];
    expect(outputs).toContain("throw");
    expect(outputs).toContain("return");
  });

  it("discovers type-level resolvers (User.fullName), not just Query/Mutation", async () => {
    const fullName = summaries.find((s) => s.identity.name === "User.fullName");
    expect(fullName).toBeDefined();
    expect(fullName?.identity.boundaryBinding).toEqual({
      transport: "http",
      semantics: {
        name: "graphql-resolver",
        typeName: "User",
        fieldName: "fullName",
      },
      recognition: "apollo",
    });
  });
});

// ---------------------------------------------------------------------------
// In-memory edge cases — exercise discovery branches without relying on
// a full fixture file.
// ---------------------------------------------------------------------------

async function runInMemory(source: string): Promise<BehavioralSummary[]> {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99,
      module: 99,
      moduleResolution: 100,
      skipLibCheck: true,
    },
  });
  project.createSourceFile("server.ts", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [apolloFramework()],
  });
  return await adapter.extractAll();
}

describe("apolloFramework — discovery shapes", () => {
  it("inline resolvers: `new ApolloServer({ resolvers: { Query: {...} } })`", async () => {
    const summaries = await runInMemory(`
      import { ApolloServer } from "@apollo/server";
      const server = new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query: {
            ping: () => "pong",
          },
        },
      });
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
  });

  it("satisfies-wrapped resolvers const still resolves", async () => {
    const summaries = await runInMemory(`
      import { ApolloServer } from "@apollo/server";
      type Resolvers = Record<string, Record<string, (...a: unknown[]) => unknown>>;
      const resolvers = {
        Query: { ping: () => "pong" },
      } satisfies Resolvers;
      const server = new ApolloServer({ typeDefs: "", resolvers });
    `);
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
  });

  it("excludeTypes skips the listed types", async () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        strict: true,
        target: 99,
        module: 99,
        moduleResolution: 100,
        skipLibCheck: true,
      },
    });
    project.createSourceFile(
      "server.ts",
      `
      import { ApolloServer } from "@apollo/server";
      const server = new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query: { ping: () => "pong" },
          Subscription: { onTick: () => "tick" },
        },
      });
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [
        {
          ...apolloFramework(),
          discovery: [
            {
              kind: "resolver",
              match: {
                type: "resolverMap",
                importModule: "@apollo/server",
                importName: "ApolloServer",
                mapProperty: "resolvers",
                excludeTypes: ["Subscription"],
              },
            },
          ],
        },
      ],
    });
    const names = (await adapter.extractAll()).map((s) => s.identity.name);
    expect(names).toEqual(["Query.ping"]);
  });

  it("emits nothing when the ApolloServer import isn't present", async () => {
    const summaries = await runInMemory(`
      export const nothing = 1;
    `);
    expect(summaries).toEqual([]);
  });

  it("emits nothing when resolvers isn't an object literal (dynamically merged)", async () => {
    const summaries = await runInMemory(`
      import { ApolloServer } from "@apollo/server";
      declare const mergedResolvers: any;
      const server = new ApolloServer({ typeDefs: "", resolvers: mergedResolvers });
    `);
    expect(summaries).toEqual([]);
  });

  it("emits nothing when the constructor arg isn't an object literal", async () => {
    const summaries = await runInMemory(`
      import { ApolloServer } from "@apollo/server";
      declare const config: any;
      const server = new ApolloServer(config);
    `);
    expect(summaries).toEqual([]);
  });

  it("skips top-level type-maps whose inner values aren't functions", async () => {
    const summaries = await runInMemory(`
      import { ApolloServer } from "@apollo/server";
      const server = new ApolloServer({
        typeDefs: "",
        resolvers: {
          Query: { ping: () => "pong" },
          __resolveType: (obj: any) => obj.kind,   // bare fn under the top-level
          Scalar: "NOT_AN_OBJECT" as any,           // non-object inner value
        },
      });
    `);
    // Only `Query.ping` should come through: the top-level `__resolveType`
    // isn't a type-map, and `Scalar` isn't an object literal.
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
  });
});
