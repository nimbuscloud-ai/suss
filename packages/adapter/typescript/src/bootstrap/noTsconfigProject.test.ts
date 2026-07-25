import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProjectWithoutTsconfig,
  findNearestTsconfig,
  findSourceFiles,
} from "./noTsconfigProject.js";

describe("reading a project with no tsconfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-notsconfig-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents = "export const x = 1;\n"): void {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  function names(root: string): string[] {
    return findSourceFiles(root)
      .map((f) => path.relative(root, f))
      .sort();
  }

  it("finds JavaScript and TypeScript alike", () => {
    write("src/a.ts");
    write("src/b.js");
    write("src/c.mjs");
    write("src/d.cjs");
    write("src/e.tsx");

    expect(names(dir)).toEqual([
      "src/a.ts",
      "src/b.js",
      "src/c.mjs",
      "src/d.cjs",
      "src/e.tsx",
    ]);
  });

  it("skips build output and dependencies", () => {
    write("src/a.ts");
    write("node_modules/pkg/index.js");
    write("dist/a.js");
    write("coverage/report.js");
    write(".hidden/a.ts");

    expect(names(dir)).toEqual(["src/a.ts"]);
  });

  it("leaves declaration files out, since they say nothing about behaviour", () => {
    write("src/a.ts");
    write("src/a.d.ts", "export declare const x: number;\n");

    expect(names(dir)).toEqual(["src/a.ts"]);
  });

  it("returns nothing for a directory that is not there", () => {
    expect(findSourceFiles(path.join(dir, "missing"))).toEqual([]);
  });

  it("loads what it finds into a Project", () => {
    write("src/a.ts");
    write("src/b.js", "export function b() { return 1; }\n");

    const { project, files } = createProjectWithoutTsconfig(dir);

    expect(files).toHaveLength(2);
    expect(project.getSourceFiles()).toHaveLength(2);
    // allowJs is on, so the .js file parses rather than being skipped.
    expect(
      project
        .getSourceFiles()
        .map((f) => path.basename(f.getFilePath()))
        .sort(),
    ).toEqual(["a.ts", "b.js"]);
  });

  it("parses a file whose syntax needs modern settings", () => {
    write("src/a.ts", "export const x = { a: 1 } satisfies { a: number };\n");

    const { project } = createProjectWithoutTsconfig(dir);
    expect(project.getSourceFiles()).toHaveLength(1);
  });
});

describe("findNearestTsconfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-nearest-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds one in the directory itself", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    expect(findNearestTsconfig(dir)).toBe(path.join(dir, "tsconfig.json"));
  });

  it("walks up to find one above", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    const nested = path.join(dir, "packages", "a", "src");
    fs.mkdirSync(nested, { recursive: true });

    expect(findNearestTsconfig(nested)).toBe(path.join(dir, "tsconfig.json"));
  });

  it("accepts a jsconfig, which is what a JavaScript project keeps", () => {
    fs.writeFileSync(path.join(dir, "jsconfig.json"), "{}");
    expect(findNearestTsconfig(dir)).toBe(path.join(dir, "jsconfig.json"));
  });

  it("prefers the nearer one", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    const nested = path.join(dir, "service");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "tsconfig.json"), "{}");

    expect(findNearestTsconfig(nested)).toBe(
      path.join(nested, "tsconfig.json"),
    );
  });
});
