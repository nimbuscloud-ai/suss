/**
 * cache.ts: the on-disk extraction cache.
 *
 * A run reuses the previous one's summaries whole when nothing
 * changed, and per file when some files did. The entry directory is
 * named after everything that has to agree before any reuse is sound:
 * schema version, adapter version and code hash, pack versions, the
 * extraction config stamp and the tsconfig path. Inside it, the
 * manifest records a stamp and content hash per file, each summary's
 * owning files, and per owning file the other files its walk read, so
 * a change to any of those re-extracts the owner instead of serving a
 * stale answer. The full design, including what per-file reuse can
 * and cannot promise, is in this package's README.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

const SCHEMA_VERSION = "6";

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
  /** Absent on entries written without per-file attribution. */
  contentHash?: string;
}

/**
 * What one walked file contributed to the run, and what its walk read.
 * `deps` are the other files whose content went into this file's
 * summaries; a change to any of them re-extracts this file. `claims`
 * are the units this file's walk claimed, replayed before a partial
 * run walks anything so precedence comes out the same. A file marked
 * `cacheable: false` recorded a dependency the cache cannot pin to
 * files, and is re-extracted on every partial run.
 */
export interface RootRecord {
  path: string;
  cacheable: boolean;
  deps: string[];
  claims: { key: string; pack: string }[];
  /** Mount prefixes the walk consumed, by mounted router node id. */
  mountPrefixes: Record<string, string>;
  /** Packs that applied to the file, re-checked on a partial run. */
  packs: string[];
}

/**
 * Which files each summary belongs to. `owners[i]` lists the walked
 * files whose reuse keeps `summaries[i]` alive; an empty list marks a
 * run-level summary that a partial run always recomputes.
 */
export interface CacheAttribution {
  roots: RootRecord[];
  owners: string[][];
}

interface StoredRootMeta {
  cacheable: boolean;
  /** Indices into the manifest's depPaths table. */
  deps: number[];
  claims: { key: string; pack: string }[];
  mountPrefixes: Record<string, string>;
  packs: string[];
}

interface Manifest {
  schemaVersion: string;
  adapterPacksDigest: string;
  tsconfigStamp: FileStamp | null;
  files: FileStamp[];
  summaries: BehavioralSummary[];
  /** The per-file layer. Absent when written without attribution. */
  roots?: string[];
  rootMeta?: StoredRootMeta[];
  depPaths?: string[];
  /** Parallel to summaries: indices into roots, [] for run-level. */
  owners?: number[][];
}

/** Reported by `lookup`: what the cache decided, and why. */
export interface CacheDiagnostic {
  kind: "hit" | "miss" | "partial";
  /**
   * Reason the lookup missed (only set when kind === "miss").
   * `key-changed` means the cache directory contains entries, but none
   * under this run's schema, adapter, packs and tsconfig path.
   * `files-changed` means the include set is not the one the entry
   * was written from.
   */
  missReason?:
    | "no-manifest"
    | "key-changed"
    | "tsconfig-changed"
    | "files-changed";
  /** Set when kind === "partial". */
  partial?: {
    filesChanged: number;
    filesRemoved: number;
    rootsReused: number;
    rootsReextracted: number;
    rootsDeclined: number;
    summariesReused: number;
  };
}

/**
 * Result of a cache lookup. A hit gives back the whole summary set; a miss
 * says why, so a caller can render the reason.
 */
export type CacheLookup =
  | {
      kind: "hit";
      summaries: BehavioralSummary[];
      diagnostic: CacheDiagnostic;
    }
  | { kind: "miss"; diagnostic: CacheDiagnostic };

/**
 * What a `files-changed` miss can still reuse. `validRoots` is the
 * cache's own verdict from hashes and recorded dependencies; the
 * caller may demote further (a mount prefix that no longer matches)
 * before calling `reuse`. `reuse` returns the summaries owned by at
 * least one surviving root, in stored order, with their owners, so
 * the caller can merge them and write the result back.
 */
export interface PartialPlan {
  /** Paths whose content hash differs, plus paths new to the set. */
  changed: Set<string>;
  removed: Set<string>;
  roots: Map<string, RootRecord>;
  validRoots: Set<string>;
  rootsDeclined: number;
  reuse(valid: ReadonlySet<string>): {
    summaries: BehavioralSummary[];
    owners: string[][];
  };
  allSummaries(): BehavioralSummary[];
  /** The stored attribution decoded, for a write that changes nothing. */
  attribution(): CacheAttribution;
}

