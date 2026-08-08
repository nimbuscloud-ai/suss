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

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(graphqlRubyFramework);
  });
});
