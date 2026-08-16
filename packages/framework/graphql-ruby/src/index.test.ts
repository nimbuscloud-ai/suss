import { describe, expect, it } from "vitest";

import { graphqlRubyFramework } from "./index.js";

describe("graphqlRubyFramework", () => {
  it("states graphql-ruby's whole vocabulary on the pattern", () => {
    const pack = graphqlRubyFramework({ root: "/repo/app/graphql" });
    expect(pack.name).toBe("graphql-ruby");
    expect(pack.protocol).toBe("http-graphql");
    expect(pack.discovery).toEqual([
      {
        type: "graphqlObjectFields",
        baseClassNames: [
          "Types::BaseObject",
          "Types::BaseInterface",
          "Types::BaseInputObject",
          "Types::BaseEnum",
          "Types::BaseUnion",
          "Types::BaseScalar",
        ],
        root: "/repo/app/graphql",
        pathConvention: "railsUnderscore",
        fieldCallName: "field",
        typeCallName: "type",
        argumentCallName: "argument",
        wiringKeywords: ["mutation", "resolver"],
        resolverMethodName: "resolve",
        ancestryRootClassNames: [
          "GraphQL::Schema::Object",
          "GraphQL::Schema::Mutation",
          "GraphQL::Schema::Resolver",
          "GraphQL::Schema::Interface",
          "GraphQL::Schema::InputObject",
          "GraphQL::Schema::Enum",
          "GraphQL::Schema::Union",
          "GraphQL::Schema::Scalar",
        ],
        requiredKeyword: "required",
        requiredDefault: true,
        camelizeKeyword: "camelize",
        camelizeDefault: true,
        scalars: {
          String: { type: "text" },
          ID: { type: "text" },
          Int: { type: "number" },
          Float: { type: "number" },
          Boolean: { type: "boolean" },
          Integer: { type: "number" },
        },
        scalarNamePrefixes: ["GraphQL::Types::"],
        typeNameConvention: "stripTypeSuffix",
        argumentWrapping: {
          ancestorClassName: "GraphQL::Schema::RelayClassicMutation",
          argumentName: "input",
          extraFields: {
            clientMutationId: { type: { type: "text" }, required: false },
          },
        },
      },
    ]);
  });

  it("adds a project's own base class names alongside the defaults", () => {
    const pack = graphqlRubyFramework({
      root: "/repo/app/graphql",
      baseClassNames: ["Types::AuthenticatedObject"],
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("graphqlObjectFields");
    const names =
      pattern?.type === "graphqlObjectFields" ? pattern.baseClassNames : [];
    expect(names).toContain("Types::BaseObject");
    expect(names).toContain("Types::BaseInterface");
    expect(names).toContain("Types::AuthenticatedObject");
  });

  it("carries a project's camelize: false schema-wide default through to the pattern", () => {
    const pack = graphqlRubyFramework({
      root: "/repo/app/graphql",
      camelize: false,
    });
    const [pattern] = pack.discovery;
    expect(
      pattern?.type === "graphqlObjectFields" && pattern.camelizeDefault,
    ).toBe(false);
  });

  it("refuses to build without a root, and says what a root is", () => {
    const withoutOptions = graphqlRubyFramework as unknown as () => unknown;
    expect(() => withoutOptions()).toThrow(/needs `root`/);
    expect(() => graphqlRubyFramework({ root: "" })).toThrow(/app\/graphql/);
  });

  it("reads a relative root from the file it was written in", () => {
    const pack = graphqlRubyFramework({
      root: "app/graphql",
      configDirectory: "/repo",
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type === "graphqlObjectFields" && pattern.root).toBe(
      "/repo/app/graphql",
    );
  });

  it("leaves an absolute root alone, wherever the file sits", () => {
    const pack = graphqlRubyFramework({
      root: "/srv/app/graphql",
      configDirectory: "/repo",
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type === "graphqlObjectFields" && pattern.root).toBe(
      "/srv/app/graphql",
    );
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(graphqlRubyFramework);
  });
});
