// cache.ts — on-disk extraction cache with coarse + partial-reuse tiers.
//
// Coarse tier (always active):
//
//   coarse key = (adapter version, pack versions, tsconfig stamp,
//                 sorted [(file path, mtime, size)] for include set)
//
// On a warm run with no changes, computing the coarse key takes one
// fs.stat per file (~5µs each, ~25ms for 5,500 files) — no reads, no
// AST work, no extraction. Match → return previous run's summaries
// verbatim.
//
// Partial-reuse tier (Phase 4b):
//
//   When the file set differs but the schema / packs / tsconfig still
//   match, partition cached summaries into:
//     - kept           — summaries whose location.file is unchanged
//                        AND whose kind isn't library (closure-derived
//                        units get rebuilt from the merged set)
//     - filesToExtract — changed ∪ added (the per-file extract scope)
//   The adapter re-extracts only those files, merges with kept, and
//   re-runs the closure / rethrow phases over the merged set.
//
// Soundness limit: invalidation is keyed on location.file. Type-shape
// extraction can pull types from imported files; a type change in an
// untouched importer's dep is NOT detected and can produce a stale
// shape on a kept summary. Same trade-off TypeScript's incremental
// compilation accepts. `--no-cache` or deleting `.suss/cache/` forces
// a full re-extract for callers that need the strict guarantee.
//
// Mtime can lie (false positives — content unchanged but stat says
// touched). False positives are recoverable: we just re-extract and
// the result is the same. False negatives (cache hit when content
// changed) require touching files in-place without updating mtime;
// not a workflow we support.

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
 * Reported by `lookup`. Surfaces what the cache decided and, for
 * partial-hits, the file-churn breakdown so callers can render a
 * diagnostic.
 */
export interface CacheDiagnostic {
  kind: "hit" | "partial-hit" | "miss";
  /** Reason the lookup missed (only set when kind === "miss"). */
  missReason?:
    | "no-manifest"
    | "schema-mismatch"
    | "packs-changed"
    | "tsconfig-changed";
  /**
   * Counts describing the file churn that produced a partial hit.
   * Only populated when kind === "partial-hit".
   */
  partial?: {
    /** Cached summaries whose location.file is in the unchanged set. */
    reusedSummaries: number;
    /** Files the adapter needs to re-extract per-file from. */
    filesToReExtract: number;
    /** Files added to the include set since the cached run. */
    addedFiles: number;
    /** Files removed from the include set since the cached run. */
    removedFiles: number;
    /** Files whose mtime/size differs (excludes added/removed). */
    changedFiles: number;
  };
}

/**
 * Result of a cache lookup. The adapter dispatches on `kind`:
 *
 *   - "hit"          — the entire summary set is valid; return it
 *                      verbatim, skip extraction.
 *   - "partial-hit"  — `kept` is correct as far as their location.file
 *                      went; re-extract `filesToExtract` per-file and
 *                      re-run the closure / rethrow passes over the
 *                      merged set.
 *   - "miss"         — manifest absent or coarse keys (schema, packs,
 *                      tsconfig) changed; full re-extract.
 */
export type CacheLookup =
  | {
      kind: "hit";
      summaries: BehavioralSummary[];
      diagnostic: CacheDiagnostic;
    }
  | {
      kind: "partial-hit";
      kept: BehavioralSummary[];
      filesToExtract: string[];
      diagnostic: CacheDiagnostic;
    }
  | { kind: "miss"; diagnostic: CacheDiagnostic };

