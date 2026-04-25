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
// Phase 4a: each summary in the manifest carries a `dependsOn` set
// of files whose change would invalidate it. The cache still acts
// on the coarse key (all-or-nothing) — but on a miss we walk the
// stored deps and report what fine-grained invalidation WOULD
// have given us. Phase 4b will activate the partial-reuse path.

import fs from "node:fs/promises";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

const SCHEMA_VERSION = "2";

interface FileStamp {
  /** Absolute path. */
  path: string;
  /** mtime in ms. */
  mtimeMs: number;
  size: number;
}

/**
 * One entry in the manifest's summary list. `dependsOn` is the set
 * of files whose change should invalidate this summary — at minimum
 * the file the summary lives in, plus every file that holds another
 * summary the summary's invocation effects reach. Phase 4a stores
 * the set; phase 4b uses it for partial reuse.
 */
interface CachedSummary {
  summary: BehavioralSummary;
  dependsOn: string[];
}

interface Manifest {
  schemaVersion: string;
  adapterPacksDigest: string;
  tsconfigStamp: FileStamp | null;
  files: FileStamp[];
  summaries: CachedSummary[];
}

/**
 * Reported by `tryHitWithDiagnostic`. Always returned alongside
 * the hit/miss decision; the consumer decides whether to act on
 * the partial-reuse counts.
 */
export interface CacheDiagnostic {
  kind: "hit" | "miss";
  /** Reason the lookup missed (only set when kind === "miss"). */
  missReason?:
    | "no-manifest"
    | "schema-mismatch"
    | "packs-changed"
    | "tsconfig-changed"
    | "files-changed";
  /**
   * Counts that show what fine-grained invalidation WOULD have
   * salvaged. Only populated when missReason === "files-changed"
   * (the other miss reasons invalidate every summary regardless).
   */
  partial?: {
    /** Cached summaries whose dep set didn't intersect changed files. */
    wouldReuse: number;
    /** Cached summaries whose deps include at least one changed file. */
    wouldInvalidate: number;
    /** Files added to the include set since the cached run. */
    addedFiles: number;
    /** Files removed from the include set since the cached run. */
    removedFiles: number;
    /** Files whose mtime/size differs (excludes added/removed). */
    changedFiles: number;
  };
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
   * Same as `tryHit` but also reports what fine-grained
   * invalidation would have salvaged on a miss. Phase 4a uses the
   * diagnostic to surface the partial-reuse opportunity without
   * acting on it.
   */
  tryHitWithDiagnostic(input: CacheInput): Promise<{
    summaries: BehavioralSummary[] | null;
    diagnostic: CacheDiagnostic;
  }>;
  /**
   * Persist a fresh extraction's summaries to the cache, keyed
   * against the same Project state. Subsequent `tryHit` calls
   * with the same state return these summaries.
   */
  write(input: CacheInput, summaries: BehavioralSummary[]): Promise<void>;
}

export interface CacheInput {
  /**
   * Either a list of absolute file paths OR a Project. The first
   * form lets the cache run BEFORE the project's lazy bootstrap
   * — pass the file list from the tsconfig parse so a cache hit
   * doesn't pay for the bootstrap. The Project form keeps back-
   * compat for callers that already have a populated Project.
   */
  files?: ReadonlyArray<string>;
  project?: Project;
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
      tryHitWithDiagnostic: async () => ({
        summaries: null,
        diagnostic: { kind: "miss", missReason: "no-manifest" },
      }),
      write: async () => {},
    };
  }
  const manifestPath = path.join(cacheDir, "manifest.json");
  return {
    async tryHit(input: CacheInput): Promise<BehavioralSummary[] | null> {
      const result = await loadAndCheck(manifestPath, input);
      if (result.kind === "hit") {
        return result.summaries;
      }
      return null;
    },
    async tryHitWithDiagnostic(input: CacheInput): Promise<{
      summaries: BehavioralSummary[] | null;
      diagnostic: CacheDiagnostic;
    }> {
      const result = await loadAndCheck(manifestPath, input);
      if (result.kind === "hit") {
        return {
          summaries: result.summaries,
          diagnostic: { kind: "hit" },
        };
      }
      return {
        summaries: null,
        diagnostic: {
          kind: "miss",
          missReason: result.reason,
          ...(result.partial !== undefined ? { partial: result.partial } : {}),
        },
      };
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
    ): Promise<void> {
      const tsconfigStamp = await stampTsconfig(input.tsconfigPath);
      const files = await resolveFileStamps(input);
      const manifest: Manifest = {
        schemaVersion: SCHEMA_VERSION,
        adapterPacksDigest: input.adapterPacksDigest,
        tsconfigStamp,
        files,
        summaries: attachDeps(summaries),
      };
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
    },
  };
}

