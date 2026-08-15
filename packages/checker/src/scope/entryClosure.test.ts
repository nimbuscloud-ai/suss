import { describe, expect, it } from "vitest";

import { entryClosure, type ModuleGraph } from "./entryClosure.js";

const graph: ModuleGraph = new Map([
  ["src/a.ts", ["src/shared.ts"]],
  ["src/shared.ts", ["src/deep.ts"]],
  ["src/deep.ts", []],
  ["src/b.ts", []],
]);

describe("entryClosure", () => {
  it("reaches transitively from the extensionless entry", () => {
    expect(entryClosure("src/a", graph)).toEqual(
      new Set(["src/a.ts", "src/shared.ts", "src/deep.ts"]),
    );
  });

  it("returns null when no file matches the entry", () => {
    expect(entryClosure("src/missing", graph)).toBeNull();
  });
});