export interface CacheLayer {
  /** The summary list on a hit, null on a miss. */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * The lookup behind `tryHit`, with the reason a miss missed. Costs
   * stats alone: no file reads, no AST work.
   */
  lookup(input: CacheInput): Promise<CacheLookup>;
  /**
   * After a `files-changed` miss: hash what the stats said moved and
   * work out which files' summaries survive. Null when the entry has
   * no per-file layer to reuse, or no entry matches the key at all.
   */
  plan(input: CacheInput): Promise<PartialPlan | null>;
  /**
   * Persist a fresh extraction's summaries to the cache, keyed
   * against the same Project state. Subsequent `lookup` calls with
   * the same state return them. Without `attribution` the entry can
   * only ever be reused whole.
   */
  write(
    input: CacheInput,
    summaries: BehavioralSummary[],
    attribution?: CacheAttribution,
  ): Promise<void>;
}

export interface CacheInput {
  /**
   * Either a list of absolute file paths OR a Project. The first
   * form lets the cache run BEFORE the project's lazy bootstrap
   *, pass the file list from the tsconfig parse so a cache hit
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
 * opt out of caching entirely, the returned layer's `tryHit`
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
      plan: async () => null,
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
    async plan(input: CacheInput): Promise<PartialPlan | null> {
      const entryDir = entryDirFor(cacheDir, input);
      const manifest = await readManifest(path.join(entryDir, "manifest.json"));
      if (
        manifest === null ||
        manifest.roots === undefined ||
        manifest.rootMeta === undefined ||
        manifest.owners === undefined
      ) {
        return null;
      }
      const currentTsconfigStamp = await stampTsconfig(input.tsconfigPath);
      if (!fileStampEquals(manifest.tsconfigStamp, currentTsconfigStamp)) {
        return null;
      }
      await markUsed(entryDir);
      return buildPlan(manifest, await resolveFileStamps(input));
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
      attribution?: CacheAttribution,
    ): Promise<void> {
      const entryDir = entryDirFor(cacheDir, input);
      const previous = await readManifest(path.join(entryDir, "manifest.json"));
      const tsconfigStamp = await stampTsconfig(input.tsconfigPath);
      const files = await hashStamps(await resolveFileStamps(input), previous);
      const manifest: Manifest = {
        schemaVersion: SCHEMA_VERSION,
        adapterPacksDigest: input.adapterPacksDigest,
        tsconfigStamp,
        files,
        summaries,
        ...(attribution === undefined ? {} : encodeAttribution(attribution)),
      };
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
 * Compare the stored per-file layer against the current stamps. A
 * file whose stamp moved is read and hashed, so a touch that left the
 * content alone does not count as a change. A stored file without a
 * hash counts as changed whenever its stamp moved.
 */
async function buildPlan(
  manifest: Manifest,
  currentStamps: FileStamp[],
): Promise<PartialPlan> {
  const stored = new Map(manifest.files.map((f) => [f.path, f]));
  const current = new Map(currentStamps.map((f) => [f.path, f]));

  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const p of stored.keys()) {
    if (!current.has(p)) {
      removed.add(p);
    }
  }
  const toVerify: string[] = [];
  for (const [p, stamp] of current) {
    const before = stored.get(p);
    if (before === undefined) {
      changed.add(p);
    } else if (!fileStampEquals(before, stamp)) {
      if (before.contentHash === undefined) {
        changed.add(p);
      } else {
        toVerify.push(p);
      }
    }
  }
  await Promise.all(
    toVerify.map(async (p) => {
      const hash = await hashFile(p);
      if (hash === null || hash !== stored.get(p)?.contentHash) {
        changed.add(p);
      }
    }),
  );

  const roots = new Map<string, RootRecord>();
  const rootNames = manifest.roots ?? [];
  const depPaths = manifest.depPaths ?? [];
  let rootsDeclined = 0;
  rootNames.forEach((rootPath, i) => {
    const meta = manifest.rootMeta?.[i];
    if (meta === undefined) {
      return;
    }
    if (!meta.cacheable) {
      rootsDeclined += 1;
    }
    roots.set(rootPath, {
      path: rootPath,
      cacheable: meta.cacheable,
      deps: meta.deps.flatMap((d) => {
        const p = depPaths[d];
        return p === undefined ? [] : [p];
      }),
      claims: meta.claims,
      mountPrefixes: meta.mountPrefixes,
      packs: meta.packs,
    });
  });

