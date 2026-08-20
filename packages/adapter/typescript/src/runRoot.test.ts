/**
 * One run measures every file from one root (#443).
 *
 * The case that went wrong: a workspace whose summaries are all in
 * one subdirectory. The root used to be the loaded files' common
 * directory, so that run spelled `backend/src/server.ts` as
 * `server.ts`, while a run that also loaded a frontend file spelled
 * the same file from the workspace. The root now comes from the run's
 * configuration, so every run of any subset spells a file the same way.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "./adapter.js";
import { workspaceRootFor } from "./summaryIdentity.js";

import type { PatternPack } from "@suss/extractor";

const pack: PatternPack = {
  name: "test-run-root",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["get"] } },
    { kind: "handler", match: { type: "namedExport", names: ["loadUser"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeWorkspace(include: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-run-root-"));
  tempDirs.push(dir);
  const write = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  await write("package.json", JSON.stringify({ name: "pair-shape" }));
  await write(
    "backend/src/server.ts",
    "export function get(): number { return 200; }\n",
  );
  await write(
    "frontend/src/loadUser.ts",
    "export function loadUser(): string { return 'ada'; }\n",
  );
  await write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
      },
      include,
    }),
  );
  return dir;
}

async function idsFrom(dir: string): Promise<string[]> {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(dir, "tsconfig.json"),
    frameworks: [pack],
    cacheDir: null,
  });
  const summaries = await adapter.extractAll();
  return summaries.map((s) => s.identity.id ?? "").sort();
}

describe("the root a run measures its files from", () => {
  it("spells a root-level file and a nested one from the same root", async () => {
    const dir = await makeWorkspace(["backend/src", "frontend/src"]);
    const ids = await idsFrom(dir);

    expect(ids).toEqual([
      "pair-shape::backend/src/server.ts::get",
      "pair-shape::frontend/src/loadUser.ts::loadUser",
    ]);
  });

  it("spells a file the same way when the run loads only its subtree", async () => {
    const dir = await makeWorkspace(["backend/src"]);
    const ids = await idsFrom(dir);

    // Every loaded file is in backend/src, so the loaded files'
    // common directory would have spelled this `server.ts`.
    expect(ids).toEqual(["pair-shape::backend/src/server.ts::get"]);
  });
});

describe("workspaceRootFor", () => {
  it("walks up from a nested anchor to the directory that names the workspace", async () => {
    const dir = await makeWorkspace(["backend/src"]);
    expect(workspaceRootFor(path.join(dir, "backend"))).toBe(dir);
  });

  it("is the anchor itself when nothing above declares a name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-bare-"));
    tempDirs.push(dir);
    expect(workspaceRootFor(dir)).toBe(dir);
  });
});
