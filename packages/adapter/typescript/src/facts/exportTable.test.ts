import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

function exportNamesOf(files: Record<string, string>, ask: string): string[] {
  const project = createTestProject();
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  const store = new ResolutionStore();
  const asked = project.getSourceFileOrThrow(ask);
  return [...store.exportsOf(asked).keys()].sort();
}

describe("what exportsOf lists per module shape", () => {
  it("direct exports", () => {
    expect(
      exportNamesOf(
        {
          "/lib.ts":
            "export function alpha() {}\nexport const beta = 1;\nexport default function main() {}\n",
        },
        "/lib.ts",
      ),
    ).toEqual(["alpha", "beta", "default"]);
  });

  it("a named re-export barrel", () => {
    expect(
      exportNamesOf(
        {
          "/inner.ts": "export function alpha() {}\n",
          "/barrel.ts": 'export { alpha as first } from "./inner.js";\n',
        },
        "/barrel.ts",
      ),
    ).toEqual(["first"]);
  });

  it("an export-everything chain", () => {
    expect(
      exportNamesOf(
        {
          "/inner.ts": "export function alpha() {}\nexport const beta = 1;\n",
          "/mid.ts": 'export * from "./inner.js";\n',
          "/barrel.ts": 'export * from "./mid.js";\n',
        },
        "/barrel.ts",
      ),
    ).toEqual(["alpha", "beta"]);
  });

  it("an export list over an import", () => {
    expect(
      exportNamesOf(
        {
          "/inner.ts": "export function alpha() {}\n",
          "/barrel.ts":
            'import { alpha } from "./inner.js";\nexport { alpha };\n',
        },
        "/barrel.ts",
      ),
    ).toEqual(["alpha"]);
  });

  it("a chain longer than any old walk bound", () => {
    const files: Record<string, string> = {
      "/hop0.ts": "export function alpha() {}\n",
    };
    for (let i = 1; i <= 9; i++) {
      files[`/hop${i}.ts`] = `export * from "./hop${i - 1}.js";\n`;
    }
    expect(exportNamesOf(files, "/hop9.ts")).toEqual(["alpha"]);
  });

  it("a default that states a bare name lists its declaration", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/pack.ts",
      "function makePack() {}\nexport default makePack;\n",
    );
    const store = new ResolutionStore();
    const values = store.exportsOf(file).get("default") ?? [];
    expect(values).toHaveLength(1);
    expect(Node.isFunctionDeclaration(values[0])).toBe(true);
  });

  it("a reassigned default says nothing, a reassigned list name resolves", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/pack.ts",
      [
        "let handler = () => 1;",
        "export default handler;",
        "export { handler };",
        "handler = () => 2;",
        "",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const table = store.exportsOf(file);
    // The default took the value before the later write; the last write
    // the facts know is the wrong claim, so there is no claim.
    expect(table.get("default")).toBeUndefined();
    expect(table.get("handler")).toHaveLength(1);
  });

  it("a default that states an imported name flattens to its source", () => {
    const project = createTestProject();
    project.createSourceFile("/inner.ts", "export function alpha() {}\n");
    project.createSourceFile(
      "/barrel.ts",
      'import { alpha } from "./inner.js";\nexport default alpha;\n',
    );
    const store = new ResolutionStore();
    const values =
      store
        .exportsOf(project.getSourceFileOrThrow("/barrel.ts"))
        .get("default") ?? [];
    expect(values).toHaveLength(1);
    expect(values[0]?.getSourceFile().getFilePath()).toBe("/inner.ts");
  });

  it("the value behind a re-exported name is the inner function", () => {
    const project = createTestProject();
    project.createSourceFile("/inner.ts", "export function alpha() {}\n");
    project.createSourceFile(
      "/barrel.ts",
      'export { alpha as first } from "./inner.js";\n',
    );
    const store = new ResolutionStore();
    const table = store.exportsOf(project.getSourceFileOrThrow("/barrel.ts"));
    const values = table.get("first") ?? [];
    expect(values).toHaveLength(1);
    expect(Node.isFunctionDeclaration(values[0])).toBe(true);
    expect(values[0]?.getSourceFile().getFilePath()).toBe("/inner.ts");
  });
});

describe("the order of a barrel's table", () => {
  const files = {
    "/inner.ts":
      "export function third() {}\nexport function first() {}\nexport function second() {}\n",
    "/barrel.ts": 'export { first, second, third } from "./inner.js";\n',
  };

  function projectOf(): ReturnType<typeof createTestProject> {
    const project = createTestProject();
    for (const [path, content] of Object.entries(files)) {
      project.createSourceFile(path, content);
    }
    return project;
  }

  it("follows the barrel's own statement on a cold store", () => {
    const project = projectOf();
    const store = new ResolutionStore();
    const table = store.exportsOf(project.getSourceFileOrThrow("/barrel.ts"));
    expect([...table.keys()]).toEqual(["first", "second", "third"]);
  });

  it("follows the barrel's own statement when the target was read first", () => {
    const project = projectOf();
    const store = new ResolutionStore();
    store.exportsOf(project.getSourceFileOrThrow("/inner.ts"));
    const table = store.exportsOf(project.getSourceFileOrThrow("/barrel.ts"));
    expect([...table.keys()]).toEqual(["first", "second", "third"]);
  });
});
