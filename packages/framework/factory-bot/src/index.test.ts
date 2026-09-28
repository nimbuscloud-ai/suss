import { describe, expect, it } from "vitest";

import { declares, factoryBotFramework, optionsSchema } from "./index.js";

describe("factoryBotFramework", () => {
  it("discovers nothing and says what factory_bot builds with", () => {
    const pack = factoryBotFramework();
    expect(pack.discovery).toEqual([]);
    expect(pack.factories?.[0]?.definitionMethods).toEqual(["factory"]);
    expect(pack.factories?.[0]?.builders).toContainEqual({
      method: "create",
      receiver: "FactoryBot",
    });
    expect(pack.factories?.[0]?.nestedDefinitionsInherit).toBe(true);
  });

  it("takes no options, and suggests itself to no project", () => {
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ files: [] }).success).toBe(false);
    expect(declares.dependencies).toEqual([]);
  });
});
