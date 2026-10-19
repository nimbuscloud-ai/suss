/**
 * The on-disk extraction cache, shared by every language adapter.
 *
 * A run reuses the previous run's summaries whole when nothing changed,
 * and per file when some files did. The entry directory's name is a hash
 * of the schema version, the adapter and packs digest, and the config
 * path. The manifest inside records a stamp and content hash per file,
 * the files each summary belongs to, and the other files each walk read.
 * The summaries are in one shard per source file, beside an index of the
 * boundaries and calls in each. An adapter's own data on a file's record,
 * `meta`, goes in that file's shard, and the cache never reads it. The
 * package's design notes describe the cache in full.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonFile, writeDocumentFile } from "@suss/behavioral-ir/files";

import {
  entriesByShard,
  entriesOf,
  indexOf,
  readStoreIndex,
  writeStoreIndex,
} from "./cacheIndex.js";
import { readShard, removeShardsOutside, writeShard } from "./cacheShards.js";
import {
  fileStampEquals,
  filesStillMatch,
  hashOf,
  hashRecentChanges,
  recordedStamp,
  startRun,
  stillMatches,
} from "./cacheStamps.js";
import { makeIgnoredDirectory } from "./ignoredDirectory.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ShardContent } from "./cacheShards.js";
import type { FileStamp, RunStart } from "./cacheStamps.js";

// 10: summaries and each file's meta moved out of the manifest into shards.
const SCHEMA_VERSION = "10";

const MANIFEST = "manifest.json";
const INDEX = "index.json";

/**
 * How many entries a cache directory keeps. Two lets a pair of builds
 * alternate, as on a branch switch or an adapter rebuild and revert,
 * without either losing its entry, and keeps a directory to two manifests.
 */
export const MAX_ENTRIES = 2;

const ENTRY_PREFIX = "key-";
const ENTRY_DIR_NAME = new RegExp(`^${ENTRY_PREFIX}[0-9a-f]{16}$`);

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
  /** The files this file imports, in the order the adapter's loader found them. */
  imports?: string[];
}

/**
 * What an adapter worked out about one unit of its own, such as the calls
 * one function body makes. `file` is the file the unit is in and `deps`
 * the other files that went into `data`. A partial run hands the record
 * back while `file` and every one of `deps` hash the same, so the adapter
 * can skip the work that produced it. The cache never reads `data`.
 */
export interface UnitRecord<Data = unknown> {
  key: string;
  file: string;
  deps: string[];
  data: Data;
}

/**
 * Which files each summary belongs to. `summaries[i]` is reused while at
 * least one file in `owners[i]` is. An empty list marks a summary built
 * over the whole run, which a partial run always recomputes.
 */
export interface CacheAttribution<Meta = unknown, UnitData = unknown> {
  roots: RootRecord<Meta>[];
  owners: string[][];
  units?: UnitRecord<UnitData>[];
}

/** A root's record without its `meta`, which is in the shard for the root's path. */
interface StoredRootMeta {
  cacheable: boolean;
  /** Indices into the manifest's depPaths table. */
  deps: number[];
  claims: { key: string; pack: string }[];
  packs: string[];
  /** Indices into the manifest's depPaths table. */
  imports?: number[];
}

interface ManifestShard {
  file: string;
  id: string;
  /** Where each of the shard's units comes in the run's summary list. */
  order: number[];
  /** Parallel to `order`: indices into roots. Absent without attribution. */
  owners?: number[][];
}

/** A unit record with its paths stored as indices into depPaths. */
interface StoredUnit<UnitData> {
  key: string;
  file: number;
  deps: number[];
  data: UnitData;
}

