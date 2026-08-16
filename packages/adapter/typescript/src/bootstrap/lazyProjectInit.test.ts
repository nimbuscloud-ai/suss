import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createLazyProject, lazyAddSourceFile } from "./lazyProjectInit.js";

import type { PatternPack } from "@suss/extractor";

async function makeTempProject(files: Record<string, string>): Promise<{
  dir: string;
  tsconfigPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-lazy-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
  const tsconfigPath = path.join(dir, "tsconfig.json");
  await fs.writeFile(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
      },
      include: ["**/*.ts"],
    }),
  );
  return { dir, tsconfigPath };
}

const gatedPack: PatternPack = {
  name: "test-gated",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["loader"] },
      requiresImport: ["@gated/lib"],
    },
  ],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

const ungatedPack: PatternPack = {
  name: "test-ungated",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["foo"] },
      requiresImport: [],
    },
  ],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

// A callback-driven pack: no data-driven discovery patterns, a
// pack-level import gate, and a `discoverUnits` callback. This is the
// shape `@suss/framework-aws-lambda` uses (routing lives in the SAM
// template, not in code), and the shape the bootstrap has to gate on
// the pack-level `requiresImport` rather than on per-pattern gates.
const callbackPack: PatternPack = {
  name: "test-callback",
  protocol: "http",
  languages: ["typescript"],
  discovery: [],
  discoverUnits: () => [],
  requiresImport: ["@callback/lib"],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

const recognizerOnlyPack: PatternPack = {
  name: "test-recognizer-only",
  protocol: "http",
  languages: ["typescript"],
  discovery: [],
  discoverUnits: () => [],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

describe("createLazyProject", () => {
  it("loads only files matching a gated pack's requiresImport", async () => {
    const { tsconfigPath } = await makeTempProject({
      "matching.ts": `import { foo } from "@gated/lib"; export const loader = () => foo;`,
      "non-matching.ts": `import { bar } from "@unrelated"; export const x = 1;`,
      "deep-import.ts": `import { y } from "@gated/lib/deep"; export const loader = () => y;`,
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    const loadedPaths = result.candidatePaths.slice().sort();
    expect(loadedPaths.map((p) => path.basename(p))).toEqual([
      "deep-import.ts",
      "matching.ts",
    ]);
  });

  it("loads a consumer that reaches the gated package through its own wrapper", async () => {
    const { tsconfigPath } = await makeTempProject({
      "wrapper.ts": `import { foo } from "@gated/lib"; export const call = () => foo;`,
      "consumer.ts": `import { call } from "./wrapper.js"; export const loader = () => call();`,
      "unrelated.ts": "export const x = 1;",
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.candidatePaths.map((p) => path.basename(p)).sort()).toEqual([
      "consumer.ts",
      "wrapper.ts",
    ]);
  });

  it("follows the wrapper chain however many project hops it takes", async () => {
    const { tsconfigPath } = await makeTempProject({
      "client/index.ts": `export { call } from "./wrapper";`,
      "client/wrapper.ts": `import { foo } from "@gated/lib"; export const call = () => foo;`,
      "consumer.ts": `import { call } from "./client"; export const loader = () => call();`,
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.candidatePaths.map((p) => path.basename(p)).sort()).toEqual([
      "consumer.ts",
      "index.ts",
      "wrapper.ts",
    ]);
  });

  it("follows a tsconfig path alias to the wrapper it maps to", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-lazy-"));
    for (const [rel, contents] of Object.entries({
      "src/wrapper.ts": `import { foo } from "@gated/lib"; export const call = () => foo;`,
      "src/consumer.ts": `import { call } from "@app/wrapper"; export const loader = () => call();`,
    })) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    const tsconfigPath = path.join(dir, "tsconfig.json");
    await fs.writeFile(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "@app/*": ["src/*"] },
        },
        include: ["**/*.ts"],
      }),
    );
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.candidatePaths.map((p) => path.basename(p)).sort()).toEqual([
      "consumer.ts",
      "wrapper.ts",
    ]);
  });

  it("follows a workspace package to the wrapper behind its node_modules symlink", async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "suss-lazy-")),
    );
    for (const [rel, contents] of Object.entries({
      "packages/client/package.json": JSON.stringify({
        name: "@mono/client",
        main: "index.ts",
        types: "index.ts",
      }),
      "packages/client/index.ts": `import { foo } from "@gated/lib"; export const call = () => foo;`,
      "src/consumer.ts": `import { call } from "@mono/client"; export const loader = () => call();`,
    })) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    await fs.mkdir(path.join(dir, "node_modules", "@mono"), {
      recursive: true,
    });
    await fs.symlink(
      path.join(dir, "packages", "client"),
      path.join(dir, "node_modules", "@mono", "client"),
    );
    const tsconfigPath = path.join(dir, "tsconfig.json");
    await fs.writeFile(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts", "packages/**/*.ts"],
      }),
    );
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.candidatePaths.map((p) => path.basename(p)).sort()).toEqual([
      "consumer.ts",
      "index.ts",
    ]);
  });

  it("loads every file when at least one pack is ungated", async () => {
    const { tsconfigPath } = await makeTempProject({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const result = await createLazyProject(tsconfigPath, [ungatedPack]);
    expect(result.candidatePaths).toHaveLength(2);
  });

  it("gates a discoverUnits-only pack on its pack-level requiresImport", async () => {
    const { tsconfigPath } = await makeTempProject({
      "handler.ts": `import type { H } from "@callback/lib"; export const handler: H = () => 1;`,
      "unrelated.ts": "export const x = 1;",
    });
    const result = await createLazyProject(tsconfigPath, [callbackPack]);
    expect(result.candidatePaths.map((p) => path.basename(p))).toEqual([
      "handler.ts",
    ]);
  });

  it("loads every file for a discoverUnits-only pack with no pack-level gate", async () => {
    const { tsconfigPath } = await makeTempProject({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const result = await createLazyProject(tsconfigPath, [recognizerOnlyPack]);
    expect(result.candidatePaths).toHaveLength(2);
  });

  it("populates projectFileSet with every tsconfig include file", async () => {
    const { tsconfigPath } = await makeTempProject({
      "matching.ts": `import "@gated/lib";`,
      "non-matching.ts": "export const x = 1;",
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.projectFileSet.size).toBe(2);
  });
});

describe("lazyAddSourceFile", () => {
  it("returns null for paths outside the project file set", async () => {
    const { tsconfigPath } = await makeTempProject({
      "a.ts": `import "@gated/lib";`,
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: true,
    });
    const added = lazyAddSourceFile(
      project,
      result.projectFileSet,
      "/some/other/path.ts",
    );
    expect(added).toBeNull();
  });

  it("adds an in-project but unloaded file on demand", async () => {
    const { tsconfigPath, dir } = await makeTempProject({
      "matching.ts": `import "@gated/lib";`,
      "helper.ts": "export const helper = () => 1;",
    });
    const result = await createLazyProject(tsconfigPath, [gatedPack]);
    expect(result.candidatePaths).toHaveLength(1);
    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: true,
    });
    const helperPath = path.join(dir, "helper.ts");
    const added = lazyAddSourceFile(project, result.projectFileSet, helperPath);
    expect(added).not.toBeNull();
    expect(added?.getFilePath()).toBe(helperPath);
  });
});
