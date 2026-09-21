import { Project } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

import { createSourceFileLookup, sourceFileFor } from "./sourceFileLookup.js";

function projectWith(files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, text] of Object.entries(files)) {
    project.createSourceFile(name, text);
  }
  return project;
}

describe("createSourceFileLookup", () => {
  it("finds a file by its absolute path and by a suffix of it", () => {
    const project = projectWith({ "src/a.ts": "export const x = 1;\n" });
    const lookup = createSourceFileLookup(project);
    expect(lookup.byPath("/src/a.ts")?.getBaseName()).toBe("a.ts");
    expect(lookup.bySuffix("src/a.ts")?.getBaseName()).toBe("a.ts");
    expect(lookup.bySuffix("src/missing.ts")).toBeNull();
  });

  it("finds the function occupying a line range", () => {
    const project = projectWith({
      "src/a.ts": "export function a() {\n  return 1;\n}\n",
    });
    const lookup = createSourceFileLookup(project);
    const found = lookup.functionAt({
      file: "src/a.ts",
      range: { start: 1, end: 3 },
    });
    expect(found?.getText()).toContain("return 1");
  });

  it("returns the outermost function when two share a range", () => {
    const project = projectWith({
      "src/a.ts": "export const a = () => () => 1;\n",
    });
    const lookup = createSourceFileLookup(project);
    const found = lookup.functionAt({
      file: "src/a.ts",
      range: { start: 1, end: 1 },
    });
    expect(found?.getText()).toBe("() => () => 1");
  });

  it("gives nothing back for a range no function occupies", () => {
    const project = projectWith({ "src/a.ts": "export const x = 1;\n" });
    const lookup = createSourceFileLookup(project);
    expect(
      lookup.functionAt({ file: "src/a.ts", range: { start: 9, end: 9 } }),
    ).toBeNull();
    expect(
      lookup.functionAt({ file: "src/gone.ts", range: { start: 1, end: 1 } }),
    ).toBeNull();
  });
});

describe("sourceFileFor", () => {
  it("finds a file by its absolute path", () => {
    const project = projectWith({ "src/a.ts": "export const x = 1;\n" });
    expect(sourceFileFor(project, "/src/a.ts")?.getBaseName()).toBe("a.ts");
  });

  it("gives nothing back for a bare package specifier", () => {
    const project = projectWith({ "src/react.ts": "export const x = 1;\n" });
    expect(sourceFileFor(project, "react")).toBeUndefined();
  });

  it("never asks ts-morph about a bare package specifier", () => {
    const project = projectWith({ "src/a.ts": "export const x = 1;\n" });
    const spy = vi.spyOn(project, "getSourceFile");

    expect(sourceFileFor(project, "react")).toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still asks about a relative specifier, which is a path", () => {
    const project = projectWith({ "src/a.ts": "export const x = 1;\n" });
    const spy = vi.spyOn(project, "getSourceFile");

    sourceFileFor(project, "./src/a.ts");

    expect(spy).toHaveBeenCalledWith("./src/a.ts");
    spy.mockRestore();
  });
});