interface Manifest<UnitData> {
  schemaVersion: string;
  adapterPacksDigest: string;
  configStamp: FileStamp | null;
  files: FileStamp[];
  summaryCount: number;
  /** One per source file that has units or a record, sorted by file. */
  shards: ManifestShard[];
  /** The per-file layer. Absent when written without attribution. */
  roots?: string[];
  rootMeta?: StoredRootMeta[];
  depPaths?: string[];
  units?: StoredUnit<UnitData>[];
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
export interface PartialPlan<Meta = unknown, UnitData = unknown> {
  /** Paths whose content hash differs, plus paths new to the set. */
  changed: Set<string>;
  removed: Set<string>;
  /**
   * The stored import list of every file whose content is unchanged, when
   * no file joined or left the set, since either can move where an import
   * resolves. Empty otherwise.
   */
  resolvedImports: Map<string, string[]>;
  roots: Map<string, RootRecord<Meta>>;
  validRoots: Set<string>;
  rootsDeclined: number;
  /** Unit records whose file and deps are all unchanged, by key. */
  validUnits: Map<string, UnitRecord<UnitData>>;
  reuse(valid: ReadonlySet<string>): {
    summaries: BehavioralSummary[];
    owners: string[][];
  };
  allSummaries(): BehavioralSummary[];
  /** The stored attribution decoded, for a write that changes nothing. */
  attribution(): CacheAttribution<Meta, UnitData>;
}

export interface CacheLayer<Meta = unknown, UnitData = unknown> {
  /** The summary list on a hit, null on a miss. */
  tryHit(input: CacheInput): Promise<BehavioralSummary[] | null>;
  /**
   * The lookup behind `tryHit`, with the reason for a miss. It stats the
   * files, and reads only those changed shortly before, to hash them.
   */
  lookup(input: CacheInput): Promise<CacheLookup>;
  /**
   * After a `files-changed` miss: hash what the stats said moved and
   * work out which files' summaries survive. Null when the entry has
   * no per-file layer to reuse, or no entry matches the key at all.
   */
  plan(input: CacheInput): Promise<PartialPlan<Meta, UnitData> | null>;
  /**
   * Save a fresh extraction's summaries against this file list, so a later
   * `lookup` with the same files returns them. Without `attribution` the
   * entry can only be reused whole.
   */
  write(
    input: CacheInput,
    summaries: BehavioralSummary[],
    attribution?: CacheAttribution<Meta, UnitData>,
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
 * Each summary owned by the walked file it is written in, or by no file
 * when it is written outside every walked file. For an adapter that
 * replays its own per-file records rather than calling `reuse`.
 */
export function ownersWhereWritten(
  summaries: readonly BehavioralSummary[],
  walkedFileOf: (locationFile: string) => string | undefined,
): string[][] {
  return summaries.map((summary) => {
    const walked = walkedFileOf(summary.location.file);
    return walked === undefined ? [] : [walked];
  });
}

/**
 * A cache layer rooted at `cacheDir`. With `null`, every lookup misses and
 * `write` does nothing, for a one-shot extract where the cache would only
 * add time.
 */
export function createCacheLayer<Meta = unknown, UnitData = unknown>(
  cacheDir: string | null,
): CacheLayer<Meta, UnitData> {
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
  const manifests = new ManifestReads<UnitData>();
  // What each run saw before it read anything, keyed by the input it
  // passes to every call. A run starts at its lookup.
  const runs = new WeakMap<CacheInput, RunStart>();
  const runFor = async (input: CacheInput): Promise<RunStart> =>
    runs.get(input) ?? (await startRun(input.files, input.configPath));

  const lookupWith = async (
    input: CacheInput,
    run: RunStart,
  ): Promise<CacheLookup> => {
    const entryDir = entryDirFor(cacheDir, input);
    const manifest = await manifests.readAtRunStart(
      path.join(entryDir, MANIFEST),
    );
    if (manifest === null) {
      // The entry directory's name is a hash of the schema, digest and
      // config path, so a manifest found here already agrees with this
      // run on all three.
      return missDiag(await describeAbsentEntry(cacheDir));
    }
    if (
      !(await stillMatches(
        manifest.configStamp,
        run.config?.stamp ?? null,
        run,
      ))
    ) {
      return missDiag("config-changed");
    }
    if (!(await filesStillMatch(manifest.files, run))) {
      return missDiag("files-changed");
    }
    const shards = readShards<Meta, UnitData>(
      entryDir,
      manifest,
      (shard) => shard.order.length > 0,
    );
    const summaries = shards === null ? null : inRunOrder(manifest, shards);
    if (summaries === null) {
      // Another process may have replaced the entry between the two reads.
      return missDiag("no-manifest");
    }
    // Eviction keeps the most recently used entries, and a run that hits
    // never writes, so the hit has to mark the entry as used.
    await markUsed(entryDir);
    manifests.forget();
    return {
      kind: "hit",
      summaries,
      diagnostic: { kind: "hit" },
    };
  };

  return {
    async tryHit(input: CacheInput): Promise<BehavioralSummary[] | null> {
      const result = await this.lookup(input);
      return result.kind === "hit" ? result.summaries : null;
    },
    async lookup(input: CacheInput): Promise<CacheLookup> {
      const run = await startRun(input.files, input.configPath);
      runs.set(input, run);
      const result = await lookupWith(input, run);
      // A miss goes on to read files and write an entry, which records
      // these hashes for the files a stamp cannot vouch for.
      if (result.kind === "miss") {
        await hashRecentChanges(run);
      }
      return result;
    },
    async plan(input: CacheInput): Promise<PartialPlan<Meta, UnitData> | null> {
      const entryDir = entryDirFor(cacheDir, input);
      const manifest = await manifests.readAgain(path.join(entryDir, MANIFEST));
      if (
        manifest === null ||
        manifest.roots === undefined ||
        manifest.rootMeta === undefined
      ) {
        return null;
      }
      const run = await runFor(input);
      if (
        !(await stillMatches(
          manifest.configStamp,
          run.config?.stamp ?? null,
          run,
        ))
      ) {
        return null;
      }
      // Every unchanged file's record is checked again, so every shard is read.
      const shards = readShards<Meta, UnitData>(entryDir, manifest, () => true);
      const summaries = shards === null ? null : inRunOrder(manifest, shards);
      if (shards === null || summaries === null) {
        return null;
      }
      await markUsed(entryDir);
      return buildPlan(manifest, shards, summaries, run);
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
      attribution?: CacheAttribution<Meta, UnitData>,
    ): Promise<void> {
      const entryDir = entryDirFor(cacheDir, input);
      // Only the file stamps and shard ids are read from the previous entry.
      const previous = await manifests.readAgain(path.join(entryDir, MANIFEST));
      manifests.forget();
      // A write with no lookup before it stats the files now, after they
      // were read, so it can only guard the files changed recently.
      const known = runs.get(input);
      const run = known ?? (await runFor(input));
      if (known === undefined) {
        await hashRecentChanges(run);
      }
      runs.delete(input);
      const configStamp =
        run.config === null
          ? null
          : await recordedStamp(run.config, run, undefined);
      const prior = new Map((previous?.files ?? []).map((f) => [f.path, f]));
      const recorded = await Promise.all(
        run.files.map((file) =>
          recordedStamp(file, run, prior.get(file.stamp.path)),
        ),
      );
      const files = recorded.filter((stamp) => stamp !== null);
      const encoded =
        attribution === undefined ? null : encodeAttribution(attribution);
      makeIgnoredDirectory(cacheDir);
      // The shards and the index go first, so a manifest on disk only
      // ever points at shards that are there.
      const shards = writeShards(entryDir, summaries, attribution, encoded);
      const manifest: Manifest<UnitData> = {
        schemaVersion: SCHEMA_VERSION,
        adapterPacksDigest: input.adapterPacksDigest,
        configStamp,
        files,
        summaryCount: summaries.length,
        shards,
        ...(encoded === null ? {} : encoded.stored),
      };
      writeDocumentFile(path.join(entryDir, MANIFEST), manifest);
      removeShardsOutside(
        entryDir,
        new Set(
          [...shards, ...(previous?.shards ?? [])].map((shard) => shard.id),
        ),
      );
      await evictOldEntries(cacheDir, entryDir);
    },
  };
}

/**
 * Writes one shard per source file, each unit going to the shard for its
 * `location.file` and each root's meta to the shard for its path, then
 * the index over them. Returns the manifest's list of shards.
 */
function writeShards<Meta, UnitData>(
  entryDir: string,
  summaries: readonly BehavioralSummary[],
  attribution: CacheAttribution<Meta, UnitData> | undefined,
  encoded: EncodedAttribution<UnitData> | null,
): ManifestShard[] {
  const byFile = new Map<
    string,
    { content: ShardContent<Meta>; order: number[]; owners: number[][] }
  >();
  const shardFor = (file: string) => {
    const known = byFile.get(file);
    if (known !== undefined) {
      return known;
    }
    const created = {
      content: { file, units: [] } as ShardContent<Meta>,
      order: [] as number[],
      owners: [] as number[][],
    };
    byFile.set(file, created);
    return created;
  };
  summaries.forEach((summary, position) => {
    const shard = shardFor(summary.location?.file ?? "");
    shard.content.units.push(summary);
    shard.order.push(position);
    shard.owners.push(encoded?.owners[position] ?? []);
  });
  for (const root of attribution?.roots ?? []) {
    shardFor(root.path).content.record = { meta: root.meta };
  }

  const indexFile = path.join(entryDir, INDEX);
  const before = readStoreIndex(indexFile);
  const known = before === null ? new Map() : entriesByShard(before);
  const written = [...byFile.keys()].sort().map((file) => {
    const { content, order, owners } = shardFor(file);
    const id = writeShard(entryDir, content);
    return {
      shard: {
        file,
        id,
        order,
        ...(encoded === null ? {} : { owners }),
      },
      entries: known.get(id) ?? entriesOf(content.units),
    };
  });
  writeStoreIndex(
    indexFile,
    indexOf(
      written.map(({ shard, entries }) => ({
        file: shard.file,
        id: shard.id,
        entries,
      })),
    ),
  );
  return written.map(({ shard }) => shard);
}

/**
 * The shards `wanted` picks, read by file. Null when one of them cannot
 * be read, which a caller treats as no entry at all.
 */
function readShards<Meta, UnitData>(
  entryDir: string,
  manifest: Manifest<UnitData>,
  wanted: (shard: ManifestShard) => boolean,
): Map<string, ShardContent<Meta>> | null {
  const shards = new Map<string, ShardContent<Meta>>();
  for (const shard of manifest.shards ?? []) {
    if (!wanted(shard)) {
      continue;
    }
    const content = readShard<Meta>(entryDir, shard.id, shard.file);
    if (content === null || content.units.length !== shard.order.length) {
      return null;
    }
    shards.set(shard.file, content);
  }
  return shards;
}

/** Every stored summary in the order the run wrote them, or null when a slot is missing. */
function inRunOrder<Meta, UnitData>(
  manifest: Manifest<UnitData>,
  shards: ReadonlyMap<string, ShardContent<Meta>>,
): BehavioralSummary[] | null {
  const summaries = new Array<BehavioralSummary | undefined>(
    manifest.summaryCount,
  );
  for (const shard of manifest.shards ?? []) {
    const content = shards.get(shard.file);
    if (content === undefined) {
      continue;
    }
    shard.order.forEach((position, i) => {
      summaries[position] = content.units[i];
    });
  }
  for (let position = 0; position < summaries.length; position++) {
    if (summaries[position] === undefined) {
      return null;
    }
  }
  return summaries as BehavioralSummary[];
}

/**
 * Compare the stored per-file records against the run's stamps. A file
 * whose stamp moved, or whose entry asks for it, is hashed, so a touch
 * that left the content alone does not count as a change. A stored file
 * without a hash counts as changed whenever its stamp moved.
 */
async function buildPlan<Meta, UnitData>(
  manifest: Manifest<UnitData>,
  shards: ReadonlyMap<string, ShardContent<Meta>>,
  stored: BehavioralSummary[],
  run: RunStart,
): Promise<PartialPlan<Meta, UnitData>> {
  const { changed, added, removed } = await changedSince(manifest, run);

  const roots = new Map<string, RootRecord<Meta>>();
  const rootNames = manifest.roots ?? [];
  const depPaths = manifest.depPaths ?? [];
  const pathsOf = (ids: number[]): string[] =>
    ids.flatMap((d) => {
      const p = depPaths[d];
      return p === undefined ? [] : [p];
    });
  let rootsDeclined = 0;
  rootNames.forEach((rootPath, i) => {
    const record = manifest.rootMeta?.[i];
    if (record === undefined) {
      return;
    }
    if (!record.cacheable) {
      rootsDeclined += 1;
    }
    roots.set(rootPath, {
      path: rootPath,
      cacheable: record.cacheable,
      deps: pathsOf(record.deps),
      claims: record.claims,
      meta: shards.get(rootPath)?.record?.meta as Meta,
      packs: record.packs,
      ...(record.imports === undefined
        ? {}
        : { imports: pathsOf(record.imports) }),
    });
  });

  // A file or dependency that moved invalidates whatever was read from it.
  const current = new Set(run.files.map((f) => f.stamp.path));
  const unchanged = (filePath: string, deps: readonly string[]): boolean =>
    current.has(filePath) &&
    !changed.has(filePath) &&
    !deps.some((d) => changed.has(d) || removed.has(d));

  const validRoots = new Set<string>();
  for (const [rootPath, record] of roots) {
    if (record.cacheable && unchanged(rootPath, record.deps)) {
      validRoots.add(rootPath);
    }
  }

  const units = (manifest.units ?? []).flatMap((unit) => {
    const file = depPaths[unit.file];
    return file === undefined
      ? []
      : [
          {
            key: unit.key,
            file,
            deps: pathsOf(unit.deps),
            data: unit.data,
          },
        ];
  });
  const validUnits = new Map<string, UnitRecord<UnitData>>();
  for (const unit of units) {
    if (unchanged(unit.file, unit.deps)) {
      validUnits.set(unit.key, unit);
    }
  }

  const resolvedImports = new Map<string, string[]>();
  if (added.size === 0 && removed.size === 0) {
    for (const [rootPath, record] of roots) {
      if (record.imports !== undefined && !changed.has(rootPath)) {
        resolvedImports.set(rootPath, record.imports);
      }
    }
  }

  const ownerPaths = ownersInRunOrder(manifest);
  return {
    changed,
    removed,
    resolvedImports,
    roots,
    validRoots,
    rootsDeclined,
    validUnits,
    reuse(valid: ReadonlySet<string>) {
      const summaries: BehavioralSummary[] = [];
      const reusedOwners: string[][] = [];
      stored.forEach((summary, i) => {
        const owners = ownerPaths[i] ?? [];
        if (owners.some((p) => valid.has(p))) {
          summaries.push(summary);
          reusedOwners.push(owners.filter((p) => valid.has(p)));
        }
      });
      return { summaries, owners: reusedOwners };
    },
    allSummaries() {
      return stored;
    },
    attribution() {
      return {
        roots: [...roots.values()],
        owners: ownerPaths,
        units,
      };
    },
  };
}

/** Each stored summary's owners as paths, in the order the run wrote the summaries. */
function ownersInRunOrder<UnitData>(manifest: Manifest<UnitData>): string[][] {
  const rootNames = manifest.roots ?? [];
  const owners: string[][] = Array.from(
    { length: manifest.summaryCount },
    () => [],
  );
  for (const shard of manifest.shards ?? []) {
    shard.order.forEach((position, i) => {
      owners[position] = (shard.owners?.[i] ?? []).flatMap((o) => {
        const p = rootNames[o];
        return p === undefined ? [] : [p];
      });
    });
  }
  return owners;
}

/**
 * Which files changed since the entry was written. A file whose stamp
 * moved, or whose entry asks for it, is hashed, so a touch that left the
 * content alone does not count as a change. A stored file without a hash
 * counts as changed whenever its stamp moved.
 */
async function changedSince<UnitData>(
  manifest: Manifest<UnitData>,
  run: RunStart,
): Promise<{
  changed: Set<string>;
  added: Set<string>;
  removed: Set<string>;
}> {
  const stored = new Map(manifest.files.map((f) => [f.path, f]));
  const current = new Map(run.files.map((f) => [f.stamp.path, f.stamp]));

  const changed = new Set<string>();
  const added = new Set<string>();
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
      added.add(p);
    } else if (!fileStampEquals(before, stamp)) {
      if (before.contentHash === undefined) {
        changed.add(p);
      } else {
        toVerify.push(p);
      }
    } else if (before.verifyHash === true) {
      toVerify.push(p);
    }
  }
  await Promise.all(
    toVerify.map(async (p) => {
      const hash = await hashOf(run, p);
      if (hash === null || hash !== stored.get(p)?.contentHash) {
        changed.add(p);
      }
    }),
  );
  return { changed, added, removed };
}

/** The attribution as the manifest stores it, with each summary's owners as root positions. */
interface EncodedAttribution<UnitData> {
  stored: Pick<Manifest<UnitData>, "roots" | "rootMeta" | "depPaths" | "units">;
  /** Parallel to the summaries written. */
  owners: number[][];
}

function encodeAttribution<Meta, UnitData>(
  attribution: CacheAttribution<Meta, UnitData>,
): EncodedAttribution<UnitData> {
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
    packs: r.packs,
    ...(r.imports === undefined ? {} : { imports: r.imports.map(depIdOf) }),
  }));
  const owners = attribution.owners.map((ownerPaths) =>
    ownerPaths.flatMap((p) => {
      const i = rootIndex.get(p);
      return i === undefined ? [] : [i];
    }),
  );
  const units = attribution.units?.map((unit) => ({
    key: unit.key,
    file: depIdOf(unit.file),
    deps: unit.deps.map(depIdOf),
    data: unit.data,
  }));
  return {
    stored: {
      roots,
      rootMeta,
      depPaths,
      ...(units === undefined ? {} : { units }),
    },
    owners,
  };
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

