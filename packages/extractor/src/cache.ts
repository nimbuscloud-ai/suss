/**
 * The on-disk extraction cache, shared by every language adapter.
 *
 * A run reuses the previous run's summaries whole when nothing changed,
 * and per file when some files did. The entry directory's name is a hash
 * of the schema version, the adapter and packs digest, and the config
 * path, so two builds that disagree on any of them never read each
 * other's entry. The manifest inside records a stamp and content hash per
 * file, the files each summary belongs to, and for each of those files the
 * other files its walk read. An adapter can store its own data on a file's
 * record through `meta`, which the cache never reads. The package's
 * design notes describe the cache in full.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const SCHEMA_VERSION = "7";

/**
 * How many entries a cache directory keeps. Two lets a pair of builds
 * alternate, as on a branch switch or an adapter rebuild and revert,
 * without either losing its entry, and keeps a directory to two manifests.
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
 * summaries, and a change to any of them re-extracts this file. `claims`
 * are the units this file's walk claimed. A partial run replays them
 * before walking anything, so the same pack wins each unit as before.
 * `meta` is whatever else the adapter needs to check this file again on
 * a partial run, such as a route's mount prefixes. A file marked
 * `cacheable: false` depends on something the cache cannot tie to files,
 * and is re-extracted on every partial run.
 */
export interface RootRecord<Meta = unknown> {
  path: string;
  cacheable: boolean;
  deps: string[];
  claims: { key: string; pack: string }[];
  meta: Meta;
  /** Packs that applied to the file, re-checked on a partial run. */
  packs: string[];
}

/**
 * Which files each summary belongs to. `summaries[i]` is reused while at
 * least one file in `owners[i]` is. An empty list marks a summary built
 * over the whole run, which a partial run always recomputes.
 */
export interface CacheAttribution<Meta = unknown> {
  roots: RootRecord<Meta>[];
  owners: string[][];
}

interface StoredRootMeta<Meta> {
  cacheable: boolean;
  /** Indices into the manifest's depPaths table. */
  deps: number[];
  claims: { key: string; pack: string }[];
  meta: Meta;
  packs: string[];
}

