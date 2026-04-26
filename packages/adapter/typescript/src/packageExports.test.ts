// packageExports.test.ts — resolver + discovery handler tests for
// the packageExports pack variant.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { clearPackageExportsCache, discoverUnits } from "./discovery/index.js";
import { resolvePackageExports } from "./packageExports.js";

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

  it("resolves root export via the `exports` field with `types` condition", async () => {
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

  it("resolves sub-path export and records prefix", async () => {
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

  it("falls back to `types`/`main` when no `exports` field", async () => {
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

  it("warns on pattern exports and unresolvable sub-paths", async () => {
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

  it("accepts string-valued exports entries", async () => {
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

  it("emits one unit per exported function with `library` kind", async () => {
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

  it("records packageExportInfo with package + exportPath", async () => {
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

  it("follows barrel re-exports (`export * from` and `export { A as B } from`)", async () => {
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

  it("respects excludeNames (skipping `default`)", async () => {
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

  it("surfaces methods on a factory's object-literal return", async () => {
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
          export function createClient() {
            const project = {};
            return {
              project,
              fetchAll() { return 1; },
              create: (input: unknown) => 2,
              create2: function (input: unknown) { return 3; },
            };
          }
        `,
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    const paths = units
      .map((u) => u.packageExportInfo?.exportPath.join("."))
      .sort();
    // createClient itself plus three method-shorthand / arrow / fn-expr
    // properties. `project` is a non-callable shorthand value — skipped.
    expect(paths).toEqual([
      "createClient",
      "createClient.create",
      "createClient.create2",
      "createClient.fetchAll",
    ]);
  });

  it("ignores nested function returns when surfacing", async () => {
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
          export function outer() {
            function helper() {
              return { unused() {} };
            }
            return { real() { return helper(); } };
          }
        `,
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    const paths = units
      .map((u) => u.packageExportInfo?.exportPath.join("."))
      .sort();
    // helper's return-shape doesn't belong to outer — `unused` is not surfaced.
    expect(paths).toEqual(["outer", "outer.real"]);
  });

  it("surfaces public methods on a class declaration", async () => {
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
          export class ApiClient {
            get(path: string) { return path; }
            post(path: string, body: unknown) { return path; }
            private internal() { return 1; }
            #hidden() { return 2; }
            static create() { return new ApiClient(); }
          }
        `,
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    const paths = units
      .map((u) => u.packageExportInfo?.exportPath.join("."))
      .sort();
    // get + post + static create. private + #hidden are skipped.
    // The class itself isn't a FunctionRoot, so no top-level
    // [ApiClient] unit yet — known gap (constructor synthesis).
    expect(paths).toEqual([
      "ApiClient.create",
      "ApiClient.get",
      "ApiClient.post",
    ]);
  });

  it("surfaces methods on a concise-arrow factory: () => ({ ... })", async () => {
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
          export const make = () => ({
            doIt() { return 1; },
          });
        `,
      },
    ]);

    const { units } = runDiscovery(path.join(root, "package.json"));
    const paths = units
      .map((u) => u.packageExportInfo?.exportPath.join("."))
      .sort();
    expect(paths).toEqual(["make", "make.doIt"]);
  });

  it("respects subPaths filter", async () => {
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

  it("produces a library summary with function-call package binding", async () => {
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
    const summaries = await adapter.extractAll();

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

  it("captures return-expression shape on returnStatement terminals", async () => {
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
          export function classify(x: number) {
            if (x < 0) {
              return "negative";
            }
            if (x === 0) {
              return "zero";
            }
            return "positive";
          }

          export function wrap(name: string) {
            return { kind: "box", name };
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
    const summaries = await adapter.extractAll();

    const classify = summaries.find((s) => s.identity.name === "classify");
    const returnValues = classify?.transitions.map((t) =>
      t.output.type === "return" ? t.output.value : null,
    );
    // Each branch returns a distinct string literal — without the shape
    // fix these would all be null.
    expect(returnValues).toEqual([
      { type: "literal", value: "negative" },
      { type: "literal", value: "zero" },
      { type: "literal", value: "positive" },
    ]);

    const wrap = summaries.find((s) => s.identity.name === "wrap");
    const wrapReturn = wrap?.transitions[0].output;
    if (wrapReturn?.type !== "return") {
      throw new Error("expected return output");
    }
    expect(wrapReturn.value?.type).toBe("record");
  });
});

// ---------------------------------------------------------------------------
// packageImport — consumer-side discovery
// ---------------------------------------------------------------------------

describe("discoverPackageImports", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) {
      cleanup(root);
      root = null;
    }
  });

  it("emits one caller unit per (enclosing function × consumed binding)", async () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/consumer",
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
        relPath: "src/consumer.ts",
        content: `
          import { parseSummary, safeParseSummary } from "@suss/behavioral-ir";
          import { BehavioralSummarySchema } from "@suss/behavioral-ir/schemas";

          export function loadOne(input: unknown) {
            const s = parseSummary(input);
            return s;
          }

          export function loadSafely(input: unknown) {
            const r = safeParseSummary(input);
            if (!r.success) {
              throw new Error("bad");
            }
            return r.data;
          }

          export function validate(input: unknown) {
            return BehavioralSummarySchema.parse(input);
          }
        `,
      },
    ]);

    const project = new Project({
      tsConfigFilePath: path.join(root, "tsconfig.json"),
    });
    const sf = project.getSourceFileOrThrow(path.join(root, "src/consumer.ts"));

    const units = discoverUnits(sf, [
      {
        kind: "caller",
        match: {
          type: "packageImport",
          packages: ["@suss/behavioral-ir", "@suss/behavioral-ir/schemas"],
        },
      },
    ]);

    const summary = units.map((u) => ({
      name: u.name,
      info: u.packageExportInfo,
    }));
    // loadOne calls parseSummary; loadSafely calls safeParseSummary;
    // validate calls BehavioralSummarySchema.parse — a method on the
    // imported binding, attributed to exportPath
    // [BehavioralSummarySchema, parse].
    expect(summary).toContainEqual({
      name: "loadOne",
      info: {
        packageName: "@suss/behavioral-ir",
        exportPath: ["parseSummary"],
      },
    });
    expect(summary).toContainEqual({
      name: "loadSafely",
      info: {
        packageName: "@suss/behavioral-ir",
        exportPath: ["safeParseSummary"],
      },
    });
    expect(summary).toContainEqual({
      name: "validate",
      info: {
        packageName: "@suss/behavioral-ir",
        exportPath: ["schemas", "BehavioralSummarySchema", "parse"],
      },
    });
  });

  it("produces function-call binding with package + exportPath on summaries", async () => {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({
          name: "@ex/consumer",
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
        relPath: "src/consumer.ts",
        content: `
          import { parseSummary } from "@suss/behavioral-ir";
          export function loadOne(input: unknown) {
            return parseSummary(input);
          }
        `,
      },
    ]);

    const pack: PatternPack = {
      name: "package-import:@ex/consumer",
      languages: ["typescript"],
      protocol: "in-process",
      discovery: [
        {
          kind: "caller",
          match: {
            type: "packageImport",
            packages: ["@suss/behavioral-ir"],
          },
        },
      ],
      terminals: [
        { kind: "return", match: { type: "returnStatement" }, extraction: {} },
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
    const summaries = await adapter.extractAll();

    const loadOne = summaries.find((s) => s.identity.name === "loadOne");
    expect(loadOne).toBeDefined();
    expect(loadOne?.kind).toBe("caller");
    expect(loadOne?.identity.boundaryBinding?.semantics).toEqual({
      name: "function-call",
      package: "@suss/behavioral-ir",
      exportPath: ["parseSummary"],
    });
  });
});

// ---------------------------------------------------------------------------
// packageImport — factory / class / await binding tracking
// ---------------------------------------------------------------------------
//
// These tests lock in the consumer-side method-call attribution: when
// a local binding's value traces (one syntactic hop) back to a tracked
// import, method calls on that binding pair against
// `[..exportPath, methodName]`.

describe("discoverPackageImports — factory / class binding tracking", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) {
      cleanup(root);
      root = null;
    }
  });

  function discover(source: string) {
    root = writeFixturePackage([
      {
        relPath: "package.json",
        content: JSON.stringify({ name: "@ex/consumer" }),
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
      { relPath: "src/consumer.ts", content: source },
    ]);

    const project = new Project({
      tsConfigFilePath: path.join(root, "tsconfig.json"),
    });
    const sf = project.getSourceFileOrThrow(path.join(root, "src/consumer.ts"));

    return discoverUnits(sf, [
      {
        kind: "caller",
        match: { type: "packageImport", packages: ["@ex/lib"] },
      },
    ]).map((u) => ({ name: u.name, info: u.packageExportInfo }));
  }

  it("tracks `const c = factory(); c.method(...)`", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        const c = createClient();
        return c.fetchAll();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
  });

  it("tracks `const c = new Class(); c.method(...)`", () => {
    const summary = discover(`
      import { ApiClient } from "@ex/lib";
      export function load() {
        const c = new ApiClient();
        return c.get("/users");
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: { packageName: "@ex/lib", exportPath: ["ApiClient", "get"] },
    });
  });

  it("tracks `const c = await getClient(); c.method(...)`", () => {
    const summary = discover(`
      import { getClient } from "@ex/lib";
      export async function load() {
        const c = await getClient();
        return c.fetchAll();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: { packageName: "@ex/lib", exportPath: ["getClient", "fetchAll"] },
    });
  });

  it("tracks one-shot `factory().method(...)`", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        return createClient().fetchAll();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
  });

  it("tracks one-shot `new Class().method(...)`", () => {
    const summary = discover(`
      import { ApiClient } from "@ex/lib";
      export function load() {
        return new ApiClient().get("/users");
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: { packageName: "@ex/lib", exportPath: ["ApiClient", "get"] },
    });
  });

  it("tracks `(await getClient()).method(...)`", () => {
    const summary = discover(`
      import { getClient } from "@ex/lib";
      export async function load() {
        return (await getClient()).fetchAll();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: { packageName: "@ex/lib", exportPath: ["getClient", "fetchAll"] },
    });
  });

  it("tracks plain destructured factory result: `const { method } = factory()`", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        const { fetchAll } = createClient();
        return fetchAll();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
  });

  it("tracks aliased destructured factory result", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        const { fetchAll: doIt } = createClient();
        return doIt();
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
  });

  it("emits one unit per (function × method) when multiple methods are called on the same binding", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        const c = createClient();
        c.fetchAll();
        c.create({});
      }
    `);
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
    expect(summary).toContainEqual({
      name: "load",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "create"],
      },
    });
  });

  it("collapses repeated calls of the same method on the same binding", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function load() {
        const c = createClient();
        c.fetchAll();
        c.fetchAll();
        c.fetchAll();
      }
    `);
    const matching = summary.filter(
      (s) =>
        s.name === "load" &&
        s.info?.exportPath.join(".") === "createClient.fetchAll",
    );
    expect(matching).toHaveLength(1);
  });

  it("does NOT track method calls on bindings whose initializer isn't a tracked import", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      function unrelated() { return { fetchAll: () => 1 }; }
      export function load() {
        const c = unrelated();
        return c.fetchAll();
      }
    `);
    // unrelated() doesn't trace to @ex/lib — c.fetchAll() is invisible.
    expect(summary).toHaveLength(0);
  });

  it("scopes bindings to enclosing function — sibling functions don't clobber", () => {
    const summary = discover(`
      import { createA, createB } from "@ex/lib";
      export function loadA() {
        const c = createA();
        return c.method();
      }
      export function loadB() {
        const c = createB();
        return c.method();
      }
    `);
    expect(summary).toContainEqual({
      name: "loadA",
      info: { packageName: "@ex/lib", exportPath: ["createA", "method"] },
    });
    expect(summary).toContainEqual({
      name: "loadB",
      info: { packageName: "@ex/lib", exportPath: ["createB", "method"] },
    });
    // Cross-pollination would show up as loadA having a createB.method
    // unit (or vice versa).
    const cross = summary.filter(
      (s) =>
        (s.name === "loadA" &&
          s.info?.exportPath.join(".") === "createB.method") ||
        (s.name === "loadB" &&
          s.info?.exportPath.join(".") === "createA.method"),
    );
    expect(cross).toHaveLength(0);
  });

  it("resolves through closure capture — outer binding visible in inner function", () => {
    const summary = discover(`
      import { createClient } from "@ex/lib";
      export function outer() {
        const c = createClient();
        function inner() {
          return c.fetchAll();
        }
        return inner();
      }
    `);
    expect(summary).toContainEqual({
      name: "inner",
      info: {
        packageName: "@ex/lib",
        exportPath: ["createClient", "fetchAll"],
      },
    });
  });

  it("inner shadowing — nested binding overrides outer binding of same name", () => {
    const summary = discover(`
      import { createA, createB } from "@ex/lib";
      export function outer() {
        const c = createA();
        function inner() {
          const c = createB();
          return c.method();
        }
        return inner();
      }
    `);
    // inner's c shadows outer's c; the .method() call resolves to createB.
    expect(summary).toContainEqual({
      name: "inner",
      info: { packageName: "@ex/lib", exportPath: ["createB", "method"] },
    });
    const wrong = summary.filter(
      (s) =>
        s.name === "inner" && s.info?.exportPath.join(".") === "createA.method",
    );
    expect(wrong).toHaveLength(0);
  });
});
