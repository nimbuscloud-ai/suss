// package-exports.test.ts — resolver + discovery handler tests for
// the packageExports pack variant.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { clearPackageExportsCache, discoverUnits } from "./discovery.js";
import { resolvePackageExports } from "./package-exports.js";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface FixtureFile {
  relPath: string;
  content: string;
}

function writeFixturePackage(files: FixtureFile[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pkgexp-"));
  for (const f of files) {
    const abs = path.join(root, f.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
  }
  return root;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

describe("resolvePackageExports", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) {
      cleanup(root);
      root = null;
    }
  });

  it("resolves root export via the `exports` field with `types` condition", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
            },
          },
        }),
      },
      { relPath: "src/index.ts", content: "export const foo = () => 1;" },
    ]);

    const result = resolvePackageExports(path.join(root, "package.json"));
    expect(result.packageName).toBe("@ex/lib");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].subPath).toBe(".");
    expect(result.entries[0].exportPathPrefix).toEqual([]);
    expect(result.entries[0].sourceFile).toBe(path.join(root, "src/index.ts"));
    expect(result.warnings).toHaveLength(0);
  });

  it("resolves sub-path export and records prefix", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: {
            ".": { types: "./dist/index.d.ts" },
            "./schemas": { types: "./dist/schemas.d.ts" },
          },
        }),
      },
      { relPath: "src/index.ts", content: "export const foo = () => 1;" },
      { relPath: "src/schemas.ts", content: "export const bar = () => 2;" },
    ]);

    const result = resolvePackageExports(path.join(root, "package.json"));
    expect(result.entries).toHaveLength(2);
    const schemas = result.entries.find((e) => e.subPath === "schemas");
    expect(schemas).toBeDefined();
    expect(schemas?.exportPathPrefix).toEqual(["schemas"]);
  });

  it("falls back to `types`/`main` when no `exports` field", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          types: "./dist/index.d.ts",
          main: "./dist/index.cjs",
        }),
      },
      { relPath: "src/index.ts", content: "export const foo = () => 1;" },
    ]);

    const result = resolvePackageExports(path.join(root, "package.json"));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].subPath).toBe(".");
  });

  it("warns on pattern exports and unresolvable sub-paths", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: {
            "./utils/*": { types: "./dist/utils/*.d.ts" },
            "./missing": { types: "./dist/nope.d.ts" },
          },
        }),
      },
    ]);

    const result = resolvePackageExports(path.join(root, "package.json"));
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("pattern export"))).toBe(
      true,
    );
  });

  it("accepts string-valued exports entries", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: "./dist/index.d.ts",
        }),
      },
      { relPath: "src/index.ts", content: "export const foo = () => 1;" },
    ]);

    const result = resolvePackageExports(path.join(root, "package.json"));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].subPath).toBe(".");
  });
});

// ---------------------------------------------------------------------------
// Discovery handler
// ---------------------------------------------------------------------------

