import { describe, expect, it } from "vitest";

import { commonDirectoryOf, runRootOf } from "./projectRoot.js";

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

describe("runRootOf", () => {
  it("is the project root when the run has one", () => {
    expect(
      runRootOf({
        projectRoot: "/repo",
        workspaceRoot: "/repo/apps",
        files: ["/repo/apps/a.py"],
      }),
    ).toBe("/repo");
  });

  it("is the workspace root when the run has no project root", () => {
    expect(
      runRootOf({ workspaceRoot: "/repo/apps", files: ["/repo/apps/a.py"] }),
    ).toBe("/repo/apps");
  });

  it("is the directory the walked files share when the run was given neither", () => {
    expect(runRootOf({ files: ["/repo/src/a.rb", "/repo/lib/b.rb"] })).toBe(
      "/repo",
    );
  });

  it("is the working directory when the files share no absolute root", () => {
    expect(runRootOf({ files: ["a.rb"] })).toBe(".");
  });
});
