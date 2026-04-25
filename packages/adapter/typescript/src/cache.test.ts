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

  describe("lookup", () => {
    it("returns kind=hit with the full summary list when fresh", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);
      const result = await cache.lookup(input);
      expect(result.kind).toBe("hit");
      if (result.kind === "hit") {
        expect(result.summaries).toEqual([fakeSummary]);
      }
    });

    it("returns kind=miss with a missReason when no manifest", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const result = await cache.lookup({
        project,
        adapterPacksDigest: "test@1",
      });
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("no-manifest");
    });

    it("returns kind=partial-hit with kept and filesToExtract on file change", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "a.ts": "export const a = 1;",
        "b.ts": "export const b = 2;",
      });
      const summaryA: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "a.ts") },
        identity: { ...fakeSummary.identity, name: "summaryA" },
      };
      const summaryB: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "b.ts") },
        identity: { ...fakeSummary.identity, name: "summaryB" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [summaryA, summaryB]);

      // Touch only a.ts — only summaryA gets invalidated; summaryB carries over.
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

      const result = await cache.lookup(input);
      expect(result.kind).toBe("partial-hit");
      if (result.kind === "partial-hit") {
        expect(result.kept).toEqual([summaryB]);
        expect(result.filesToExtract).toEqual([path.join(dir, "a.ts")]);
        expect(result.diagnostic.kind).toBe("partial-hit");
        expect(result.diagnostic.partial).toEqual({
          reusedSummaries: 1,
          filesToReExtract: 1,
          addedFiles: 0,
          removedFiles: 0,
          changedFiles: 1,
        });
      }
    });

    it("keeps library-kind summaries from unchanged files (closure dedups against them)", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "entry.ts": "export const e = 1;",
        "lib.ts": "export const l = 2;",
      });
      const entrySummary: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "entry.ts") },
        identity: { ...fakeSummary.identity, name: "entryFn" },
      };
      const librarySummary: BehavioralSummary = {
        ...fakeSummary,
        kind: "library",
        location: { ...fakeSummary.location, file: path.join(dir, "lib.ts") },
        identity: { ...fakeSummary.identity, name: "libFn" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [entrySummary, librarySummary]);

      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "entry.ts"), "export const e = 1;");

      const result = await cache.lookup(input);
      expect(result.kind).toBe("partial-hit");
      if (result.kind === "partial-hit") {
        // lib.ts is unchanged — the library summary's body description
        // is still valid, so we keep it. entry.ts goes to re-extract.
        expect(result.kept).toEqual([librarySummary]);
        expect(result.filesToExtract).toEqual([path.join(dir, "entry.ts")]);
      }
    });

    it("counts removed files and drops their summaries from the kept set", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "keep.ts": "export const k = 1;",
        "gone.ts": "export const g = 2;",
      });
      const keepSummary: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "keep.ts") },
        identity: { ...fakeSummary.identity, name: "keepFn" },
      };
      const goneSummary: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "gone.ts") },
        identity: { ...fakeSummary.identity, name: "goneFn" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [keepSummary, goneSummary]);

      // Remove gone.ts from the project + delete it on disk
      project.removeSourceFile(
        project.getSourceFileOrThrow(path.join(dir, "gone.ts")),
      );
      await fs.unlink(path.join(dir, "gone.ts"));

      const result = await cache.lookup(input);
      expect(result.kind).toBe("partial-hit");
      if (result.kind === "partial-hit") {
        expect(result.kept).toEqual([keepSummary]);
        expect(result.filesToExtract).toEqual([]);
        expect(result.diagnostic.partial).toEqual({
          reusedSummaries: 1,
          filesToReExtract: 0,
          addedFiles: 0,
          removedFiles: 1,
          changedFiles: 0,
        });
      }
    });

    it("returns added files in filesToExtract", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const summaryA: BehavioralSummary = {
        ...fakeSummary,
        kind: "handler",
        location: { ...fakeSummary.location, file: path.join(dir, "a.ts") },
        identity: { ...fakeSummary.identity, name: "summaryA" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [summaryA]);

      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 2;");
      project.addSourceFileAtPath(path.join(dir, "b.ts"));

      const result = await cache.lookup(input);
      expect(result.kind).toBe("partial-hit");
      if (result.kind === "partial-hit") {
        expect(result.kept).toEqual([summaryA]);
        expect(result.filesToExtract).toEqual([path.join(dir, "b.ts")]);
        expect(result.diagnostic.partial?.addedFiles).toBe(1);
      }
    });

    it("kind=miss when packs digest changes (no partial)", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      await cache.write({ project, adapterPacksDigest: "test@1" }, [
        fakeSummary,
      ]);
      const result = await cache.lookup({
        project,
        adapterPacksDigest: "test@2",
      });
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("packs-changed");
    });
  });
});