export interface CacheLayer {
  /**
   * Convenience wrapper around `lookup` that collapses partial-hits
   * to misses. Returns the full summary list on a clean hit, null
   * otherwise. Phase-1 callers that don't want partial-reuse logic
   * call this and fall through to a full re-extract on miss.
   */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * Full lookup with the partial-hit decision. The adapter uses this
   * to decide between full reuse, partial reuse, and full re-extract.
   * The lookup is stat-only — no file reads, no AST work.
   */
  lookup(input: CacheInput): Promise<CacheLookup>;
  /**
   * Persist a fresh extraction's summaries to the cache, keyed
   * against the same Project state. Subsequent `lookup` calls with
   * the same state return them.
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
      lookup: async () => ({
        kind: "miss",
        diagnostic: { kind: "miss", missReason: "no-manifest" },
      }),
      write: async () => {},
    };
  }
  const manifestPath = path.join(cacheDir, "manifest.json");
  return {
    async tryHit(input: CacheInput): Promise<BehavioralSummary[] | null> {
      const result = await this.lookup(input);
      return result.kind === "hit" ? result.summaries : null;
    },
    async lookup(input: CacheInput): Promise<CacheLookup> {
      const manifest = await readManifest(manifestPath);
      if (manifest === null) {
        return missDiag("no-manifest");
      }
      if (manifest.schemaVersion !== SCHEMA_VERSION) {
        return missDiag("schema-mismatch");
      }
      if (manifest.adapterPacksDigest !== input.adapterPacksDigest) {
        return missDiag("packs-changed");
      }
      const currentTsconfigStamp = await stampTsconfig(input.tsconfigPath);
      if (!fileStampEquals(manifest.tsconfigStamp, currentTsconfigStamp)) {
        return missDiag("tsconfig-changed");
      }
      const currentFiles = await resolveFileStamps(input);
      const partition = partitionByFileChurn(manifest, currentFiles);
      if (partition.changedSet.size === 0 && partition.added.length === 0) {
        return {
          kind: "hit",
          summaries: manifest.summaries.map((c) => c.summary),
          diagnostic: { kind: "hit" },
        };
      }
      // Keep every cached summary whose location.file is unchanged —
      // including library-kind summaries discovered by the closure pass.
      // A library summary is a description of its own function's body;
      // if that file didn't change, the description is still valid.
      // The closure walk's `covered` set will dedup against these
      // kept summaries when it walks from new entry points, so
      // re-derivation only happens for genuinely new callees.
      // Orphan library summaries (no entry point reaches them after a
      // change) are acceptable — they're correct descriptions, just
      // unreferenced by the pairing layer.
      const kept = manifest.summaries
        .filter((c) => !partition.changedSet.has(c.summary.location.file))
        .map((c) => c.summary);
      const filesToExtract = [...partition.changed, ...partition.added];
      return {
        kind: "partial-hit",
        kept,
        filesToExtract,
        diagnostic: {
          kind: "partial-hit",
          partial: {
            reusedSummaries: kept.length,
            filesToReExtract: filesToExtract.length,
            addedFiles: partition.added.length,
            removedFiles: partition.removed.length,
            changedFiles: partition.changed.length,
          },
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

function missDiag(reason: NonNullable<CacheDiagnostic["missReason"]>): {
  kind: "miss";
  diagnostic: CacheDiagnostic;
} {
  return {
    kind: "miss",
    diagnostic: { kind: "miss", missReason: reason },
  };
}

interface FilePartition {
  /** Files unchanged between manifest and current run. */
  unchanged: string[];
  /** Files whose mtime/size differs (excludes added/removed). */
  changed: string[];
  /** Files in the current set but not in the manifest. */
  added: string[];
  /** Files in the manifest but not in the current set. */
  removed: string[];
  /**
   * Convenience set of every file the adapter must treat as "not
   * reusable" for partial-hit invalidation: changed ∪ removed. New
   * files aren't in here because they have no cached summaries to
   * invalidate yet.
   */
  changedSet: Set<string>;
}

function partitionByFileChurn(
  manifest: Manifest,
  currentFiles: FileStamp[],
): FilePartition {
  const oldByPath = new Map(manifest.files.map((f) => [f.path, f] as const));
  const newByPath = new Map(currentFiles.map((f) => [f.path, f] as const));

  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [pathStr, newStamp] of newByPath) {
    const oldStamp = oldByPath.get(pathStr);
    if (oldStamp === undefined) {
      added.push(pathStr);
      continue;
    }
    if (fileStampEquals(oldStamp, newStamp)) {
      unchanged.push(pathStr);
    } else {
      changed.push(pathStr);
    }
  }
  for (const [pathStr] of oldByPath) {
    if (!newByPath.has(pathStr)) {
      removed.push(pathStr);
    }
  }

  const changedSet = new Set<string>();
  for (const p of changed) {
    changedSet.add(p);
  }
  for (const p of removed) {
    changedSet.add(p);
  }

  return { unchanged, changed, added, removed, changedSet };
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