type LoadResult =
  | { kind: "hit"; summaries: BehavioralSummary[] }
  | {
      kind: "miss";
      reason: NonNullable<CacheDiagnostic["missReason"]>;
      partial?: NonNullable<CacheDiagnostic["partial"]>;
    };

async function loadAndCheck(
  manifestPath: string,
  input: CacheInput,
): Promise<LoadResult> {
  const manifest = await readManifest(manifestPath);
  if (manifest === null) {
    return { kind: "miss", reason: "no-manifest" };
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    return { kind: "miss", reason: "schema-mismatch" };
  }
  if (manifest.adapterPacksDigest !== input.adapterPacksDigest) {
    return { kind: "miss", reason: "packs-changed" };
  }
  const currentTsconfigStamp = await stampTsconfig(input.tsconfigPath);
  if (!fileStampEquals(manifest.tsconfigStamp, currentTsconfigStamp)) {
    return { kind: "miss", reason: "tsconfig-changed" };
  }
  const currentFiles = await resolveFileStamps(input);
  if (!fileStampsEqual(manifest.files, currentFiles)) {
    return {
      kind: "miss",
      reason: "files-changed",
      partial: computePartialReuse(manifest, currentFiles),
    };
  }
  return {
    kind: "hit",
    summaries: manifest.summaries.map((c) => c.summary),
  };
}

/**
 * Compute the per-summary dependency set from the final summary
 * list. For every summary S:
 *   - S.location.file is always a dep (the file S lives in)
 *   - For each invocation effect's callee text that matches another
 *     summary's identity name in a different file, that file is a dep
 *
 * This is intentionally heuristic — it captures the closure-expansion
 * graph, which is the dominant source of cross-file invalidation.
 * Type-shape lookups in unrelated files are not captured here; they
 * fall back to the coarse cache invalidating on any change.
 */
function attachDeps(summaries: BehavioralSummary[]): CachedSummary[] {
  const fileByName = new Map<string, string>();
  for (const s of summaries) {
    fileByName.set(s.identity.name, s.location.file);
  }
  return summaries.map((summary) => {
    const deps = new Set<string>([summary.location.file]);
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        const targetFile = fileByName.get(effect.callee);
        if (targetFile !== undefined && targetFile !== summary.location.file) {
          deps.add(targetFile);
        }
      }
    }
    return { summary, dependsOn: [...deps].sort() };
  });
}

/**
 * Partition cached summaries by whether their dep set intersects the
 * set of changed files. Phase 4a only reports the counts; phase 4b
 * will return the kept set + the file list that needs re-extraction.
 */
function computePartialReuse(
  manifest: Manifest,
  currentFiles: FileStamp[],
): NonNullable<CacheDiagnostic["partial"]> {
  const oldByPath = new Map(manifest.files.map((f) => [f.path, f] as const));
  const newByPath = new Map(currentFiles.map((f) => [f.path, f] as const));

  const changed = new Set<string>();
  let addedFiles = 0;
  let removedFiles = 0;
  let changedFiles = 0;

  for (const [pathStr, newStamp] of newByPath) {
    const oldStamp = oldByPath.get(pathStr);
    if (oldStamp === undefined) {
      addedFiles += 1;
      changed.add(pathStr);
      continue;
    }
    if (!fileStampEquals(oldStamp, newStamp)) {
      changedFiles += 1;
      changed.add(pathStr);
    }
  }
  for (const [pathStr] of oldByPath) {
    if (!newByPath.has(pathStr)) {
      removedFiles += 1;
      changed.add(pathStr);
    }
  }

  let wouldReuse = 0;
  let wouldInvalidate = 0;
  for (const cached of manifest.summaries) {
    const intersects = cached.dependsOn.some((dep) => changed.has(dep));
    if (intersects) {
      wouldInvalidate += 1;
    } else {
      wouldReuse += 1;
    }
  }

  return {
    wouldReuse,
    wouldInvalidate,
    addedFiles,
    removedFiles,
    changedFiles,
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

/**
 * Resolve the file list from whichever input form the caller used.
 * `files` (paths) takes precedence — the cache-pre-bootstrap path
 * passes that. `project` falls back to the Project's loaded
 * source files.
 */
async function resolveFileStamps(input: CacheInput): Promise<FileStamp[]> {
  if (input.files !== undefined) {
    return stampPaths(input.files);
  }
  if (input.project !== undefined) {
    return stampProjectFiles(input.project);
  }
  return [];
}

async function stampProjectFiles(project: Project): Promise<FileStamp[]> {
  const files = project
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile())
    .map((sf) => sf.getFilePath());
  return stampPaths(files);
}

async function stampPaths(paths: ReadonlyArray<string>): Promise<FileStamp[]> {
  const files = paths;
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
