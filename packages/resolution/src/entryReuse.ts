/**
 * Which records of a stored cache entry a run can replay, for an adapter
 * that stores one record per file: what the file's discovery depended
 * on, and what the walk found for each function written in the file.
 *
 * A function's walk record is valid while nothing it depended on changed.
 * A file's discovery record is valid while nothing its discovery depended
 * on changed and the walk records of the functions its units start from
 * are valid too, since those units' summaries carry what the walk placed
 * on them.
 */

import { stillValid } from "./dependencyLedger.js";

import type {
  Changes,
  Dependencies,
  StoredDependencies,
  StoredFacts,
} from "./dependencyLedger.js";

/** What the walk found for one function, and what that depended on. */
export interface StoredWalkRecord<Scan, Summary> {
  readonly key: string;
  readonly dependencies: StoredDependencies;
  readonly scan: Scan;
  /** A reached function's summary before parameter gaps were added. Absent for a function a unit starts from. */
  readonly summary?: Summary;
}

/** The parts of a file's record every adapter stores. */
export interface StoredFileRecord<Scan, Summary> {
  readonly discovery: StoredDependencies;
  readonly walked: readonly StoredWalkRecord<Scan, Summary>[];
  readonly facts: StoredFacts;
}

/** The file a node key is written in. */
export function fileOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

export class EntryReuse<
  Scan,
  Summary,
  Record extends StoredFileRecord<Scan, Summary>,
> {
  private readonly walks = new Map<string, StoredWalkRecord<Scan, Summary>>();
  private readonly walkValid = new Map<string, boolean>();
  private readonly discoveryValid = new Map<string, boolean>();

  constructor(
    readonly records: ReadonlyMap<string, Record>,
    readonly changedFiles: ReadonlySet<string>,
    private readonly changes: Changes,
    /** The keys of the functions a file's units start from. */
    private readonly seedsOf: (record: Record) => Iterable<string>,
  ) {
    for (const record of records.values()) {
      for (const walk of record.walked) {
        this.walks.set(walk.key, walk);
      }
    }
  }

  /** The walk record for a function, when nothing it depended on changed. */
  walkOf(key: string): StoredWalkRecord<Scan, Summary> | undefined {
    const walk = this.walks.get(key);
    if (walk === undefined) {
      return undefined;
    }
    let valid = this.walkValid.get(key);
    if (valid === undefined) {
      valid =
        !this.changedFiles.has(fileOfKey(key)) &&
        stillValid(walk.dependencies, this.changes);
      this.walkValid.set(key, valid);
    }
    return valid ? walk : undefined;
  }

  /** The record of a file whose discovery can be replayed. */
  discoveryOf(file: string): Record | undefined {
    const record = this.records.get(file);
    if (record === undefined || this.changedFiles.has(file)) {
      return undefined;
    }
    let valid = this.discoveryValid.get(file);
    if (valid === undefined) {
      valid =
        stillValid(record.discovery, this.changes) &&
        [...this.seedsOf(record)].every(
          (key) => this.walkOf(key) !== undefined,
        );
      this.discoveryValid.set(file, valid);
    }
    return valid ? record : undefined;
  }
}

/**
 * The walk records to store, by the file each function is written in.
 * A replayed scan keeps its stored dependencies, with anything the run
 * added for it, such as a summary built again, merged in.
 */
export function walkRecordsByFile<Scan, Summary>(args: {
  scans: ReadonlyMap<string, Scan>;
  charges: ReadonlyMap<string, Dependencies>;
  beforeGaps: ReadonlyMap<string, Summary>;
  replayed: (key: string) => StoredWalkRecord<Scan, Summary> | undefined;
  store: (dependencies: Dependencies) => StoredDependencies;
  merge: (
    one: StoredDependencies,
    other: StoredDependencies,
  ) => StoredDependencies;
}): Map<string, StoredWalkRecord<Scan, Summary>[]> {
  const byFile = new Map<string, StoredWalkRecord<Scan, Summary>[]>();
  for (const [key, scan] of args.scans) {
    const stored = args.replayed(key);
    const charge = args.charges.get(key);
    let dependencies: StoredDependencies;
    if (stored !== undefined && stored.scan === scan) {
      dependencies =
        charge === undefined
          ? stored.dependencies
          : args.merge(stored.dependencies, args.store(charge));
    } else {
      dependencies = args.store(
        charge ?? { files: new Set(), values: new Set(), checks: new Map() },
      );
    }
    const summary = args.beforeGaps.get(key);
    const walk: StoredWalkRecord<Scan, Summary> = {
      key,
      dependencies,
      scan,
      ...(summary === undefined ? {} : { summary }),
    };
    const file = fileOfKey(key);
    byFile.set(file, [...(byFile.get(file) ?? []), walk]);
  }
  return byFile;
}

/**
 * The records an entry's roots carry, when every root has one and no
 * file was added or removed since. An added or removed file can change
 * what a name binds to and which file a path leads to, which no record
 * says, so the run starts over instead.
 */
export function recordsToReplay<Record extends { readonly discovery: unknown }>(
  roots: ReadonlyMap<string, { readonly meta: unknown }>,
  changed: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Map<string, Record> | null {
  if (removed.size > 0 || roots.size === 0) {
    return null;
  }
  const records = new Map<string, Record>();
  for (const [file, root] of roots) {
    const meta = root.meta as Record | undefined;
    if (meta?.discovery === undefined) {
      return null;
    }
    records.set(file, meta);
  }
  for (const file of changed) {
    if (!records.has(file)) {
      return null;
    }
  }
  return records;
}
