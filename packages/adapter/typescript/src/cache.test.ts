import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { testCompilerOptions } from "@suss/test-project";

import { extractionConfigStamp } from "./adapter.js";
import { createCacheLayer, MAX_ENTRIES } from "./cache.js";

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
    compilerOptions: { ...testCompilerOptions },
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

  describe("one directory per key", () => {
    it("leaves another key's entry alone instead of overwriting it", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const first = { project, adapterPacksDigest: "test@1" };
      const second = { project, adapterPacksDigest: "test@2" };
      await cache.write(first, [fakeSummary]);
      await cache.write(second, []);

      expect(await cache.tryHit(first)).toEqual([fakeSummary]);
    });

    it("keeps only the most recently used keys", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      for (const digest of ["test@1", "test@2", "test@3"]) {
        await cache.write({ project, adapterPacksDigest: digest }, [
          fakeSummary,
        ]);
        // Eviction orders entries by timestamp, so the writes have to
        // land in different milliseconds for the order to mean anything.
        await new Promise((r) => setTimeout(r, 10));
      }

      expect((await fs.readdir(cacheDir)).length).toBe(MAX_ENTRIES);
      expect(
        await cache.tryHit({ project, adapterPacksDigest: "test@1" }),
      ).toBeNull();
      expect(
        await cache.tryHit({ project, adapterPacksDigest: "test@3" }),
      ).toEqual([fakeSummary]);
    });

    it("spares an entry a hit said was still wanted", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const oldest = { project, adapterPacksDigest: "test@1" };
      // Eviction orders entries by timestamp, so the steps have to land
      // in different milliseconds for the order to mean anything.
      const tick = () => new Promise((r) => setTimeout(r, 10));
      await cache.write(oldest, [fakeSummary]);
      await tick();
      await cache.write({ project, adapterPacksDigest: "test@2" }, [
        fakeSummary,
      ]);
      await tick();
      // Reading it is the only way to move it back to the front of the
      // eviction order, since a run that hits the cache never writes.
      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
      await tick();
      await cache.write({ project, adapterPacksDigest: "test@3" }, [
        fakeSummary,
      ]);

      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
    });

    it("clears out the single manifest older versions wrote", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const legacy = path.join(cacheDir, "manifest.json");
      await fs.writeFile(legacy, "{}");
      const cache = createCacheLayer(cacheDir);
      await cache.write({ project, adapterPacksDigest: "test@1" }, [
        fakeSummary,
      ]);

      await expect(fs.stat(legacy)).rejects.toThrow();
    });

    it("leaves a directory it did not write alone", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const theirs = path.join(cacheDir, "somebody-elses-work");
      await fs.mkdir(theirs);
      const cache = createCacheLayer(cacheDir);
      for (const digest of ["test@1", "test@2", "test@3"]) {
        await cache.write({ project, adapterPacksDigest: digest }, [
          fakeSummary,
        ]);
      }

      expect((await fs.stat(theirs)).isDirectory()).toBe(true);
    });

    it("says a key changed when another build has cached here", async () => {
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
      expect(result.diagnostic.missReason).toBe("key-changed");
    });

    it("says no manifest when nothing has cached here at all", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const result = await createCacheLayer(cacheDir).lookup({
        project,
        adapterPacksDigest: "test@1",
      });
      expect(result.diagnostic.missReason).toBe("no-manifest");
    });
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

    it("misses whole when one file in the include set changed", async () => {
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

      // Touching a.ts alone used to give back b.ts's summary and then
      // re-extract a.ts on its own. Walking a.ts by itself does not find
      // what walking the whole project finds, so summaryA came back
      // short or missing.
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

      const result = await cache.lookup(input);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when a file left the include set", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "keep.ts": "export const k = 1;",
        "gone.ts": "export const g = 2;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);

      project.removeSourceFile(
        project.getSourceFileOrThrow(path.join(dir, "gone.ts")),
      );
      await fs.unlink(path.join(dir, "gone.ts"));

      const result = await cache.lookup(input);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when a file joined the include set", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);

      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 2;");
      project.addSourceFileAtPath(path.join(dir, "b.ts"));

      const result = await cache.lookup(input);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when the packs digest changes", async () => {
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
      expect(result.diagnostic.missReason).toBe("key-changed");
    });
  });
});

describe("extractionConfigStamp", () => {
  it("separates runs that differ only in extraction config", () => {
    const on = extractionConfigStamp({});
    const off = extractionConfigStamp({ includeReachable: false });
    expect(on).not.toBe(off);

    const strict = extractionConfigStamp({
      extractorOptions: { gapHandling: "strict" },
    });
    expect(strict).not.toBe(on);
  });

  it("is stable for the default config", () => {
    expect(extractionConfigStamp({})).toBe(
      extractionConfigStamp({ includeReachable: true }),
    );
  });
});
