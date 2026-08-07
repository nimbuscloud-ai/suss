import { describe, expect, it } from "vitest";

import { parseRuby } from "./parser.js";

describe("parseRuby", () => {
  it("parses a file into a tree rooted at 'program'", async () => {
    const tree = await parseRuby("x = 1\n");
    expect(tree.rootNode.type).toBe("program");
  });

  it("is error-tolerant: invalid syntax still produces a tree", async () => {
    const tree = await parseRuby("def f(\n");
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.hasError).toBe(true);
  });

  it("reuses the same compiled grammar across calls", async () => {
    const [a, b] = await Promise.all([
      parseRuby("a = 1\n"),
      parseRuby("b = 2\n"),
    ]);
    expect(a.rootNode.text).toBe("a = 1\n");
    expect(b.rootNode.text).toBe("b = 2\n");
  });
});
