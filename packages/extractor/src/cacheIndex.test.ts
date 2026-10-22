import { describe, expect, it } from "vitest";

import { entriesByShard, indexOf } from "./cacheIndex.js";

describe("indexOf", () => {
  it("indexes a call spelled like a method every object has", () => {
    const index = indexOf([
      {
        file: "src/format.ts",
        id: "a",
        entries: {
          boundaries: [["constructor", 0, "provider"]],
          callees: [
            ["toString", 0],
            ["hasOwnProperty", 1],
          ],
        },
      },
    ]);

    expect(index.callees.toString).toEqual([[0, 0]]);
    expect(index.callees.hasOwnProperty).toEqual([[0, 1]]);
    expect(index.boundaries.constructor).toEqual([[0, 0, "provider"]]);
    expect(entriesByShard(index).get("a")).toEqual({
      boundaries: [["constructor", 0, "provider"]],
      callees: [
        ["toString", 0],
        ["hasOwnProperty", 1],
      ],
    });
  });
});
