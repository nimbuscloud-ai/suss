/**
 * A solution-style tsconfig sets no options and lists references that
 * do. The files the run walks come from the references, so the program
 * has to take those files in too, or the checker throws on the first
 * JavaScript file a reference allows.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { readTsconfig } from "./bootstrap/lazyProjectInit.js";

import type { PatternPack } from "@suss/extractor";

const pack: PatternPack = {
  name: "initializers",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["teardown"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const INITIALIZER = `
const initializer = {
  initialize(owner) {
    this.handler = () => owner.reload();
    window.addEventListener("pageshow", this.handler);
  },
};
window.addEventListener("load", initializer.initialize);

export function teardown(active) {
  if (!active) {
    return false;
  }
  this.cleanup();
  return true;
}
`;

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeSolution(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-solution-"));
  tempDirs.push(dir);
  const write = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  await write("package.json", JSON.stringify({ name: "solution" }));
  await write(
    "tsconfig.json",
    JSON.stringify({ references: [{ path: "frontend" }], include: [] }),
  );
  await write(
    "frontend/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        allowJs: true,
        composite: true,
      },
      include: ["app/**/*"],
    }),
  );
  await write("frontend/app/initializer.js", INITIALIZER);
  return dir;
}

describe("a solution-style tsconfig whose reference allows JavaScript", () => {
  it("allows JavaScript in the options the run reads", async () => {
    const dir = await makeSolution();

    const tsconfig = readTsconfig(path.join(dir, "tsconfig.json"));

    expect(tsconfig.fileNames.map((f) => path.basename(f))).toEqual([
      "initializer.js",
    ]);
    expect(tsconfig.options.allowJs).toBe(true);
  });

  it("reads the JavaScript files its references list without a failure", async () => {
    const dir = await makeSolution();
    const adapter = createTypeScriptAdapter({
      tsConfigFilePath: path.join(dir, "tsconfig.json"),
      frameworks: [pack],
    });
    const writes: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    const summaries = await adapter.extractAll().finally(() => {
      stderr.mockRestore();
    });

    const teardown = summaries.find((s) => s.identity.name === "teardown");
    expect(teardown?.transitions).toHaveLength(2);
    expect(writes.join("")).not.toContain("could not");
  });
});
