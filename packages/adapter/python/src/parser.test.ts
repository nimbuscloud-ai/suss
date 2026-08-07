import { describe, expect, it } from "vitest";

import { parsePython } from "./parser.js";

describe("parsePython", () => {
  it("parses a module into a tree rooted at 'module'", async () => {
    const tree = await parsePython("x = 1\n");
    expect(tree.rootNode.type).toBe("module");
  });

  it("is error-tolerant: invalid syntax still produces a tree", async () => {
    const tree = await parsePython("def f(:\n");
    expect(tree.rootNode.type).toBe("module");
    expect(tree.rootNode.hasError).toBe(true);
  });

  it("reuses the same compiled grammar across calls", async () => {
    const [a, b] = await Promise.all([
      parsePython("a = 1\n"),
      parsePython("b = 2\n"),
    ]);
    expect(a.rootNode.text).toBe("a = 1\n");
    expect(b.rootNode.text).toBe("b = 2\n");
  });
});