describe("discoverPackageExports", () => {
  let root: string | null = null;

  beforeEach(() => {
    clearPackageExportsCache();
  });

  afterEach(() => {
    if (root !== null) {
      cleanup(root);
      root = null;
    }
    clearPackageExportsCache();
  });

  function runDiscovery(pkgJsonPath: string) {
    const project = new Project({ useInMemoryFileSystem: false });
    // Add the resolved source file to the project explicitly rather
    // than letting the project walk the tree — keeps the test
    // hermetic and ensures getFilePath() matches the resolver output.
    const { entries } = resolvePackageExports(pkgJsonPath);
    const sources = entries.map((e) =>
      project.addSourceFileAtPath(e.sourceFile),
    );
    const pattern: DiscoveryPattern = {
      kind: "library",
      match: { type: "packageExports", packageJsonPath: pkgJsonPath },
    };
    return {
      units: sources.flatMap((sf) => discoverUnits(sf, [pattern])),
      entries,
    };
  }

  it("emits one unit per exported function with `library` kind", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: { ".": { types: "./dist/index.d.ts" } },
        }),
      },
      {
        relPath: "src/index.ts",
        content: `
          export function foo() { return 1; }
          export const bar = () => 2;
          export const notAFunction = 42;
        `,
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    expect(units.map((u) => u.name).sort()).toEqual(["bar", "foo"]);
    expect(units.every((u) => u.kind === "library")).toBe(true);
  });

  it("records packageExportInfo with package + exportPath", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: {
            ".": { types: "./dist/index.d.ts" },
            "./schemas": { types: "./dist/schemas.d.ts" },
          },
        }),
      },
      { relPath: "src/index.ts", content: "export function foo() {}" },
      { relPath: "src/schemas.ts", content: "export function bar() {}" },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));

    const foo = units.find((u) => u.name === "foo");
    expect(foo?.packageExportInfo).toEqual({
      packageName: "@ex/lib",
      exportPath: ["foo"],
    });

    const bar = units.find((u) => u.name === "bar");
    expect(bar?.packageExportInfo).toEqual({
      packageName: "@ex/lib",
      exportPath: ["schemas", "bar"],
    });
  });

  it("follows barrel re-exports (`export * from` and `export { A as B } from`)", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: { ".": { types: "./dist/index.d.ts" } },
        }),
      },
      {
        relPath: "src/index.ts",
        content: `
          export * from "./a.js";
          export { helper as renamedHelper } from "./b.js";
        `,
      },
      {
        relPath: "src/a.ts",
        content: "export function aFn() { return 1; }",
      },
      {
        relPath: "src/b.ts",
        content: "export function helper() { return 2; }",
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    const names = units.map((u) => u.name).sort();
    expect(names).toEqual(["aFn", "renamedHelper"]);
  });

  it("respects excludeNames (skipping `default`)", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: { ".": { types: "./dist/index.d.ts" } },
        }),
      },
      {
        relPath: "src/index.ts",
        content: `
          export default function Main() { return 1; }
          export function other() { return 2; }
        `,
      },
    ]);

    const project = new Project({ useInMemoryFileSystem: false });
    const { entries } = resolvePackageExports(path.join(root, "package.json"));
    const sf = project.addSourceFileAtPath(entries[0].sourceFile);
    const units = discoverUnits(sf, [
      {
        kind: "library",
        match: {
          type: "packageExports",
          packageJsonPath: path.join(root, "package.json"),
          excludeNames: ["default"],
        },
      },
    ]);
    expect(units.map((u) => u.name).sort()).toEqual(["other"]);
  });

  it("respects subPaths filter", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: {
            ".": { types: "./dist/index.d.ts" },
            "./schemas": { types: "./dist/schemas.d.ts" },
          },
        }),
      },
      { relPath: "src/index.ts", content: "export function foo() {}" },
      { relPath: "src/schemas.ts", content: "export function bar() {}" },
    ]);

    const project = new Project({ useInMemoryFileSystem: false });
    const { entries } = resolvePackageExports(path.join(root, "package.json"));
    const sources = entries.map((e) =>
      project.addSourceFileAtPath(e.sourceFile),
    );
    const pattern: DiscoveryPattern = {
      kind: "library",
      match: {
        type: "packageExports",
        packageJsonPath: path.join(root, "package.json"),
        subPaths: ["schemas"],
      },
    };
    const units = sources.flatMap((sf) => discoverUnits(sf, [pattern]));
    expect(units.map((u) => u.name)).toEqual(["bar"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through createTypeScriptAdapter
// ---------------------------------------------------------------------------

describe("packageExports — end-to-end summary", () => {
  let root: string | null = null;

  beforeEach(() => {
    clearPackageExportsCache();
  });

  afterEach(() => {
    if (root !== null) {
      cleanup(root);
      root = null;
    }
    clearPackageExportsCache();
  });

  it("produces a library summary with function-call package binding", () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/lib",
          exports: { ".": { types: "./dist/index.d.ts" } },
        }),
      },
      {
        relPath: "tsconfig.json",
        content: JSON.stringify({
          compilerOptions: {
            target: "es2022",
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
          },
          include: ["src/**/*"],
        }),
      },
      {
        relPath: "src/index.ts",
        content: `
          export function foo(x: number) {
            if (x < 0) {
              throw new Error("negative");
            }
            return x * 2;
          }
        `,
      },
    ]);

    const pkgJson = path.join(root, "package.json");
    const pack: PatternPack = {
      name: "package-exports:@ex/lib",
      languages: ["typescript"],
      protocol: "in-process",
      discovery: [
        {
          kind: "library",
          match: { type: "packageExports", packageJsonPath: pkgJson },
        },
      ],
      terminals: [
        { kind: "return", match: { type: "returnStatement" }, extraction: {} },
        {
          kind: "throw",
          match: { type: "throwExpression" },
          extraction: {},
        },
      ],
      inputMapping: {
        type: "positionalParams",
        params: [{ position: 0, role: "arg0" }],
      },
    };

    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(root, "tsconfig.json"),
      frameworks: [pack],
    });
    const summaries = adapter.extractAll();

    const foo = summaries.find((s) => s.identity.name === "foo");
    expect(foo).toBeDefined();
    expect(foo?.kind).toBe("library");
    const binding = foo?.identity.boundaryBinding;
    expect(binding?.semantics).toEqual({
      name: "function-call",
      package: "@ex/lib",
      exportPath: ["foo"],
    });
    expect(binding?.transport).toBe("in-process");
    expect(binding?.recognition).toBe("package-exports:@ex/lib");
  });
});
