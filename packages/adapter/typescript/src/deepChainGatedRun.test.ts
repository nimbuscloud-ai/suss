/**
 * A gated run hands the compiler entry files that sit on top of deep
 * re-export chains. The bootstrap loads each chain into the project
 * before the files that import it, so the compiler's program build
 * finds every import already processed instead of descending a whole
 * chain in one recursive pass (#211). The depth here overflowed the
 * call stack before that ordering.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { unreadableExportFiles } from "./moduleExports.js";

import type { PatternPack } from "@suss/extractor";

const CHAIN_DEPTH = 2000;
const HANDLER_COUNT = 3;

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

async function makeDeepChainProject(): Promise<{
  dir: string;
  tsconfigPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-deep-"));
  const write = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  await write("core/m0.ts", "export function helper(): number { return 0; }\n");
  for (let i = 1; i <= CHAIN_DEPTH; i += 1) {
    await write(`core/m${i}.ts`, `export { helper } from "./m${i - 1}.js";\n`);
  }
  await write(
    "core/index.ts",
    `export { helper } from "./m${CHAIN_DEPTH}.js";\n`,
  );

  await write(
    "node_modules/@gated/lib/index.d.ts",
    "export declare function route(fn: () => unknown): void;\n",
  );
  await write(
    "node_modules/@gated/lib/package.json",
    JSON.stringify({ name: "@gated/lib", types: "index.d.ts" }),
  );

  for (let h = 0; h < HANDLER_COUNT; h += 1) {
    await write(
      `handlers/h${h}.ts`,
      [
        'import "@gated/lib";',
        'import { helper } from "../core/index.js";',
        "export function loader(): number { return helper(); }",
      ].join("\n"),
    );
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
      include: ["core/**/*.ts", "handlers/**/*.ts"],
    }),
  );
  return { dir, tsconfigPath };
}

describe("a gated run over handlers on a deep re-export chain", () => {
  let tempDir: string | null = null;

  afterAll(async () => {
    if (tempDir !== null) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts every handler instead of overflowing the call stack", async () => {
    const { dir, tsconfigPath } = await makeDeepChainProject();
    tempDir = dir;

    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: tsconfigPath,
      frameworks: [gatedPack],
    });
    const summaries = await adapter.extractAll();

    const handlerSummaries = summaries.filter((s) =>
      s.location.file.includes("handlers/"),
    );
    expect(handlerSummaries).toHaveLength(HANDLER_COUNT);
    expect(unreadableExportFiles()).toEqual([]);
  }, 120_000);
});
