import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createPerFileCache } from "./perFileCache.js";

describe("createPerFileCache", () => {
  it("answers the same parse with what it was told", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("src/a.ts", "const x = 1;\n");
    const cache = createPerFileCache<string>();
    cache.set(sf, "first");
    expect(cache.get(sf)).toBe("first");
  });

  it("forgets what it was told once the file is parsed again", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const before = project.createSourceFile("src/a.ts", "const x = 1;\n", {
      overwrite: true,
    });
    const cache = createPerFileCache<string>();
    cache.set(before, "first");
    const after = project.createSourceFile("src/a.ts", "const x = 2;\n", {
      overwrite: true,
    });
    // The wrapper survives a re-parse and the nodes under it do not, so
    // an answer that outlived the parse would be made of forgotten nodes.
    expect(after).toBe(before);
    expect(cache.get(after)).toBeUndefined();
  });
});
