import { describe, expect, it } from "vitest";

import {
  fileReference,
  referencedFile,
  referencedFileKey,
} from "./summaryId.js";

describe("a path one summary records for another file", () => {
  it("puts the other project's name in front, and reads it back", () => {
    const written = fileReference("@acme/shared", "src/routes.ts");

    expect(written).toBe("@acme/shared::src/routes.ts");
    expect(referencedFile("@acme/api", written)).toEqual({
      workspace: "@acme/shared",
      file: "src/routes.ts",
    });
  });

  it("reads a plain path as a file in the recording summary's own project", () => {
    expect(referencedFile("@acme/api", "src/a.ts")).toEqual({
      workspace: "@acme/api",
      file: "src/a.ts",
    });
    expect(referencedFileKey("@acme/api", "src/a.ts")).toBe(
      "@acme/api::src/a.ts",
    );
  });

  it("writes a path in a project with no name plain, so it keys as itself", () => {
    expect(fileReference(undefined, "src/a.ts")).toBe("src/a.ts");
    expect(fileReference("", "src/a.ts")).toBe("src/a.ts");
    expect(referencedFileKey(undefined, "src/a.ts")).toBe("src/a.ts");
    expect(referencedFile(undefined, "::src/a.ts")).toEqual({
      workspace: undefined,
      file: "src/a.ts",
    });
  });
});