/**
 * One parse of the manifest per run. A partial run looks the entry up,
 * plans from it and writes it back, and the manifest lists every file
 * of the project, so each parse has a cost on a large one.
 *
 * `lookup` always reads the file, because a run starts there and another
 * process may have written the entry since the last run. `plan` and
 * `write` reuse that parse while the file on disk is the one it came
 * from. A hit or a write drops the parse, so the next run reads the
 * file again.
 */
class ManifestReads<UnitData> {
  private last: {
    path: string;
    stamp: string | null;
    manifest: Manifest<UnitData> | null;
  } | null = null;

  async readAtRunStart(
    manifestPath: string,
  ): Promise<Manifest<UnitData> | null> {
    const stamp = await manifestStamp(manifestPath);
    const manifest = await readManifest<UnitData>(manifestPath);
    this.last = { path: manifestPath, stamp, manifest };
    return manifest;
  }

  async readAgain(manifestPath: string): Promise<Manifest<UnitData> | null> {
    const last = this.last;
    if (
      last !== null &&
      last.path === manifestPath &&
      last.stamp !== null &&
      last.stamp === (await manifestStamp(manifestPath))
    ) {
      return last.manifest;
    }
    return await this.readAtRunStart(manifestPath);
  }

  forget(): void {
    this.last = null;
  }
}

/** Null when there is no manifest, so an absent file is never reused. */
async function manifestStamp(manifestPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(manifestPath);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

async function readManifest<UnitData>(
  manifestPath: string,
): Promise<Manifest<UnitData> | null> {
  try {
    const manifest = readJsonFile(manifestPath) as Manifest<UnitData>;
    return Array.isArray(manifest.shards) ? manifest : null;
  } catch {
    // A missing, unparseable or unreadable manifest is a miss. The worst
    // case is an extraction the cache could have saved.
    return null;
  }
}
