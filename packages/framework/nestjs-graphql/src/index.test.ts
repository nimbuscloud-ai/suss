import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { nestjsGraphqlFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — exercise NestJS resolver + operation + ResolveField shapes
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/nestjs-graphql",
);

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
    },
  });
  // `@nestjs/graphql` isn't installed in the fixture; create a stub
  // module that exposes the decorator names as identity functions so
  // ts-morph's import resolution succeeds. Discovery only needs the
  // decorator names + import module to match — runtime behaviour is
  // irrelevant to static analysis.
  project.createSourceFile(
    "node_modules/@nestjs/graphql/index.d.ts",
    `export const Resolver: (...args: unknown[]) => ClassDecorator;
     export const Query: (...args: unknown[]) => MethodDecorator;
     export const Mutation: (...args: unknown[]) => MethodDecorator;
     export const ResolveField: (...args: unknown[]) => MethodDecorator;
     export const Subscription: (...args: unknown[]) => MethodDecorator;
     export const Args: (...args: unknown[]) => ParameterDecorator;
     export const Parent: (...args: unknown[]) => ParameterDecorator;
     export const Context: (...args: unknown[]) => ParameterDecorator;
     export const Info: (...args: unknown[]) => ParameterDecorator;`,
  );
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [nestjsGraphqlFramework()],
    includeReachable: false,
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack-shape sanity
// ---------------------------------------------------------------------------

describe("nestjsGraphqlFramework — pack shape", () => {
  it("declares the expected discovery, terminals, and inputMapping", () => {
    const pack = nestjsGraphqlFramework();
    expect(pack.name).toBe("nestjs-graphql");
    expect(pack.languages).toEqual(["typescript"]);
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].match.type).toBe("decoratedMethod");
    expect(pack.inputMapping.type).toBe("decoratedParams");
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the resolver fixture
// ---------------------------------------------------------------------------

describe("nestjsGraphqlFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 60_000);

  it("discovers Query / Mutation / ResolveField / Subscription methods on the class", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "HealthResolver.ping",
      "UserResolver.createUser",
      "UserResolver.findUser",
      "UserResolver.userUpdated",
      "UserResolver.workspace",
    ]);
    for (const s of summaries) {
      expect(s.kind).toBe("resolver");
      expect(s.identity.boundaryBinding?.recognition).toBe("nestjs-graphql");
    }
  });

  it("maps `@Resolver(() => User)` to a User-typed graphql-resolver binding", () => {
    const findUser = summaries.find(
      (s) => s.identity.name === "UserResolver.findUser",
    );
    expect(findUser).toBeDefined();
    if (!findUser) {
      throw new Error("findUser missing");
    }
    expect(findUser.identity.boundaryBinding?.semantics).toMatchObject({
      name: "graphql-resolver",
      typeName: "User",
      fieldName: "findUser",
    });
  });

  it("honours the `{ name }` override on the method decorator", () => {
    const create = summaries.find(
      (s) => s.identity.name === "UserResolver.createUser",
    );
    if (!create) {
      throw new Error("createUser missing");
    }
    expect(create.identity.boundaryBinding?.semantics).toMatchObject({
      name: "graphql-resolver",
      typeName: "User",
      fieldName: "createUserCustom",
    });
  });

  it("falls back to the operation kind as typeName when @Resolver() has no argument", () => {
    const ping = summaries.find(
      (s) => s.identity.name === "HealthResolver.ping",
    );
    if (!ping) {
      throw new Error("ping missing");
    }
    expect(ping.identity.boundaryBinding?.semantics).toMatchObject({
      name: "graphql-resolver",
      typeName: "Query",
      fieldName: "ping",
    });
  });

  it("classifies @Subscription as a Subscription-typed resolver", () => {
    const sub = summaries.find(
      (s) => s.identity.name === "UserResolver.userUpdated",
    );
    if (!sub) {
      throw new Error("subscription missing");
    }
    // @Resolver(() => User) on the class wins over the method-kind
    // default — the subscription is "on User" semantically. The
    // operation-kind fallback only kicks in for the no-argument
    // @Resolver() case.
    expect(sub.identity.boundaryBinding?.semantics).toMatchObject({
      name: "graphql-resolver",
      typeName: "User",
      fieldName: "userUpdated",
    });
  });

  it("maps @Args / @Parent / @Context / @Info to framework roles", () => {
    const findUser = summaries.find(
      (s) => s.identity.name === "UserResolver.findUser",
    );
    if (!findUser) {
      throw new Error("findUser missing");
    }
    const roles = findUser.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(roles).toEqual(["args", "context"]);

    const workspace = summaries.find(
      (s) => s.identity.name === "UserResolver.workspace",
    );
    if (!workspace) {
      throw new Error("workspace missing");
    }
    const wsRoles = workspace.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(wsRoles).toEqual(["parent"]);
  });
});
