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

import {
  fileStampEquals,
  filesStillMatch,
  hashOf,
  hashRecentChanges,
  recordedStamp,
  startRun,
  stillMatches,
} from "./cacheStamps.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { FileStamp, RunStart } from "./cacheStamps.js";

// 9: stamps come from before the run read the files, not from the write.
const SCHEMA_VERSION = "9";

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

interface StoredRootMeta<Meta> {
  cacheable: boolean;
  /** Indices into the manifest's depPaths table. */
  deps: number[];
  claims: { key: string; pack: string }[];
  meta: Meta;
  packs: string[];
  /** Indices into the manifest's depPaths table. */
  imports?: number[];
}

/** A unit record with its paths stored as indices into depPaths. */
interface StoredUnit<UnitData> {
  key: string;
  file: number;
  deps: number[];
  data: UnitData;
}

interface Manifest<Meta, UnitData> {
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
  const manifests = new ManifestReads<Meta, UnitData>();
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
      path.join(entryDir, "manifest.json"),
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
    // Eviction keeps the most recently used entries, and a run that hits
    // never writes, so the hit has to mark the entry as used.
    await markUsed(entryDir);
    // The caller owns these summaries now and may change them.
    manifests.forget();
    return {
      kind: "hit",
      summaries: manifest.summaries,
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
      const manifest = await manifests.readAgain(
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
      await markUsed(entryDir);
      return buildPlan(manifest, run);
    },
    async write(
      input: CacheInput,
      summaries: BehavioralSummary[],
      attribution?: CacheAttribution<Meta, UnitData>,
    ): Promise<void> {
      const entryDir = entryDirFor(cacheDir, input);
      // Only the file stamps are read from the previous entry. The caller
      // may have changed the summaries a plan handed out, which is fine here.
      const previous = await manifests.readAgain(
        path.join(entryDir, "manifest.json"),
      );
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
      const manifest: Manifest<Meta, UnitData> = {
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
 * Compare the stored per-file records against the run's stamps. A file
 * whose stamp moved, or whose entry asks for it, is hashed, so a touch
 * that left the content alone does not count as a change. A stored file
 * without a hash counts as changed whenever its stamp moved.
 */
async function buildPlan<Meta, UnitData>(
  manifest: Manifest<Meta, UnitData>,
  run: RunStart,
): Promise<PartialPlan<Meta, UnitData>> {
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
      deps: pathsOf(meta.deps),
      claims: meta.claims,
      meta: meta.meta,
      packs: meta.packs,
      ...(meta.imports === undefined ? {} : { imports: pathsOf(meta.imports) }),
    });
  });

  // A file or dependency that moved invalidates whatever was read from it.
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

  const units = (manifest.units ?? []).flatMap((stored) => {
    const file = depPaths[stored.file];
    return file === undefined
      ? []
      : [
          {
            key: stored.key,
            file,
            deps: pathsOf(stored.deps),
            data: stored.data,
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

  const owners = manifest.owners ?? [];
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
        units,
      };
    },
  };
}

function encodeAttribution<Meta, UnitData>(
  attribution: CacheAttribution<Meta, UnitData>,
): Pick<
  Manifest<Meta, UnitData>,
  "roots" | "rootMeta" | "depPaths" | "owners" | "units"
> {
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
    roots,
    rootMeta,
    depPaths,
    owners,
    ...(units === undefined ? {} : { units }),
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
 * plans from it and writes it back, and on a large project each parse
 * of the manifest costs about half a second.
 *
 * `lookup` always reads the file, because a run starts there and another
 * process may have written the entry since the last run. `plan` and
 * `write` reuse that parse while the file on disk is the one it came
 * from. Once a hit hands the summaries to the caller, or a write
 * replaces the entry, the parse is dropped, since the caller may change
 * the summaries it was given.
 */
class ManifestReads<Meta, UnitData> {
  private last: {
    path: string;
    stamp: string | null;
    manifest: Manifest<Meta, UnitData> | null;
  } | null = null;

  async readAtRunStart(
    manifestPath: string,
  ): Promise<Manifest<Meta, UnitData> | null> {
    const stamp = await manifestStamp(manifestPath);
    const manifest = await readManifest<Meta, UnitData>(manifestPath);
    this.last = { path: manifestPath, stamp, manifest };
    return manifest;
  }

  async readAgain(
    manifestPath: string,
  ): Promise<Manifest<Meta, UnitData> | null> {
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

async function readManifest<Meta, UnitData>(
  manifestPath: string,
): Promise<Manifest<Meta, UnitData> | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as Manifest<Meta, UnitData>;
  } catch {
    // A missing, unparseable or unreadable manifest is a miss. The worst
    // case is an extraction the cache could have saved.
    return null;
  }
}
