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
        baseClassNames: ["Types::BaseObject"],
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
      },
    ]);
  });

  it("adds a project's own base class names alongside the default", () => {
    const pack = graphqlRubyFramework({
      root: "/repo/app/graphql",
      baseClassNames: ["Types::AuthenticatedObject"],
    });
    const [pattern] = pack.discovery;
    expect(pattern?.type).toBe("graphqlObjectFields");
    expect(
      pattern?.type === "graphqlObjectFields" && pattern.baseClassNames,
    ).toEqual(["Types::BaseObject", "Types::AuthenticatedObject"]);
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
    // A caller with no types in front of it (the CLI, holding a config
    // somebody wrote by hand) can arrive with nothing. Reading half a
    // schema and saying nothing would be worse than refusing.
    const withoutOptions = graphqlRubyFramework as unknown as () => unknown;
    expect(() => withoutOptions()).toThrow(/needs `root`/);
    expect(() => graphqlRubyFramework({ root: "" })).toThrow(/app\/graphql/);
  });

  it("reads a relative root from the file it was written in", () => {
    // A root written in a config file is written relative to that
    // file. Reading it relative to whatever directory the command runs
    // from means the same config finds the classes from one place and
    // nothing from anywhere else, and finding nothing looks exactly
    // like a schema whose fields are all unwired.
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
