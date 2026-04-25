import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createCacheLayer } from "./cache.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "suss-cache-"));
}

async function makeProjectWith(files: Record<string, string>): Promise<{
  project: Project;
  dir: string;
}> {
  const dir = await makeTempDir();
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { strict: true, target: 99, module: 99 },
  });
  for (const rel of Object.keys(files)) {
    project.addSourceFileAtPath(path.join(dir, rel));
  }
  return { project, dir };
}

const fakeSummary: BehavioralSummary = {
  kind: "library",
  location: { file: "x.ts", range: { start: 1, end: 1 }, exportName: "x" },
  identity: {
    name: "x",
    exportPath: ["x"],
    boundaryBinding: {
      transport: "in-process",
      semantics: { name: "function-call" },
      recognition: "test",
    },
  },
  inputs: [],
  transitions: [],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
};

describe("createCacheLayer", () => {
  it("misses when no manifest exists", async () => {
    const cacheDir = await makeTempDir();
    const { project } = await makeProjectWith({
      "a.ts": "export const a = 1;",
    });
    const cache = createCacheLayer(cacheDir);
    const result = await cache.tryHit({
      project,
      adapterPacksDigest: "test@1",
    });
    expect(result).toBeNull();
  });

  it("hits when project files are unchanged after a write", async () => {
    const cacheDir = await makeTempDir();
    const { project } = await makeProjectWith({
      "a.ts": "export const a = 1;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { project, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]);
    const result = await cache.tryHit(input);
    expect(result).toEqual([fakeSummary]);
  });

  it("misses when the adapter+packs digest changes", async () => {
    const cacheDir = await makeTempDir();
    const { project } = await makeProjectWith({
      "a.ts": "export const a = 1;",
    });
    const cache = createCacheLayer(cacheDir);
    await cache.write({ project, adapterPacksDigest: "test@1" }, [fakeSummary]);
    const result = await cache.tryHit({
      project,
      adapterPacksDigest: "test@2",
    });
    expect(result).toBeNull();
  });

  it("misses when a file is touched (mtime change)", async () => {
    const cacheDir = await makeTempDir();
    const { project, dir } = await makeProjectWith({
      "a.ts": "export const a = 1;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { project, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]);

    // Wait a bit (mtime resolution is ms; some FS round to seconds)
    await new Promise((r) => setTimeout(r, 20));
    // Re-write the file with the same content but new mtime
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

    const result = await cache.tryHit(input);
    expect(result).toBeNull();
  });

  it("returns a no-op layer when cacheDir is null", async () => {
    const { project } = await makeProjectWith({
      "a.ts": "export const a = 1;",
    });
    const cache = createCacheLayer(null);
    const input = { project, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]); // no-op
    const result = await cache.tryHit(input);
    expect(result).toBeNull();
  });
});
