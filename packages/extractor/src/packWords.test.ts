import { describe, expect, it } from "vitest";

import { pooledWords } from "./framework.js";

describe("pooledWords", () => {
  it("lists every pack's words of each kind, in the order the packs are listed", () => {
    const pooled = pooledWords([
      {
        words: {
          givesBackOne: [{ base: "Model", method: "first" }],
          givesBackOneOfImport: [
            { module: "orm", name: "select", argument: 0 },
          ],
        },
      },
      {},
      {
        words: {
          givesBackOne: [{ base: "Record", method: "find" }],
          givesBackOneOfArgument: [
            { base: "Model", method: "get", argument: 0 },
          ],
        },
      },
    ]);

    expect(pooled).toEqual({
      givesBackOne: [
        { base: "Model", method: "first" },
        { base: "Record", method: "find" },
      ],
      givesBackOneOfArgument: [{ base: "Model", method: "get", argument: 0 }],
      givesBackOneOfImport: [{ module: "orm", name: "select", argument: 0 }],
    });
  });
});
