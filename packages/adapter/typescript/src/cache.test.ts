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

  describe("tryHitWithDiagnostic", () => {
    it("reports hit when the cache is fresh", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [fakeSummary]);
      const { summaries, diagnostic } = await cache.tryHitWithDiagnostic(input);
      expect(diagnostic.kind).toBe("hit");
      expect(summaries).toEqual([fakeSummary]);
    });

    it("reports the missReason when there is no manifest", async () => {
      const cacheDir = await makeTempDir();
      const { project } = await makeProjectWith({
        "a.ts": "export const a = 1;",
      });
      const cache = createCacheLayer(cacheDir);
      const { diagnostic } = await cache.tryHitWithDiagnostic({
        project,
        adapterPacksDigest: "test@1",
      });
      expect(diagnostic.kind).toBe("miss");
      expect(diagnostic.missReason).toBe("no-manifest");
    });

    it("reports partial-reuse counts when files change", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "a.ts": "export const a = 1;",
        "b.ts": "export const b = 2;",
      });
      const summaryA: BehavioralSummary = {
        ...fakeSummary,
        location: { ...fakeSummary.location, file: path.join(dir, "a.ts") },
        identity: { ...fakeSummary.identity, name: "summaryA" },
      };
      const summaryB: BehavioralSummary = {
        ...fakeSummary,
        location: { ...fakeSummary.location, file: path.join(dir, "b.ts") },
        identity: { ...fakeSummary.identity, name: "summaryB" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [summaryA, summaryB]);

      // Touch only a.ts — b.ts's deps don't intersect, so it would be reused
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;");

      const { summaries, diagnostic } = await cache.tryHitWithDiagnostic(input);
      expect(summaries).toBeNull();
      expect(diagnostic.kind).toBe("miss");
      expect(diagnostic.missReason).toBe("files-changed");
      expect(diagnostic.partial).toEqual({
        wouldReuse: 1,
        wouldInvalidate: 1,
        addedFiles: 0,
        removedFiles: 0,
        changedFiles: 1,
      });
    });

    it("flags a summary as invalidated when its invocation dep changes", async () => {
      const cacheDir = await makeTempDir();
      const { project, dir } = await makeProjectWith({
        "caller.ts": "export const c = 1;",
        "callee.ts": "export const d = 2;",
      });
      const callerSummary: BehavioralSummary = {
        ...fakeSummary,
        location: {
          ...fakeSummary.location,
          file: path.join(dir, "caller.ts"),
        },
        identity: { ...fakeSummary.identity, name: "callerFn" },
        transitions: [
          {
            id: "t0",
            conditions: [],
            output: { type: "return" },
            effects: [
              {
                type: "invocation",
                callee: "calleeFn",
                args: [],
                async: false,
              },
            ],
            location: { start: 1, end: 1 },
            isDefault: true,
          },
        ],
      };
      const calleeSummary: BehavioralSummary = {
        ...fakeSummary,
        location: {
          ...fakeSummary.location,
          file: path.join(dir, "callee.ts"),
        },
        identity: { ...fakeSummary.identity, name: "calleeFn" },
      };
      const cache = createCacheLayer(cacheDir);
      const input = { project, adapterPacksDigest: "test@1" };
      await cache.write(input, [callerSummary, calleeSummary]);

      // Touch only callee.ts — caller's deps include callee.ts via the
      // invocation, so both summaries would be invalidated.
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(dir, "callee.ts"), "export const d = 2;");

      const { diagnostic } = await cache.tryHitWithDiagnostic(input);
      expect(diagnostic.partial).toEqual({
        wouldReuse: 0,
        wouldInvalidate: 2,
        addedFiles: 0,
        removedFiles: 0,
        changedFiles: 1,
      });
    });
  });
});
