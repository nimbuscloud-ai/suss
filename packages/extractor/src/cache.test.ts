import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type CacheAttribution,
  createCacheLayer,
  ownersWhereWritten,
} from "./cache.js";
import { CACHE_BUDGET_ENV } from "./cacheEviction.js";

import type {
  BehavioralSummary,
  Effect,
  Predicate,
  Transition,
} from "@suss/behavioral-ir";

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

/** Bytes under a directory. */
function sizeOf(dir: string): number {
  let bytes = 0;
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? sizeOf(full) : fsSync.statSync(full).size;
  }
  return bytes;
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

  describe("a file that changes while a run reads it", () => {
    /**
     * Keeps `Date.now()` at the moment of the call, so however long the
     * test runs, no time has passed. With `file`, its stats report an mtime
     * and ctime of `changedAt`, as a file system whose clock has not ticked
     * would. Returns the undo.
     */
    function holdClock(file?: string, changedAt = Date.now()): () => void {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const realStat = fs.stat.bind(fs);
      const stat = vi.spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        const found = await realStat(target);
        if (String(target) === file) {
          found.mtimeMs = changedAt;
          found.ctimeMs = changedAt;
        }
        return found;
      }) as typeof fs.stat);
      return () => {
        stat.mockRestore();
        vi.useRealTimers();
      };
    }

    it("is read again by the next run", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const run = { files: paths, adapterPacksDigest: "test@1" };

      await cache.lookup(run);
      await fs.writeFile(paths[0] ?? "", "export const a = 22;");
      await cache.write(run, [fakeSummary]);

      expect((await cache.lookup({ ...run })).kind).toBe("miss");
    });

    it("is read again when a write in the same clock tick kept its stamp", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const file = paths[0] ?? "";
      const release = holdClock(file);
      try {
        const cache = createCacheLayer(cacheDir);
        const run = { files: paths, adapterPacksDigest: "test@1" };

        await cache.lookup(run);
        await fs.writeFile(file, "export const a = 2;");
        await cache.write(run, [fakeSummary]);

        expect((await cache.lookup({ ...run })).kind).toBe("miss");
      } finally {
        release();
      }
    });

    it("is read again when the change put the old mtime back", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const file = paths[0] ?? "";
      const before = await fs.stat(file);
      const release = holdClock();
      try {
        const cache = createCacheLayer(cacheDir);
        const run = { files: paths, adapterPacksDigest: "test@1" };

        await cache.lookup(run);
        await fs.writeFile(file, "export const a = 2;");
        await fs.utimes(file, before.atime, before.mtime);
        await cache.write(run, [fakeSummary]);

        expect((await cache.lookup({ ...run })).kind).toBe("miss");
      } finally {
        release();
      }
    });

    it("trusts the stamp of a file last changed well before the run", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const file = paths[0] ?? "";
      const release = holdClock(file, Date.now() - 60_000);
      try {
        const cache = createCacheLayer(cacheDir);
        const run = { files: paths, adapterPacksDigest: "test@1" };
        await cache.lookup(run);
        await cache.write(run, [fakeSummary]);

        const reads = vi.spyOn(fs, "readFile");
        try {
          expect((await cache.lookup({ ...run })).kind).toBe("hit");
          expect(reads.mock.calls.map(([p]) => String(p))).not.toContain(file);
        } finally {
          reads.mockRestore();
        }
      } finally {
        release();
      }
    });

    it("leaves a config file that changed during the run to be read again", async () => {
      const cacheDir = await makeTempDir();
      const { dir, paths } = await writeFiles({
        "a.ts": "export const a = 1;",
        "tsconfig.json": "{}",
      });
      const configPath = path.join(dir, "tsconfig.json");
      const cache = createCacheLayer(cacheDir);
      const run = {
        files: paths.filter((p) => p !== configPath),
        adapterPacksDigest: "test@1",
        configPath,
      };

      await cache.lookup(run);
      await fs.writeFile(configPath, '{"compilerOptions":{}}');
      await cache.write(run, [fakeSummary]);

      const next = await cache.lookup({ ...run });
      expect(next.kind === "miss" && next.diagnostic.missReason).toBe(
        "config-changed",
      );
    });

    it("still hits when the files were written moments before the run", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      const run = { files: paths, adapterPacksDigest: "test@1" };

      await cache.lookup(run);
      await cache.write(run, [fakeSummary]);

      expect((await cache.lookup({ ...run })).kind).toBe("hit");
    });
  });

  it("keeps the directory it writes out of version control", async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, "packages", "orders", ".suss", "cache");
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const input = { files: paths, adapterPacksDigest: "test@1" };

    await createCacheLayer(cacheDir).write(input, [fakeSummary]);

    expect(await fs.readFile(path.join(cacheDir, ".gitignore"), "utf8")).toBe(
      "*\n",
    );
  });

  it("keeps a .gitignore the cache directory already has, through eviction", async () => {
    const cacheDir = await makeTempDir();
    await fs.writeFile(path.join(cacheDir, ".gitignore"), "manifest.json\n");
    const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
    const cache = createCacheLayer(cacheDir);
    vi.stubEnv(CACHE_BUDGET_ENV, "0.000001");

    for (let index = 0; index < 3; index += 1) {
      await cache.write({ files: paths, adapterPacksDigest: `test@${index}` }, [
        fakeSummary,
      ]);
    }
    vi.unstubAllEnvs();

    expect(await fs.readFile(path.join(cacheDir, ".gitignore"), "utf8")).toBe(
      "manifest.json\n",
    );
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

    /** A budget in megabytes that fits `count` entries the size of the one `cacheDir` has. */
    async function budgetFor(cacheDir: string, count: number): Promise<string> {
      const [entry] = (await fs.readdir(cacheDir)).filter((name) =>
        name.startsWith("key-"),
      );
      const bytes = sizeOf(path.join(cacheDir, entry ?? ""));
      return String(((count + 0.5) * bytes) / 1024 ** 2);
    }

    it("keeps only the most recently used keys that fit the budget", async () => {
      const cacheDir = await makeTempDir();
      const { paths } = await writeFiles({ "a.ts": "export const a = 1;" });
      const cache = createCacheLayer(cacheDir);
      for (const digest of ["test@1", "test@2", "test@3"]) {
        await cache.write({ files: paths, adapterPacksDigest: digest }, [
          fakeSummary,
        ]);
        if (digest === "test@1") {
          vi.stubEnv(CACHE_BUDGET_ENV, await budgetFor(cacheDir, 2));
        }
        // Eviction orders entries by timestamp, so the writes have to
        // land in different milliseconds for the order to mean anything.
        await new Promise((r) => setTimeout(r, 10));
      }
      vi.unstubAllEnvs();

      const entries = (await fs.readdir(cacheDir)).filter((name) =>
        name.startsWith("key-"),
      );
      expect(entries).toHaveLength(2);
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
      const middle = { files: paths, adapterPacksDigest: "test@2" };
      await cache.write(oldest, [fakeSummary]);
      vi.stubEnv(CACHE_BUDGET_ENV, await budgetFor(cacheDir, 2));
      await tick();
      await cache.write(middle, [fakeSummary]);
      await tick();
      // Reading it is the only way to move it back to the front of the
      // eviction order, since a run that hits the cache never writes.
      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
      await tick();
      await cache.write({ files: paths, adapterPacksDigest: "test@3" }, [
        fakeSummary,
      ]);
      vi.unstubAllEnvs();

      expect(await cache.tryHit(oldest)).toEqual([fakeSummary]);
      expect(await cache.tryHit(middle)).toBeNull();
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
    return { cache, cacheDir, input, dir, summaryA, summaryB };
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

  it("counts a file edited during the last run as changed, and keeps the rest", async () => {
    const { cache, input, dir, summaryA, summaryB } = await writeTwoFileEntry();
    const run = { ...input };
    await cache.lookup(run);
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 7777;");
    await cache.write(
      run,
      [summaryA, summaryB],
      attributionFor(
        dir,
        [
          { summary: summaryA, owners: ["a.ts"] },
          { summary: summaryB, owners: ["b.ts"] },
        ],
        [{ file: "a.ts" }, { file: "b.ts" }],
      ),
    );

    const plan = await cache.plan({ ...input });
    expect(plan?.changed).toEqual(new Set([path.join(dir, "b.ts")]));
    expect(plan?.validRoots).toEqual(new Set([path.join(dir, "a.ts")]));
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

  describe("resolved imports", () => {
    async function writeImportEntry() {
      const { cache, input, dir, summaryA, summaryB } =
        await writeTwoFileEntry();
      const base = attributionFor(
        dir,
        [
          { summary: summaryA, owners: ["a.ts"] },
          { summary: summaryB, owners: ["b.ts"] },
        ],
        [{ file: "a.ts", deps: ["b.ts"] }, { file: "b.ts" }],
      );
      const [rootA, rootB] = base.roots;
      if (rootA === undefined || rootB === undefined) {
        throw new Error("expected two roots");
      }
      await cache.write(input, [summaryA, summaryB], {
        ...base,
        roots: [{ ...rootA, imports: [path.join(dir, "b.ts")] }, rootB],
      });
      return { cache, input, dir };
    }

    it("hands back the imports of every file whose content is unchanged", async () => {
      const { cache, input, dir } = await writeImportEntry();
      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");

      const plan = await cache.plan(input);
      expect(plan?.resolvedImports).toEqual(
        new Map([[path.join(dir, "a.ts"), [path.join(dir, "b.ts")]]]),
      );
    });

    it("hands back no imports once a file joins the set", async () => {
      const { cache, input, dir } = await writeImportEntry();
      const cPath = path.join(dir, "c.ts");
      await fs.writeFile(cPath, "export const c = 3;");

      const plan = await cache.plan({
        ...input,
        files: [...input.files, cPath],
      });
      expect(plan?.resolvedImports.size).toBe(0);
    });
  });

  describe("unit records", () => {
    async function writeUnitEntry() {
      const { cache, input, dir, summaryA, summaryB } =
        await writeTwoFileEntry();
      const base = attributionFor(
        dir,
        [
          { summary: summaryA, owners: ["a.ts"] },
          { summary: summaryB, owners: ["b.ts"] },
        ],
        [{ file: "a.ts", deps: ["b.ts"] }, { file: "b.ts" }],
      );
      // The body in a.ts called into b.ts; the body in b.ts read nothing else.
      await cache.write(input, [summaryA, summaryB], {
        ...base,
        units: [
          {
            key: "a.ts:0-10",
            file: path.join(dir, "a.ts"),
            deps: [path.join(dir, "b.ts")],
            data: { calls: ["b.ts:0-10"] },
          },
          {
            key: "b.ts:0-10",
            file: path.join(dir, "b.ts"),
            deps: [],
            data: { calls: [] },
          },
        ],
      });
      return { cache, input, dir };
    }

    it("hands every record back while nothing it read has changed", async () => {
      const { cache, input } = await writeUnitEntry();

      const plan = await cache.plan(input);
      expect([...(plan?.validUnits.keys() ?? [])]).toEqual([
        "a.ts:0-10",
        "b.ts:0-10",
      ]);
      expect(plan?.validUnits.get("a.ts:0-10")?.data).toEqual({
        calls: ["b.ts:0-10"],
      });
    });

    it("drops the records that read an edited file and keeps the rest", async () => {
      const { cache, input, dir } = await writeUnitEntry();
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 9000;");

      const plan = await cache.plan(input);
      expect([...(plan?.validUnits.keys() ?? [])]).toEqual(["b.ts:0-10"]);
    });

    it("drops a record whose file or dependency was deleted", async () => {
      const { cache, input, dir } = await writeUnitEntry();
      const bPath = path.join(dir, "b.ts");
      await fs.unlink(bPath);
      const shrunk = {
        ...input,
        files: input.files.filter((p) => p !== bPath),
      };

      const plan = await cache.plan(shrunk);
      expect(plan?.validUnits.size).toBe(0);
    });

    it("keeps the records through a touch refresh", async () => {
      const { cache, input } = await writeUnitEntry();
      const plan = await cache.plan(input);
      if (plan === null) {
        throw new Error("expected a plan");
      }
      await cache.write(input, plan.allSummaries(), plan.attribution());

      const again = await cache.plan(input);
      expect(again?.validUnits.size).toBe(2);
    });
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

  describe("reading the manifest", () => {
    function manifestReads(reads: { mock: { calls: unknown[][] } }): number {
      return reads.mock.calls.filter(([file]) =>
        String(file).endsWith("manifest.json"),
      ).length;
    }

    it("parses it once for the lookup, the plan and the write of one run", async () => {
      const { cache, input, dir } = await writeTwoFileEntry();
      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");
      const reads = vi.spyOn(fsSync, "openSync");
      try {
        expect((await cache.lookup(input)).kind).toBe("miss");
        const plan = await cache.plan(input);
        if (plan === null) {
          throw new Error("expected a plan");
        }
        await cache.write(input, plan.allSummaries(), plan.attribution());
        expect(manifestReads(reads)).toBe(1);
      } finally {
        reads.mockRestore();
      }
    });

    it("reads it again when another process wrote the entry after the lookup", async () => {
      const { cache, cacheDir, input, dir, summaryA } =
        await writeTwoFileEntry();
      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");
      expect((await cache.lookup(input)).kind).toBe("miss");

      const other = createCacheLayer(cacheDir);
      await other.write(
        input,
        [summaryA],
        attributionFor(
          dir,
          [{ summary: summaryA, owners: ["a.ts"] }],
          [{ file: "a.ts" }, { file: "b.ts" }],
        ),
      );

      const plan = await cache.plan(input);
      expect(plan?.changed.size).toBe(0);
      expect(plan?.allSummaries().map((s) => s.identity.name)).toEqual([
        "summaryA",
      ]);
    });

    it("reads it again at the start of the next run", async () => {
      const { cache, input, dir } = await writeTwoFileEntry();
      await fs.writeFile(path.join(dir, "b.ts"), "export const b = 3000;");
      await cache.lookup(input);
      const reads = vi.spyOn(fsSync, "openSync");
      try {
        await cache.lookup(input);
        expect(manifestReads(reads)).toBe(1);
      } finally {
        reads.mockRestore();
      }
    });
  });
});

describe("the store of shards", () => {
  const ordersTable: Effect = {
    type: "interaction",
    binding: {
      transport: "postgresql",
      semantics: {
        name: "storage",
        storageSystem: "postgresql",
        scope: "default",
        container: "orders",
        accessPath: null,
      },
      recognition: "pg",
    },
    callee: "db.query",
    interaction: { class: "storage-access", kind: "read", fields: ["id"] },
  };
  const audit: Effect = {
    type: "invocation",
    callee: "audit",
    args: [],
    async: false,
  };
  const signedIn: Predicate = {
    type: "opaque",
    sourceText: "user !== null",
    reason: "complexExpression",
  };

  function transition(id: string, effects: Effect[]): Transition {
    return {
      id,
      conditions: [signedIn],
      output: { type: "void" },
      effects,
      location: { start: 1, end: 1 },
      isDefault: false,
    };
  }

  function unitIn(
    file: string,
    name: string,
    transitions: Transition[] = [],
  ): BehavioralSummary {
    return {
      ...fakeSummary,
      location: { ...fakeSummary.location, file },
      identity: { ...fakeSummary.identity, name },
      transitions,
      gaps: [
        {
          type: "unfollowedCall",
          conditions: [signedIn],
          consequence: "unknown",
          description: "audit",
        },
      ],
    };
  }

  async function storeOf(files: Record<string, string>) {
    const cacheDir = await makeTempDir();
    const { dir, paths } = await writeFiles(files);
    const cache = createCacheLayer<{ prefixes: string[] }>(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    const write = async (summaries: BehavioralSummary[]) => {
      await cache.write(input, summaries, {
        roots: paths.map((p) => ({
          path: p,
          cacheable: true,
          deps: [],
          claims: [],
          meta: { prefixes: [`mounted at ${path.basename(p)}`] },
          packs: [],
        })),
        owners: summaries.map((s) => [s.location.file]),
      });
    };
    const entryDir = async (): Promise<string> => {
      const [entry] = (await fs.readdir(cacheDir)).filter((name) =>
        name.startsWith("key-"),
      );
      return path.join(cacheDir, entry ?? "");
    };
    const storedIn = async (kind: string): Promise<string[]> => {
      const root = path.join(await entryDir(), kind);
      const found: string[] = [];
      for (const prefix of await fs.readdir(root)) {
        for (const name of await fs.readdir(path.join(root, prefix))) {
          found.push(name);
        }
      }
      return found.sort();
    };
    // A run outside git has the one checkout folder.
    const checkoutDir = async (): Promise<string> =>
      path.join(await entryDir(), "checkouts", "local");
    const index = async () =>
      JSON.parse(
        await fs.readFile(path.join(await checkoutDir(), "index.json"), "utf8"),
      );
    return {
      cache,
      input,
      dir,
      write,
      entryDir,
      checkoutDir,
      shardFiles: () => storedIn("shards"),
      recordFiles: () => storedIn("records"),
      index,
    };
  }

  it("keeps each file's units in a shard and its record in a file of its own, and neither in the manifest", async () => {
    const store = await storeOf({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const a = path.join(store.dir, "a.ts");
    const b = path.join(store.dir, "b.ts");
    await store.write([
      unitIn(a, "first", [transition("t1", [ordersTable])]),
      unitIn(b, "second"),
    ]);

    expect(await store.shardFiles()).toHaveLength(2);
    expect(await store.recordFiles()).toHaveLength(2);
    const manifest = await fs.readFile(
      path.join(await store.checkoutDir(), "manifest.json"),
      "utf8",
    );
    expect(manifest).not.toContain("first");
    expect(manifest).not.toContain("mounted at");

    const plan = await store.cache.plan(store.input);
    expect(plan?.roots.get(a)?.meta).toEqual({ prefixes: ["mounted at a.ts"] });
  });

  it("gives back the summaries in the order they were written", async () => {
    const store = await storeOf({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const a = path.join(store.dir, "a.ts");
    const b = path.join(store.dir, "b.ts");
    const written = [unitIn(b, "one"), unitIn(a, "two"), unitIn(b, "three")];
    await store.write(written);

    const hit = await store.cache.tryHit(store.input);
    expect(hit).toEqual(written);
  });

  it("writes a repeated effect once and gives back a copy for each transition", async () => {
    const store = await storeOf({ "a.ts": "export const a = 1;" });
    const a = path.join(store.dir, "a.ts");
    const written = unitIn(a, "twice", [
      transition("t1", [ordersTable, audit]),
      transition("t2", [structuredClone(ordersTable), audit]),
    ]);
    await store.write([written]);

    const [shard] = await store.shardFiles();
    const root = path.join(await store.entryDir(), "shards");
    const text = await fs.readFile(
      path.join(root, shard?.slice(0, 2) ?? "", shard ?? ""),
      "utf8",
    );
    expect(text.split('"db.query"')).toHaveLength(2);
    expect(text.split('"user !== null"')).toHaveLength(2);

    const [read] = (await store.cache.tryHit(store.input)) ?? [];
    expect(read).toEqual(written);
    const [first, second] = read?.transitions ?? [];
    expect(first?.effects[0]).not.toBe(second?.effects[0]);
    expect(first?.conditions[0]).not.toBe(read?.gaps[0]?.conditions[0]);
  });

  it("rewrites only the shard of a changed file, and drops a stale one a write later", async () => {
    const store = await storeOf({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const a = path.join(store.dir, "a.ts");
    const b = path.join(store.dir, "b.ts");
    const shardOf = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (await store.index()).files.map(([file, id]: [string, string]) => [
          file,
          `${id}.json`,
        ]),
      );
    await store.write([unitIn(a, "first"), unitIn(b, "second")]);
    const first = await shardOf();

    await store.write([unitIn(a, "first"), unitIn(b, "second, edited")]);
    const second = await shardOf();
    expect(second[a]).toBe(first[a]);
    expect(second[b]).not.toBe(first[b]);
    // A reader that opened the previous manifest can still read its shards.
    expect(await store.shardFiles()).toEqual(
      [first[a], first[b], second[b]].sort(),
    );

    await store.write([unitIn(a, "first"), unitIn(b, "second, edited")]);
    expect(await store.shardFiles()).toEqual([second[a], second[b]].sort());
  });

  it("serves a hit without opening a record, and plans only with every record", async () => {
    const store = await storeOf({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const written = [unitIn(path.join(store.dir, "a.ts"), "first")];
    await store.write(written);
    expect(await store.shardFiles()).toHaveLength(1);
    await fs.rm(path.join(await store.entryDir(), "records"), {
      recursive: true,
    });

    expect(await store.cache.tryHit(store.input)).toEqual(written);
    expect(await store.cache.plan(store.input)).toBeNull();
  });

  it("writes one record for walked files whose meta is the same", async () => {
    const cacheDir = await makeTempDir();
    const { paths } = await writeFiles({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    const cache = createCacheLayer(cacheDir);
    const input = { files: paths, adapterPacksDigest: "test@1" };
    await cache.write(input, [], {
      roots: paths.map((p) => ({
        path: p,
        cacheable: true,
        deps: [],
        claims: [],
        meta: { mountPrefixes: {} },
        packs: [],
      })),
      owners: [],
    });

    const [entry] = (await fs.readdir(cacheDir)).filter((name) =>
      name.startsWith("key-"),
    );
    const records = await fs.readdir(
      path.join(cacheDir, entry ?? "", "records"),
      { recursive: true },
    );
    expect(records.filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const plan = await cache.plan(input);
    const [first, second] = paths.map((p) => plan?.roots.get(p)?.meta);
    expect(first).toEqual({ mountPrefixes: {} });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("misses when a shard says it is another file", async () => {
    const store = await storeOf({ "a.ts": "export const a = 1;" });
    await store.write([unitIn(path.join(store.dir, "a.ts"), "first")]);
    const [shard] = await store.shardFiles();
    await fs.writeFile(
      path.join(
        await store.entryDir(),
        "shards",
        shard?.slice(0, 2) ?? "",
        shard ?? "",
      ),
      JSON.stringify({ file: "elsewhere.ts", intern: [], units: [] }),
    );

    expect((await store.cache.lookup(store.input)).kind).toBe("miss");
  });

  it("misses when the manifest counts a summary no shard has", async () => {
    const store = await storeOf({ "a.ts": "export const a = 1;" });
    await store.write([unitIn(path.join(store.dir, "a.ts"), "first")]);
    const manifestFile = path.join(await store.checkoutDir(), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.summaryCount += 1;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));

    expect((await store.cache.lookup(store.input)).kind).toBe("miss");
  });

  it("leaves out of the index a boundary whose protocol this build does not know", async () => {
    const store = await storeOf({ "a.ts": "export const a = 1;" });
    const unknown = {
      ...ordersTable,
      binding: {
        ...ordersTable.binding,
        semantics: { name: "carrier-pigeon" },
      },
    } as unknown as Effect;
    await store.write([
      unitIn(path.join(store.dir, "a.ts"), "sender", [
        transition("t1", [unknown]),
      ]),
    ]);

    const index = await store.index();
    expect(Object.keys(index.boundaries)).not.toContain(
      expect.stringContaining("pigeon"),
    );
    expect(await store.cache.tryHit(store.input)).toHaveLength(1);
  });

  it("owns a summary by the walked file it is written in", () => {
    const owners = ownersWhereWritten(
      [unitIn("app/a.py", "walked"), unitIn("lib/b.py", "library")],
      (file) => (file === "app/a.py" ? "/work/app/a.py" : undefined),
    );

    expect(owners).toEqual([["/work/app/a.py"], []]);
  });

  it("misses instead of serving an entry whose shard is gone", async () => {
    const store = await storeOf({ "a.ts": "export const a = 1;" });
    await store.write([unitIn(path.join(store.dir, "a.ts"), "first")]);
    await fs.rm(path.join(await store.entryDir(), "shards"), {
      recursive: true,
    });

    expect((await store.cache.lookup(store.input)).kind).toBe("miss");
    expect(await store.cache.plan(store.input)).toBeNull();
  });

  it("indexes the boundaries and calls in each shard, and copies an unchanged shard's entries", async () => {
    const files = {
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    };
    const store = await storeOf(files);
    const a = path.join(store.dir, "a.ts");
    const b = path.join(store.dir, "b.ts");
    const reader = unitIn(a, "reader", [
      transition("t1", [ordersTable, audit]),
    ]);
    await store.write([reader, unitIn(b, "caller", [transition("t1", [])])]);
    await store.write([
      reader,
      unitIn(b, "caller", [transition("t1", [audit])]),
    ]);

    const index = await store.index();
    expect(index.files.map(([file]: [string]) => file)).toEqual([a, b]);
    expect(index.boundaries["postgresql:orders"]).toEqual([[0, 0, "calls"]]);
    expect(index.callees.audit).toEqual([
      [0, 0],
      [1, 0],
    ]);
    const served = Object.entries(index.boundaries).filter(([, units]) =>
      (units as [number, number, string][]).some(
        ([, , role]) => role === "serves",
      ),
    );
    expect(served).toHaveLength(1);
  });
});
