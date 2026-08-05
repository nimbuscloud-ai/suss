// cache.ts: the on-disk extraction cache. A run either reuses the
// previous one's summaries whole or extracts from scratch.
//
//   key = (schema version, adapter version, adapter code hash, pack
//          versions, extraction config stamp, tsconfig path,
//          tsconfig stamp, sorted
//          [(file path, mtime, size)] for the include set)
//
// On a warm run with nothing changed, checking the key costs one
// fs.stat per file (around 5us each, around 25ms for 5,500 files), and
// no reads, no AST work, no extraction. Match, and the previous run's
// summaries come back verbatim.
//
// Nothing partial comes back. A summary is often discovered by walking
// a file other than the one it lives in: a package's declared exports
// are found by following the entry file's re-exports out to wherever
// each function is written. Reusing the summaries of files that did not
// change, and re-extracting only the ones that did, therefore drops
// every export whose declaration moved and whose entry file sat still.
// Reusing per file needs a record of which file's walk produced each
// summary, and the manifest has never carried one.
//
// Mtime can lie in the direction of saying a file was touched when its
// content is the same. That costs a re-extract that lands on the same
// answer. The other direction, a hit on content that changed, needs a
// write in place that leaves mtime alone, which is not a workflow this
// supports.
//
// Where an entry lives:
//
//   <cacheDir>/key-<hash of schema, adapter/packs digest, tsconfig
//                    path>/manifest.json
//
// One cache directory serves every build that points at it, and those
// builds disagree about what a summary should say. Naming the entry
// after the part of the key that has to match exactly means a build
// whose key is wrong reads nothing rather than reading a neighbour's
// answers, so the worst a key bug can cost is a re-extract.
//
// A manifest runs to tens of megabytes on a large repo, so entries do
// not accumulate: a write keeps the few most recently used and deletes
// the rest.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

const SCHEMA_VERSION = "4";

/**
 * How many keys' worth of entries a cache directory keeps. Two lets a
 * pair of builds alternate (a branch switch, an adapter rebuild and a
 * revert) without either losing its entry, and bounds a directory at
 * twice one manifest.
 */
export const MAX_ENTRIES = 2;

const ENTRY_PREFIX = "key-";
const ENTRY_DIR_NAME = new RegExp(`^${ENTRY_PREFIX}[0-9a-f]{16}$`);

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

/** Reported by `lookup`: what the cache decided, and why. */
export interface CacheDiagnostic {
  kind: "hit" | "miss";
  /**
   * Reason the lookup missed (only set when kind === "miss").
   * `key-changed` means the cache directory holds entries, but none
   * under this run's schema, adapter, packs and tsconfig path.
   * `files-changed` means the include set is not the one the entry
   * was written from.
   */
  missReason?:
    | "no-manifest"
    | "key-changed"
    | "tsconfig-changed"
    | "files-changed";
}

/**
 * Result of a cache lookup. A hit carries the whole summary set; a miss
 * says why, so a caller can render the reason.
 */
export type CacheLookup =
  | {
      kind: "hit";
      summaries: BehavioralSummary[];
      diagnostic: CacheDiagnostic;
    }
  | { kind: "miss"; diagnostic: CacheDiagnostic };

