import { describe, expect, it } from "vitest";

import { commonDirectoryOf } from "./projectRoot.js";

describe("commonDirectoryOf", () => {
  it("gives the deepest directory containing every file", () => {
    expect(
      commonDirectoryOf(["/a/b/src/x.ts", "/a/b/src/nested/y.ts", "/a/b/z.ts"]),
    ).toBe("/a/b");
  });

  it("gives nothing when the paths share only the filesystem root", () => {
    expect(commonDirectoryOf(["/a/x.ts", "/b/y.ts"])).toBeUndefined();
  });

  it("ignores the in-memory paths a virtual project uses", () => {
    expect(commonDirectoryOf(["x.ts", "y.ts"])).toBeUndefined();
  });
});