  const validRoots = new Set<string>();
  for (const [rootPath, record] of roots) {
    if (!record.cacheable || !current.has(rootPath)) {
      continue;
    }
    if (changed.has(rootPath)) {
      continue;
    }
    const depMoved = record.deps.some((d) => changed.has(d) || removed.has(d));
    if (!depMoved) {
      validRoots.add(rootPath);
    }
  }

  const owners = manifest.owners ?? [];
  return {
    changed,
    removed,
    roots,
    validRoots,
    rootsDeclined,
    reuse(valid: ReadonlySet<string>) {
      const summaries: BehavioralSummary[] = [];
      const reusedOwners: string[][] = [];
      manifest.summaries.forEach((summary, i) => {
        const ownerPaths = (owners[i] ?? []).flatMap((o) => {
          const p = rootNames[o];
          return p === undefined ? [] : [p];
        });
        if (ownerPaths.some((p) => valid.has(p))) {
          summaries.push(summary);
          reusedOwners.push(ownerPaths.filter((p) => valid.has(p)));
        }
      });
      return { summaries, owners: reusedOwners };
    },
    allSummaries() {
      return manifest.summaries;
    },
    attribution() {
      return {
        roots: [...roots.values()],
        owners: owners.map((ownerIds) =>
          ownerIds.flatMap((o) => {
            const p = rootNames[o];
            return p === undefined ? [] : [p];
          }),
        ),
      };
    },
  };
}

function encodeAttribution(
  attribution: CacheAttribution,
): Pick<Manifest, "roots" | "rootMeta" | "depPaths" | "owners"> {
  const roots = attribution.roots.map((r) => r.path);
  const rootIndex = new Map(roots.map((p, i) => [p, i]));
  const depIndex = new Map<string, number>();
  const depPaths: string[] = [];
  const depIdOf = (p: string): number => {
    const existing = depIndex.get(p);
    if (existing !== undefined) {
      return existing;
    }
    const id = depPaths.length;
    depPaths.push(p);
    depIndex.set(p, id);
    return id;
  };
  const rootMeta: StoredRootMeta[] = attribution.roots.map((r) => ({
    cacheable: r.cacheable,
    deps: r.deps.map(depIdOf),
    claims: r.claims,
    mountPrefixes: r.mountPrefixes,
    packs: r.packs,
  }));
  const owners = attribution.owners.map((ownerPaths) =>
    ownerPaths.flatMap((p) => {
      const i = rootIndex.get(p);
      return i === undefined ? [] : [i];
    }),
  );
  return { roots, rootMeta, depPaths, owners };
}

/** Reuse the previous hash when the stamp did not move; hash the rest. */
async function hashStamps(
  stamps: FileStamp[],
  previous: Manifest | null,
): Promise<FileStamp[]> {
  const before = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  return Promise.all(
    stamps.map(async (stamp) => {
      const prior = before.get(stamp.path);
      if (
        prior !== undefined &&
        prior.contentHash !== undefined &&
        fileStampEquals(prior, stamp)
      ) {
        return { ...stamp, contentHash: prior.contentHash };
      }
      const contentHash = await hashFile(stamp.path);
      return contentHash === null ? stamp : { ...stamp, contentHash };
    }),
  );
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Why a lookup did not find an entry: whether some other build has cached
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
  ].join(" ");
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
    // Missing file, invalid JSON, permission denied, all manifest
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
 * `files` (paths) takes precedence, the cache-pre-bootstrap path
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
  // Concurrent stats: bounded by Node's libuv thread pool. For
  // 5,500-file projects this is the dominant cost of the coarse
  // key (~25ms total).
  const stamped = await Promise.all(
    files.map(async (p) => {
      try {
        const stat = await fs.stat(p);
        return { path: p, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // File disappeared between project enumeration and stat.
        // Returning a sentinel makes the cache always miss,
        // that's correct; the project is in flux.
        return { path: p, mtimeMs: -1, size: -1 };
      }
    }),
  );
  // Sort by path so the manifest is stable regardless of project's
  // traversal order: important for git-friendly storage if anyone
  // ever versions the cache.
  stamped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return stamped;
}

/**
 * Whether two include sets stamp the same. Both arrive sorted by path,
 * so one pass settles it. Content hashes stay out of it: the fast
 * lookup compares stats alone, and `plan` is where hashes decide.
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
