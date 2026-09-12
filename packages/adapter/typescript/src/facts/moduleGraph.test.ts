import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ModuleGraph, namesAnyPackage, namesPackage } from "./moduleGraph.js";

describe("namesPackage", () => {
  it("matches the package itself", () => {
    expect(namesPackage(["@aws-sdk/client-sqs"], "@aws-sdk/client-sqs")).toBe(
      true,
    );
  });

  it("matches a subpath of the package", () => {
    expect(
      namesPackage(["@aws-sdk/client-sqs/internals"], "@aws-sdk/client-sqs"),
    ).toBe(true);
  });

  it("does not match a package that merely starts the same way", () => {
    expect(
      namesPackage(["@aws-sdk/client-sqs-extra"], "@aws-sdk/client-sqs"),
    ).toBe(false);
  });

  it("says no for a file that names nothing relevant", () => {
    expect(namesPackage(["./local", "node:fs"], "express")).toBe(false);
  });
});

describe("namesAnyPackage", () => {
  it("matches when one of the names is there", () => {
    expect(namesAnyPackage(["react", "./local"], ["express", "react"])).toBe(
      true,
    );
  });

  it("says no when none of them is", () => {
    expect(namesAnyPackage(["react"], ["express", "fastify"])).toBe(false);
  });

  it("says no when there are no names to match", () => {
    expect(namesAnyPackage(["react"], [])).toBe(false);
  });
});

describe("filesReachingFile", () => {
  function reaching(files: Record<string, string>, target: string): string[] {
    const project = createTestProject();
    for (const [path, contents] of Object.entries(files)) {
      project.createSourceFile(path, contents);
    }
    const sourceFiles = Object.keys(files).map((path) =>
      project.getSourceFileOrThrow(path),
    );
    const [answer] = new ModuleGraph().filesReachingFile([
      { sourceFiles, target: project.getSourceFileOrThrow(target) },
    ]);
    return [...(answer ?? [])].map((one) => one.getFilePath()).sort();
  }

  it("finds a file that imports the target itself", () => {
    expect(
      reaching(
        {
          "/hooks.ts": "export const useAppQuery = () => null;",
          "/profile.ts": `import { useAppQuery } from "./hooks"; export const p = useAppQuery;`,
          "/unrelated.ts": "export const nothing = 1;",
        },
        "/hooks.ts",
      ),
    ).toEqual(["/profile.ts"]);
  });

  it("finds a file that reaches the target through a barrel", () => {
    expect(
      reaching(
        {
          "/hooks.ts": "export const useAppQuery = () => null;",
          "/index.ts": `export { useAppQuery } from "./hooks";`,
          "/profile.ts": `import { useAppQuery } from "./index"; export const p = useAppQuery;`,
        },
        "/hooks.ts",
      ),
    ).toEqual(["/index.ts", "/profile.ts"]);
  });

  it("leaves out the target, which reaches itself through nothing", () => {
    expect(
      reaching(
        { "/hooks.ts": "export const useAppQuery = () => null;" },
        "/hooks.ts",
      ),
    ).toEqual([]);
  });

  it("answers two targets from one pass over the edges", () => {
    const project = createTestProject();
    project.createSourceFile("/a.ts", "export const a = 1;");
    project.createSourceFile("/b.ts", "export const b = 2;");
    project.createSourceFile(
      "/reader.ts",
      `import { a } from "./a"; export const r = a;`,
    );
    const sourceFiles = ["/a.ts", "/b.ts", "/reader.ts"].map((path) =>
      project.getSourceFileOrThrow(path),
    );
    const answers = new ModuleGraph().filesReachingFile([
      { sourceFiles, target: project.getSourceFileOrThrow("/a.ts") },
      { sourceFiles, target: project.getSourceFileOrThrow("/b.ts") },
    ]);

    expect(answers.map((one) => [...one].map((f) => f.getFilePath()))).toEqual([
      ["/reader.ts"],
      [],
    ]);
  });
});
