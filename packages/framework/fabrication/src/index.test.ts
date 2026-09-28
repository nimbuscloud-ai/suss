import { describe, expect, it } from "vitest";

import { declares, fabricationFramework, optionsSchema } from "./index.js";

describe("fabricationFramework", () => {
  it("discovers nothing and says what Fabrication builds with", () => {
    const pack = fabricationFramework();
    expect(pack.discovery).toEqual([]);
    expect(pack.factories?.[0]?.definitionMethods).toEqual(["Fabricator"]);
    expect(pack.factories?.[0]?.parentKeywords).toEqual(["from"]);
    expect(pack.factories?.[0]?.builders).toContainEqual({
      method: "Fabricate",
    });
  });

  it("takes no options, and suggests itself to no project", () => {
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ files: [] }).success).toBe(false);
    expect(declares.dependencies).toEqual([]);
  });
});