interface Manifest<Meta> {
  schemaVersion: string;
  adapterPacksDigest: string;
  configStamp: FileStamp | null;
  files: FileStamp[];
  summaries: BehavioralSummary[];
  /** The per-file layer. Absent when written without attribution. */
  roots?: string[];
  rootMeta?: StoredRootMeta<Meta>[];
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
   * under this run's schema, adapter, packs and config path.
   * `files-changed` means the include set is not the one the entry
   * was written from.
   */
  missReason?:
    | "no-manifest"
    | "key-changed"
    | "config-changed"
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
 * What a `files-changed` miss can still reuse. `validRoots` are the files
 * whose hashes and recorded dependencies are unchanged. The caller can
 * drop more of them, such as a file whose mount prefix no longer matches,
 * before calling `reuse`. `reuse` returns the summaries that belong to at
 * least one remaining file, in stored order, with their owners, so the
 * caller can merge them and write the result back.
 */
export interface PartialPlan<Meta = unknown> {
  /** Paths whose content hash differs, plus paths new to the set. */
  changed: Set<string>;
  removed: Set<string>;
  roots: Map<string, RootRecord<Meta>>;
  validRoots: Set<string>;
  rootsDeclined: number;
  reuse(valid: ReadonlySet<string>): {
    summaries: BehavioralSummary[];
    owners: string[][];
  };
  allSummaries(): BehavioralSummary[];
  /** The stored attribution decoded, for a write that changes nothing. */
  attribution(): CacheAttribution<Meta>;
}

export interface CacheLayer<Meta = unknown> {
  /** The summary list on a hit, null on a miss. */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * The lookup behind `tryHit`, with the reason for a miss. It only stats
   * files and never reads or parses them.
   */
  lookup(input: CacheInput): Promise<CacheLookup>;
  /**
   * After a `files-changed` miss: hash what the stats said moved and
   * work out which files' summaries survive. Null when the entry has
   * no per-file layer to reuse, or no entry matches the key at all.
   */
  plan(input: CacheInput): Promise<PartialPlan<Meta> | null>;
  /**
   * Save a fresh extraction's summaries against this file list, so a later
   * `lookup` with the same files returns them. Without `attribution` the
   * entry can only be reused whole.
   */
  write(
    input: CacheInput,
    summaries: BehavioralSummary[],
    attribution?: CacheAttribution<Meta>,
  ): Promise<void>;
}

export interface CacheInput {
  /** Absolute paths of every file the run walks. */
  files: ReadonlyArray<string>;
  adapterPacksDigest: string;
  /**
   * A file whose change invalidates the whole entry, such as a tsconfig or
   * a project manifest. Not every adapter has one.
   */
  configPath?: string;
}

/**
 * A cache layer rooted at `cacheDir`. With `null`, every lookup misses and
 * `write` does nothing, for a one-shot extract where the cache would only
 * add time.
 */
export function createCacheLayer<Meta = unknown>(
  cacheDir: string | null,
): CacheLayer<Meta> {
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
      const manifest = await readManifest<Meta>(
        path.join(entryDir, "manifest.json"),
      );
      if (manifest === null) {
        // The entry directory's name is a hash of the schema, digest and
        // config path, so a manifest found here already agrees with this
        // run on all three.
        return missDiag(await describeAbsentEntry(cacheDir));
      }
      const currentConfigStamp = await stampConfigFile(input.configPath);
      if (!fileStampEquals(manifest.configStamp, currentConfigStamp)) {
        return missDiag("config-changed");
      }
      const currentFiles = await resolveFileStamps(input);
      if (!fileStampsEqual(manifest.files, currentFiles)) {
        return missDiag("files-changed");
      }
      // Eviction keeps the most recently used entries, and a run that hits
      // never writes, so the hit has to mark the entry as used.
      await markUsed(entryDir);
      return {
        kind: "hit",
        summaries: manifest.summaries,
        diagnostic: { kind: "hit" },
      };
    },
    async plan(input: CacheInput): Promise<PartialPlan<Meta> | null> {
      const entryDir = entryDirFor(cacheDir, input);
      const manifest = await readManifest<Meta>(
        path.join(entryDir, "manifest.json"),
      );
      if (
        manifest === null ||
        manifest.roots === undefined ||
        manifest.rootMeta === undefined ||
        manifest.owners === undefined
      ) {
        return null;
      }
      const currentConfigStamp = await stampConfigFile(input.configPath);
      if (!fileStampEquals(manifest.configStamp, currentConfigStamp)) {
        return null;
      }
      await markUsed(entryDir);
      return buildPlan(manifest, await resolveFileStamps(input));
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
      attribution?: CacheAttribution<Meta>,
    ): Promise<void> {
      const entryDir = entryDirFor(cacheDir, input);
      const previous = await readManifest<Meta>(
        path.join(entryDir, "manifest.json"),
      );
      const configStamp = await stampConfigFile(input.configPath);
      const files = await hashStamps(await resolveFileStamps(input), previous);
      const manifest: Manifest<Meta> = {
        schemaVersion: SCHEMA_VERSION,
        adapterPacksDigest: input.adapterPacksDigest,
        configStamp,
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
 * Compare the stored per-file records against the current stamps. A file
 * whose stamp moved is read and hashed, so a touch that left the content
 * alone does not count as a change. A stored file without a hash counts as
 * changed whenever its stamp moved.
 */
async function buildPlan<Meta>(
  manifest: Manifest<Meta>,
  currentStamps: FileStamp[],
): Promise<PartialPlan<Meta>> {
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

  const roots = new Map<string, RootRecord<Meta>>();
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
      meta: meta.meta,
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

function encodeAttribution<Meta>(
  attribution: CacheAttribution<Meta>,
): Pick<Manifest<Meta>, "roots" | "rootMeta" | "depPaths" | "owners"> {
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
  const rootMeta: StoredRootMeta<Meta>[] = attribution.roots.map((r) => ({
    cacheable: r.cacheable,
    deps: r.deps.map(depIdOf),
    claims: r.claims,
    meta: r.meta,
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
async function hashStamps<Meta>(
  stamps: FileStamp[],
  previous: Manifest<Meta> | null,
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
 * Why a lookup did not find an entry: another build has cached here, or
 * nothing has. It reads the directory, which is cheap next to the
 * re-extraction a miss is about to start.
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
 * The directory for this run's entry. Everything a hit depends on besides
 * the file stamps goes into the name, so two builds that disagree write to
 * different directories instead of overwriting each other.
 */
function entryDirFor(cacheDir: string, input: CacheInput): string {
  const key = [
    SCHEMA_VERSION,
    input.adapterPacksDigest,
    input.configPath ?? "",
  ].join(" ");
  const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(cacheDir, `${ENTRY_PREFIX}${name}`);
}

/**
 * Eviction deletes recursively and a caller can point `cacheDir` at any
 * directory, so it only touches directories whose names this module
 * could have written.
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
    // Another process may have evicted the entry since the read. The
    // worst case is that the entry is evicted early and a later run
    // re-extracts.
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
    // A failed eviction only leaves extra entries on disk, whether another
    // process is writing to the directory or the run lacks permission.
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

async function readManifest<Meta>(
  manifestPath: string,
): Promise<Manifest<Meta> | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as Manifest<Meta>;
  } catch {
    // A missing, unparseable or unreadable manifest is a miss. The worst
    // case is an extraction the cache could have saved.
    return null;
  }
}

async function stampConfigFile(
  configPath: string | undefined,
): Promise<FileStamp | null> {
  if (configPath === undefined) {
    return null;
  }
  try {
    const stat = await fs.stat(configPath);
    return { path: configPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** Resolve the file list, sorted and stamped with mtime and size. */
async function resolveFileStamps(input: CacheInput): Promise<FileStamp[]> {
  // The stats run concurrently, limited by libuv's thread pool. On a
  // project of several thousand files they take around 25ms, most of the
  // cost of a whole-entry lookup.
  const stamped = await Promise.all(
    input.files.map(async (p) => {
      try {
        const stat = await fs.stat(p);
        return { path: p, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // The file was deleted after the list was made. The sentinel never
        // matches a stored stamp, so the lookup misses.
        return { path: p, mtimeMs: -1, size: -1 };
      }
    }),
  );
  // `fileStampsEqual` compares two lists position by position, so both
  // have to be in path order whatever order the caller listed the files in.
  stamped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return stamped;
}

/**
 * Whether two file lists have the same stamps. Both arrive sorted by path,
 * so one pass is enough. Content hashes are left out, since the fast
 * lookup compares stats alone and `plan` is where hashes are compared.
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
