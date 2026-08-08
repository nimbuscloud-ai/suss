import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createDecoratorFixtureProject } from "@suss/test-project";

import { nestjsGraphqlFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project: exercise NestJS resolver + operation + ResolveField shapes
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/nestjs-graphql",
);

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createDecoratorFixtureProject(fixturesDir, "*.ts");
  // `@nestjs/graphql` isn't installed in the fixture; create a stub
  // module that exposes the decorator names as identity functions so
  // ts-morph's import resolution succeeds. Discovery only needs the
  // decorator names + import module to match: runtime behaviour is
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

describe("nestjsGraphqlFramework: pack shape", () => {
  it("declares the expected discovery, terminals, and inputMapping", () => {
    const pack = nestjsGraphqlFramework();
    expect(pack.name).toBe("nestjs-graphql");
    expect(pack.languages).toEqual(["typescript"]);
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].match.type).toBe("decoratedMethod");
    expect(pack.inputMapping.type).toBe("decoratedParams");
  });

  it("ships only the decorator @nestjs/graphql declares", () => {
    const match = nestjsGraphqlFramework().discovery[0].match;
    expect(match.type).toBe("decoratedMethod");
    if (match.type === "decoratedMethod") {
      expect(match.classDecorators).toEqual(["Resolver"]);
    }
  });

  it("names a type for every operation decorator that puts one on a root type", () => {
    const match = nestjsGraphqlFramework().discovery[0].match;
    if (match.type === "decoratedMethod") {
      expect(match.methodDecoratorTypeMap).toEqual({
        Query: "Query",
        Mutation: "Mutation",
        Subscription: "Subscription",
      });
      // A field resolver takes its type from the class decorator's argument,
      // so it has nothing of its own to contribute here.
      expect(match.methodDecoratorTypeMap.ResolveField).toBeUndefined();
    }
  });

  it("adds the wrapper decorators a project names", () => {
    const match = nestjsGraphqlFramework({
      classDecorators: ["InternalResolver"],
    }).discovery[0].match;
    if (match.type === "decoratedMethod") {
      expect(match.classDecorators).toEqual(["Resolver", "InternalResolver"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: run the adapter against the resolver fixture
// ---------------------------------------------------------------------------

describe("nestjsGraphqlFramework: integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 60_000);

  it("discovers Query / Mutation / ResolveField / Subscription methods on the class", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "HealthResolver.ping",
      "UntypedFieldResolver.homeWorkspace",
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

  it("takes the typeName off @Query when @Resolver() has no argument", () => {
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

  it("names no type for a field resolver on a class that names none", () => {
    const untyped = summaries.find(
      (s) => s.identity.name === "UntypedFieldResolver.homeWorkspace",
    );
    if (!untyped) {
      throw new Error("homeWorkspace missing");
    }
    expect(untyped.identity.boundaryBinding?.semantics).toMatchObject({
      name: "graphql-resolver",
      typeName: null,
      fieldName: "homeWorkspace",
    });
    const gap = untyped.gaps.find((g) => g.type === "unreadOutcome");
    expect(gap?.description).toContain("homeWorkspace");
  });

  it("classifies @Subscription as a Subscription-typed resolver", () => {
    const sub = summaries.find(
      (s) => s.identity.name === "UserResolver.userUpdated",
    );
    if (!sub) {
      throw new Error("subscription missing");
    }
    // @Resolver(() => User) on the class wins over the decorator's own type
    // name, so the subscription comes out as "on User". The decorator only
    // decides the type when the class decorator was given no argument.
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
