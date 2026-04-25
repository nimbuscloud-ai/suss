// cache.ts — coarse-grained on-disk extraction cache.
//
// Two-tier strategy. This file handles the COARSE tier:
//
//   coarse key = (adapter version, pack versions, tsconfig path,
//                 sorted [(file path, mtime, size)] for include set)
//
// On a warm run with no changes, computing the coarse key takes one
// fs.stat per file (~5µs each, ~25ms for 5,500 files) — no reads, no
// AST work, no extraction. Match → return previous run's summaries
// verbatim. Miss → fall through to full extraction, write a fresh
// manifest, and return.
//
// Mtime can lie (false positives — content unchanged but stat says
// touched). False positives are recoverable: we just re-extract and
// the result is the same. False negatives (cache hit when content
// changed) require touching files in-place without updating mtime;
// not a workflow we support.
//
// Fine-grained per-file cache is separate (Phase 4). It lets warm-
// with-changes runs re-extract only the changed files instead of
// blowing away the whole cache.

import fs from "node:fs/promises";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

const SCHEMA_VERSION = "1";

interface FileStamp {
  /** Absolute path. */
  path: string;
  /** mtime in ms. */
  mtimeMs: number;
  size: number;
}

interface Manifest {
  schemaVersion: string;
  adapterPacksDigest: string;
  tsconfigStamp: FileStamp | null;
  files: FileStamp[];
  summaries: BehavioralSummary[];
}

export interface CacheLayer {
  /**
   * Look up summaries for the current Project state. Returns null
   * on any cache miss (no manifest, schema mismatch, packs changed,
   * file added/removed/touched). The lookup is stat-only — no
   * file reads, no AST work.
   */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * Persist a fresh extraction's summaries to the cache, keyed
   * against the same Project state. Subsequent `tryHit` calls
   * with the same state return these summaries.
   */
  write(input: CacheInput, summaries: BehavioralSummary[]): Promise<void>;
}

export interface CacheInput {
  project: Project;
  adapterPacksDigest: string;
  tsconfigPath?: string;
}

/**
 * Construct a cache layer rooted at `cacheDir`. Pass `null` to
 * opt out of caching entirely — the returned layer's `tryHit`
 * always misses and `write` is a no-op. Useful for one-shot
 * extracts where caching adds latency without payoff.
 */
export function createCacheLayer(cacheDir: string | null): CacheLayer {
  if (cacheDir === null) {
    return {
      tryHit: async () => null,
      write: async () => {},
    };
  }
  const manifestPath = path.join(cacheDir, "manifest.json");
  return {
    async tryHit(input: CacheInput): Promise<BehavioralSummary[] | null> {
      const manifest = await readManifest(manifestPath);
      if (manifest === null) {
        return null;
      }
      if (manifest.schemaVersion !== SCHEMA_VERSION) {
        return null;
      }
      if (manifest.adapterPacksDigest !== input.adapterPacksDigest) {
        return null;
      }
      const currentTsconfigStamp = await stampTsconfig(input.tsconfigPath);
      if (!fileStampEquals(manifest.tsconfigStamp, currentTsconfigStamp)) {
        return null;
      }
      const currentFiles = await stampProjectFiles(input.project);
      if (!fileStampsEqual(manifest.files, currentFiles)) {
        return null;
      }
      return manifest.summaries;
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
    ): Promise<void> {
      const tsconfigStamp = await stampTsconfig(input.tsconfigPath);
      const files = await stampProjectFiles(input.project);
      const manifest: Manifest = {
        schemaVersion: SCHEMA_VERSION,
        adapterPacksDigest: input.adapterPacksDigest,
        tsconfigStamp,
        files,
        summaries,
      };
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
    },
  };
}

async function readManifest(manifestPath: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    // Missing file, invalid JSON, permission denied — all manifest
    // failures collapse to "miss." Cache reads are advisory; the
    // worst case is a redundant extraction.
    return null;
  }
}

async function stampTsconfig(
  tsconfigPath: string | undefined,
): Promise<FileStamp | null> {
  if (tsconfigPath === undefined) {
    return null;
  }
  try {
    const stat = await fs.stat(tsconfigPath);
    return { path: tsconfigPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

async function stampProjectFiles(project: Project): Promise<FileStamp[]> {
  const files = project
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile())
    .map((sf) => sf.getFilePath());
  // Concurrent stats — bounded by Node's libuv thread pool. For
  // 5,500-file projects this is the dominant cost of the coarse
  // key (~25ms total).
  const stamped = await Promise.all(
    files.map(async (p) => {
      try {
        const stat = await fs.stat(p);
        return { path: p, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // File disappeared between project enumeration and stat.
        // Returning a sentinel makes the cache always miss —
        // that's correct; the project is in flux.
        return { path: p, mtimeMs: -1, size: -1 };
      }
    }),
  );
  // Sort by path so the manifest is stable regardless of project's
  // traversal order — important for git-friendly storage if anyone
  // ever versions the cache.
  stamped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return stamped;
}

function fileStampEquals(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function fileStampsEqual(a: FileStamp[], b: FileStamp[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!fileStampEquals(a[i], b[i])) {
      return false;
    }
  }
  return true;
}
