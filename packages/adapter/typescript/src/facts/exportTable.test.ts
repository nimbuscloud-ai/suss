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
