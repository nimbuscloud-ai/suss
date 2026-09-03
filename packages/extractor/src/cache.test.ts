import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CacheAttribution,
  createCacheLayer,
  MAX_ENTRIES,
} from "./cache.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "suss-cache-"));
}

async function writeFiles(
  files: Record<string, string>,
): Promise<{ dir: string; paths: string[] }> {
  const dir = await makeTempDir();
  const paths: string[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
    paths.push(abs);
  }
  return { dir, paths };
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
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    const result = await cache.tryHit({
      files: paths,
      adapterPacksDigest: "test@1",
    });
    expect(result).toBeNull();
  });

  it("hits when the file list is unchanged after a write", async () => {
    const cacheDir = await makeTempDir();
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]);
    const result = await cache.tryHit(input);
    expect(result).toEqual([fakeSummary]);
  });

  it("misses when the adapter+packs digest changes", async () => {
    const cacheDir = await makeTempDir();
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    await cache.write({ files: paths, adapterPacksDigest: "test@1" }, [
      fakeSummary,
    ]);
    const result = await cache.tryHit({
      files: paths,
      adapterPacksDigest: "test@2",
    });
    expect(result).toBeNull();
  });

  it("misses when a file is touched (mtime change)", async () => {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]);

    // Wait a bit (mtime resolution is ms; some FS round to seconds)
    await new Promise((r) => setTimeout(r, 20));
    // Re-write the file with the same content but new mtime
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

    const result = await cache.tryHit(input);
    expect(result).toBeNull();
  });

  it("returns a no-op layer when cacheDir is null", async () => {
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(null);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]); // no-op
    const result = await cache.tryHit(input);
    expect(result).toBeNull();
  });

  describe("one directory per key", () => {
    it("leaves another key's entry alone instead of overwriting it", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const first = { files: paths, adapterPacksDigest: "test@1" };
      const second = { files: paths, adapterPacksDigest: "test@2" };
      await cache.write(first, [fakeSummary]);
      await cache.write(second, []);

      expect(await cache.tryHit(first)).toEqual([fakeSummary]);
    });

    it("keeps only the most recently used keys", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      for (const digest of ["test@1", "test@2", "test@3"]) {
        await cache.write({ files: paths, adapterPacksDigest: digest }, [
          fakeSummary,
        ]);
        // Eviction orders entries by timestamp, so the writes have to
        // land in different milliseconds for the order to mean anything.
        await new Promise((r) => setTimeout(r, 10));
      }

      expect((await fs.readdir(cacheDir)).length).toBe(MAX_ENTRIES);
      expect(
        await cache.tryHit({ files: paths, adapterPacksDigest: "test@1" }),
      ).toBeNull();
      expect(
        await cache.tryHit({ files: paths, adapterPacksDigest: "test@3" }),
      ).toEqual([fakeSummary]);
    });

    it("spares an entry a hit said was still wanted", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const oldest = { files: paths, adapterPacksDigest: "test@1" };
      // Eviction orders entries by timestamp, so the steps have to land
      // in different milliseconds for the order to mean anything.
      const tick = () => new Promise((r) => setTimeout(r, 10));
      await cache.write(oldest, [fakeSummary]);
      await tick();
      await cache.write({ files: paths, adapterPacksDigest: "test@2" }, [
        fakeSummary,
      ]);
      await tick();
      // Reading it is the only way to move it back to the front of the
      // eviction order, since a run that hits the cache never writes.
      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
      await tick();
      await cache.write({ files: paths, adapterPacksDigest: "test@3" }, [
        fakeSummary,
      ]);

      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
    });

    it("clears out the single manifest older versions wrote", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const legacy = path.join(cacheDir, "manifest.json");
      await fs.writeFile(legacy, "{}");
      const cache = createCacheLayer(cacheDir);
      await cache.write({ files: paths, adapterPacksDigest: "test@1" }, [
        fakeSummary,
      ]);

      await expect(fs.stat(legacy)).rejects.toThrow();
    });

    it("leaves a directory it did not write alone", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const theirs = path.join(cacheDir, "somebody-elses-work");
      await fs.mkdir(theirs);
      const cache = createCacheLayer(cacheDir);
      for (const digest of ["test@1", "test@2", "test@3"]) {
        await cache.write({ files: paths, adapterPacksDigest: digest }, [
          fakeSummary,
        ]);
      }

      expect((await fs.stat(theirs)).isDirectory()).toBe(true);
    });

    it("says a key changed when another build has cached here", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      await cache.write({ files: paths, adapterPacksDigest: "test@1" }, [
        fakeSummary,
      ]);

      const result = await cache.lookup({
        files: paths,
        adapterPacksDigest: "test@2",
      });
      expect(result.diagnostic.missReason).toBe("key-changed");
    });

    it("says no manifest when nothing has cached here at all", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const result = await createCacheLayer(cacheDir).lookup({
        files: paths,
        adapterPacksDigest: "test@1",
      });
      expect(result.diagnostic.missReason).toBe("no-manifest");
    });
  });

  describe("lookup", () => {
    it("returns kind=hit with the full summary list when fresh", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const input = { files: paths, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);
      const result = await cache.lookup(input);
      expect(result.kind).toBe("hit");
      if (result.kind === "hit") {
        expect(result.summaries).toEqual([fakeSummary]);
      }
    });

    it("returns kind=miss with a missReason when no manifest", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const result = await cache.lookup({
        files: paths,
        adapterPacksDigest: "test@1",
      });
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("no-manifest");
    });

    it("misses whole when one file in the include set changed", async () => {
      const cacheDir = await makeTempDir();
      const { dir, paths } = await writeFiles({
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
      const input = { files: paths, adapterPacksDigest: "test@1" };
      await cache.write(input, [summaryA, summaryB]);

      // Touching a.ts alone used to re-extract it by itself, which finds
      // less than a whole-project walk does, so summaryA came back short
      // or missing.
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

      const result = await cache.lookup(input);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when a file left the include set", async () => {
      const cacheDir = await makeTempDir();
      const { dir, paths } = await writeFiles({
        "keep.ts": "export const k = 1;",
        "gone.ts": "export const g = 2;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { files: paths, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);

      const gonePath = path.join(dir, "gone.ts");
      await fs.unlink(gonePath);
      const shrunk = { ...input, files: paths.filter((p) => p !== gonePath) };

      const result = await cache.lookup(shrunk);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when a file joined the include set", async () => {
      const cacheDir = await makeTempDir();
      const { dir, paths } = await writeFiles({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { files: paths, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);

      const bPath = path.join(dir, "b.ts");
      await fs.writeFile(bPath, "export const b = 2;");
      const grown = { ...input, files: [...paths, bPath] };

      const result = await cache.lookup(grown);
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("files-changed");
    });

    it("misses when the packs digest changes", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      await cache.write({ files: paths, adapterPacksDigest: "test@1" }, [
        fakeSummary,
      ]);
      const result = await cache.lookup({
        files: paths,
        adapterPacksDigest: "test@2",
      });
      expect(result.kind).toBe("miss");
      expect(result.diagnostic.missReason).toBe("key-changed");
    });
  });
});

describe("per-file plan", () => {
  function summaryIn(file: string, name: string): BehavioralSummary {
    return {
      ...fakeSummary,
      location: { ...fakeSummary.location, file },
      identity: { ...fakeSummary.identity, name },
    };
  }

  function attributionFor(
    dir: string,
    summaries: { summary: BehavioralSummary; owners: string[] }[],
    roots: {
      file: string;
      deps?: string[];
      cacheable?: boolean;
      claims?: { key: string; pack: string }[];
    }[],
  ): CacheAttribution {
    return {
      roots: roots.map((r) => ({
        path: path.join(dir, r.file),
        cacheable: r.cacheable ?? true,
        deps: (r.deps ?? []).map((d) => path.join(dir, d)),
        claims: r.claims ?? [],
        meta: undefined,
        packs: [],
      })),
      owners: summaries.map((s) => s.owners.map((o) => path.join(dir, o))),
    };
  }

  async function writeTwoFileEntry(files?: Record<string, string>) {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles(
      files ?? {
        "a.ts": "export const a = 1;",
        "b.ts": "export const b = 2;",
      },
    );
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const summaryA = summaryIn(path.join(dir, "a.ts"), "summaryA");
    const summaryB = summaryIn(path.join(dir, "b.ts"), "summaryB");
    await cache.write(
      input,
      [summaryA, summaryB],
      attributionFor(
        dir,
        [
          { summary: summaryA, owners: ["a.ts"] },
          { summary: summaryB, owners: ["b.ts"] },
        ],
        // a.ts's walk read b.ts; b.ts read only itself.
        [{ file: "a.ts", deps: ["b.ts"] }, { file: "b.ts" }],
      ),
    );
    return { cache, input, dir, summaryA, summaryB };
  }

  it("returns null for an entry written without attribution", async () => {
    const cacheDir = await makeTempDir();
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    await cache.write(input, [fakeSummary]);

    expect(await cache.plan(input)).toBeNull();
  });

  it("counts a touched file as unchanged once its hash matches", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

    const plan = await cache.plan(input);
    expect(plan).not.toBeNull();
    expect(plan?.changed.size).toBe(0);
    expect(plan?.removed.size).toBe(0);
  });

  it("catches a same-size edit once the mtime moves", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    // Wait a bit (mtime resolution is ms; some FS round to seconds)
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 7;");

    const plan = await cache.plan(input);
    expect(plan?.changed).toEqual(new Set([path.join(dir, "b.ts")]));
  });

  it("keeps the file that did not change and drops the one that did", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");

    const plan = await cache.plan(input);
    expect(plan?.changed).toEqual(new Set([path.join(dir, "b.ts")]));
    // a.ts itself is untouched, but its walk read b.ts.
    expect(plan?.validRoots).toEqual(new Set());
  });

  it("invalidates the reader when a recorded dependency changes", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 9000;");

    const plan = await cache.plan(input);
    expect(plan?.validRoots).toEqual(new Set([path.join(dir, "b.ts")]));
    const reuse = plan?.reuse(plan.validRoots);
    expect(reuse?.summaries.map((s) => s.identity.name)).toEqual(["summaryB"]);
  });

  it("invalidates the reader when a recorded dependency is deleted", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    const bPath = path.join(dir, "b.ts");
    await fs.unlink(bPath);
    const shrunk = { ...input, files: input.files.filter((p) => p !== bPath) };

    const plan = await cache.plan(shrunk);
    expect(plan?.removed).toEqual(new Set([bPath]));
    expect(plan?.validRoots).toEqual(new Set());
  });

  it("never reuses a file that declined caching", async () => {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const summaryA = summaryIn(path.join(dir, "a.ts"), "summaryA");
    await cache.write(
      input,
      [summaryA],
      attributionFor(
        dir,
        [{ summary: summaryA, owners: ["a.ts"] }],
        [{ file: "a.ts", cacheable: false }, { file: "b.ts" }],
      ),
    );
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");

    const plan = await cache.plan(input);
    expect(plan?.rootsDeclined).toBe(1);
    expect(plan?.validRoots).toEqual(new Set());
  });

  it("never reuses a run-level summary on a partial plan", async () => {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const summaryA = summaryIn(path.join(dir, "a.ts"), "summaryA");
    const marker = summaryIn(path.join(dir, "a.ts"), "marker");
    await cache.write(
      input,
      [summaryA, marker],
      attributionFor(
        dir,
        [
          { summary: summaryA, owners: ["a.ts"] },
          // Run-level: recomputed by every partial run.
          { summary: marker, owners: [] },
        ],
        [{ file: "a.ts" }, { file: "b.ts" }],
      ),
    );
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");

    const plan = await cache.plan(input);
    const reuse = plan?.reuse(plan.validRoots);
    expect(reuse?.summaries.map((s) => s.identity.name)).toEqual(["summaryA"]);
  });

  it("keeps a shared summary alive while any owner survives", async () => {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
      "shared.ts": "export const s = 3;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const shared = summaryIn(path.join(dir, "shared.ts"), "shared");
    await cache.write(
      input,
      [shared],
      attributionFor(
        dir,
        [{ summary: shared, owners: ["a.ts", "b.ts"] }],
        [
          { file: "a.ts", deps: ["shared.ts"] },
          { file: "b.ts", deps: ["shared.ts"] },
          { file: "shared.ts" },
        ],
      ),
    );
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 9000;");

    const plan = await cache.plan(input);
    const reuse = plan?.reuse(plan.validRoots);
    expect(reuse?.summaries.map((s) => s.identity.name)).toEqual(["shared"]);
    // Only the surviving owner remains on the reused record.
    expect(reuse?.owners).toEqual([[path.join(dir, "b.ts")]]);
  });

  it("hands back stored claims through the plan's records", async () => {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const summaryA = summaryIn(path.join(dir, "a.ts"), "summaryA");
    const claims = [{ key: "a.ts:0-10-handler", pack: "test-pack" }];
    await cache.write(
      input,
      [summaryA],
      attributionFor(
        dir,
        [{ summary: summaryA, owners: ["a.ts"] }],
        [{ file: "a.ts", claims }],
      ),
    );

    const plan = await cache.plan(input);
    expect(plan?.roots.get(path.join(dir, "a.ts"))?.claims).toEqual(claims);
  });

  it("round-trips attribution, so a touch refresh keeps the layer", async () => {
    const { cache, input, dir } = await writeTwoFileEntry();
    const plan = await cache.plan(input);
    expect(plan).not.toBeNull();
    if (plan === null) {
      return;
    }
    await cache.write(input, plan.allSummaries(), plan.attribution());

    const again = await cache.plan(input);
    expect(again?.roots.get(path.join(dir, "a.ts"))?.deps).toEqual([
      path.join(dir, "b.ts"),
    ]);
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");
    const after = await cache.plan(input);
    expect(after?.validRoots).toEqual(new Set());
  });
});
