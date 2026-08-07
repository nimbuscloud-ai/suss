import { describe, expect, it } from "vitest";

import { graphqlRubyFramework } from "./index.js";

describe("graphqlRubyFramework", () => {
  it("accepts graphql-ruby's own generated base object class by default", () => {
    const pack = graphqlRubyFramework({ root: "/repo/app/graphql" });
    expect(pack.name).toBe("graphql-ruby");
    expect(pack.protocol).toBe("http-graphql");
    expect(pack.discovery).toEqual([
      {
        type: "graphqlObjectFields",
        baseClassNames: ["Types::BaseObject"],
        root: "/repo/app/graphql",
        camelize: true,
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
    expect(pattern?.type === "graphqlObjectFields" && pattern.camelize).toBe(
      false,
    );
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(graphqlRubyFramework);
  });
});