export interface CacheLayer {
  /** The summary list on a hit, null on a miss. */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * The lookup behind `tryHit`, with the reason a miss missed. Costs
   * stats alone: no file reads, no AST work.
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
  return {
    async tryHit(input: CacheInput): Promise<BehavioralSummary[] | null> {
      const result = await this.lookup(input);
      return result.kind === "hit" ? result.summaries : null;
    },
    async lookup(input: CacheInput): Promise<CacheLookup> {
      const entryDir = entryDirFor(cacheDir, input);
      const manifest = await readManifest(path.join(entryDir, "manifest.json"));
      if (manifest === null) {
        // Nothing compares the manifest's own schema, digest and
        // tsconfig path against this run's: the entry directory is
        // named after them, so reaching a manifest at all settles it.
        return missDiag(await describeAbsentEntry(cacheDir));
      }
      const currentTsconfigStamp = await stampTsconfig(input.tsconfigPath);
      if (!fileStampEquals(manifest.tsconfigStamp, currentTsconfigStamp)) {
        return missDiag("tsconfig-changed");
      }
      const currentFiles = await resolveFileStamps(input);
      if (!fileStampsEqual(manifest.files, currentFiles)) {
        return missDiag("files-changed");
      }
      // Eviction goes by how recently an entry was used, and a run that
      // hits never writes, so the hit is the only chance to say this
      // entry is still wanted.
      await markUsed(entryDir);
      return {
        kind: "hit",
        summaries: manifest.summaries,
        diagnostic: { kind: "hit" },
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
        summaries,
      };
      const entryDir = entryDirFor(cacheDir, input);
      await fs.mkdir(entryDir, { recursive: true });
      await fs.writeFile(
        path.join(entryDir, "manifest.json"),
        JSON.stringify(manifest),
      );
      await evictOldEntries(cacheDir, entryDir);
    },
  };
}

/**
 * Why a lookup found no entry: whether some other build has cached
 * here, or whether nothing ever has. Only consulted on a miss, where
 * the run is about to spend seconds re-extracting anyway.
 */
async function describeAbsentEntry(
  cacheDir: string,
): Promise<"no-manifest" | "key-changed"> {
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && isEntryDir(e.name))
      ? "key-changed"
      : "no-manifest";
  } catch {
    return "no-manifest";
  }
}

/**
 * The directory an entry lives in. Everything the manifest would have
 * had to agree about before a hit was possible goes into the name, so
 * two builds that disagree land in different directories instead of
 * overwriting each other.
 */
function entryDirFor(cacheDir: string, input: CacheInput): string {
  const key = [
    SCHEMA_VERSION,
    input.adapterPacksDigest,
    input.tsconfigPath ?? "",
  ].join(" ");
  const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(cacheDir, `${ENTRY_PREFIX}${name}`);
}

/**
 * Whether a directory under the cache directory is one this module
 * wrote. Eviction deletes recursively and a caller can point `cacheDir`
 * at anything, so it only ever considers names of this shape.
 */
function isEntryDir(name: string): boolean {
  return ENTRY_DIR_NAME.test(name);
}

/** Record that an entry is still in use, for eviction to read later. */
async function markUsed(entryDir: string): Promise<void> {
  const now = new Date();
  try {
    await fs.utimes(entryDir, now, now);
  } catch {
    // The entry may have been evicted by another process between the
    // read and here. Losing the timestamp costs the entry its place in
    // the eviction order, and the run that misses re-extracts.
  }
}

/**
 * Keep the most recently used entries and delete the rest, along with
 * the single `manifest.json` that older versions wrote straight into
 * the cache directory.
 */
async function evictOldEntries(
  cacheDir: string,
  keepDir: string,
): Promise<void> {
  try {
    await fs.rm(path.join(cacheDir, "manifest.json"), { force: true });
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const dirs = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && isEntryDir(e.name))
        .map(async (e) => {
          const dir = path.join(cacheDir, e.name);
          const stat = await fs.stat(dir);
          return { dir, mtimeMs: stat.mtimeMs };
        }),
    );
    const doomed = dirs
      .filter((d) => d.dir !== keepDir)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(MAX_ENTRIES - 1);
    await Promise.all(
      doomed.map((d) => fs.rm(d.dir, { recursive: true, force: true })),
    );
  } catch {
    // Eviction is housekeeping. A directory another process is writing
    // to, or a permission the run does not have, costs disk rather than
    // correctness.
  }
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

/**
 * Whether two include sets stamp the same. Both arrive sorted by path,
 * so one pass settles it.
 */
function fileStampsEqual(
  a: ReadonlyArray<FileStamp>,
  b: ReadonlyArray<FileStamp>,
): boolean {
  return a.length === b.length && a.every((s, i) => fileStampEquals(s, b[i]));
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
