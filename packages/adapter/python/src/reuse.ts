/**
 * Reusing a Python run's cache entry file by file.
 *
 * Each file's record says what its discovery found and what that depended
 * on, which wrapper registrations its routes made, and what the walk found
 * for each function written in the file. A run after an edit parses every
 * file and emits every fact again, works out which files and whose facts
 * changed, and replays each record whose dependencies are all unchanged.
 * The indexes the run builds over every file (router prefixes, wrapper
 * registrations, which method names a storage chain may start from) are
 * built again each run, and a record replays only when every lookup it
 * made in them comes back the same.
 */

import { EntryReuse, fileOfKey, noteLookup } from "@suss/resolution";

import { envLookupAgain } from "./envReads.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  Changes,
  StoredFileRecord,
  StoredWalkRecord,
} from "@suss/resolution";
import type { PythonDiscoveryPattern, PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { StoredScan, StoredTarget } from "./reach/closure.js";
import type { ReachedFunction } from "./reach/resolveCallee.js";
import type { BoundPythonFile, RouterIndex } from "./routers.js";
import type { ModuleBinding } from "./scope.js";
import type { FormOf, PythonWrapperIndex } from "./wrappers.js";

/** One unit a file's discovery produced, as the run that stored it finished it. */
export interface StoredUnit {
  readonly recognition?: string;
  /** The key of the function the unit's walk starts from, when it has one. */
  readonly seedKey?: string;
  /** The summary before parameter gaps were added. */
  readonly summary: BehavioralSummary;
}

/** A wrapper a file's routes registered, which a replay registers again in the same order. */
export interface StoredRegistration {
  readonly key: string;
  readonly name: string;
  readonly exportPath: string[];
  /** Where the form is declared: the pack, its pattern and the form, by position. */
  readonly form: readonly [number, number, number];
}

/** A file's load-time unit. */
export interface StoredModule {
  /** The key of the file's module node, when the walk started from it. */
  readonly seedKey: string | null;
  /** Null when the file does nothing at load time and has no unit. */
  readonly summary: BehavioralSummary | null;
}

/** What the walk found for one function, and what that depended on. */
export type StoredWalk = StoredWalkRecord<StoredScan, BehavioralSummary>;

/** Everything a Python run stores about one file. */
export interface PythonFileRecord
  extends StoredFileRecord<StoredScan, BehavioralSummary> {
  readonly units: readonly StoredUnit[];
  readonly registrations: readonly StoredRegistration[];
  readonly module: StoredModule;
}

/** Which of a stored entry's records a Python run can replay. */
export type PythonEntryReuse = EntryReuse<
  StoredScan,
  BehavioralSummary,
  PythonFileRecord
>;

function seedsOfRecord(record: PythonFileRecord): string[] {
  return [
    ...(record.module.seedKey === null ? [] : [record.module.seedKey]),
    ...record.units.flatMap((unit) =>
      unit.seedKey === undefined ? [] : [unit.seedKey],
    ),
  ];
}

/** The replay decision over a stored Python entry, given what changed. */
export function pythonEntryReuse(
  records: ReadonlyMap<string, PythonFileRecord>,
  changedFiles: ReadonlySet<string>,
  changes: Changes,
): PythonEntryReuse {
  return new EntryReuse(records, changedFiles, changes, seedsOfRecord);
}

/** The function a stored key refers to, found again in this run's trees. */
export function storedFunction(
  target: StoredTarget,
  definitions: ReadonlyMap<string, PyNode>,
  filesByPath: ReadonlyMap<string, BoundPythonFile>,
): ReachedFunction | null {
  const node = definitions.get(target.key);
  const file = filesByPath.get(fileOfKey(target.key));
  return node === undefined || file === undefined
    ? null
    : { file, node, name: target.name, exportPath: target.exportPath };
}

/** What an earlier run's walk found, for the bodies whose inputs have not changed since. */
export class WalkReplay {
  constructor(
    private readonly reuse: PythonEntryReuse,
    private readonly definitions: ReadonlyMap<string, PyNode>,
    private readonly filesByPath: ReadonlyMap<string, BoundPythonFile>,
  ) {}

  scanOf(key: string): StoredScan | undefined {
    return this.reuse.walkOf(key)?.scan;
  }

  /** The summary a reached function had before parameter gaps were added. */
  summaryOf(key: string): BehavioralSummary | undefined {
    return this.reuse.walkOf(key)?.summary;
  }

  functionOf(target: StoredTarget): ReachedFunction | null {
    return storedFunction(target, this.definitions, this.filesByPath);
  }
}

const COULD_MATCH = "couldMatch ";
const ROUTER = "router ";
const ROUTER_BUILT = "routerBuilt ";
const SEPARATOR = "\u0000";

/** The run's packs, patterns and forms by position, so a stored record can name one. */
export class PackPositions {
  private readonly patterns = new Map<PythonDiscoveryPattern, string>();

  constructor(private readonly packs: readonly PythonPack[]) {
    packs.forEach((pack, packAt) => {
      pack.discovery.forEach((pattern, patternAt) => {
        this.patterns.set(pattern, `${packAt}/${patternAt}`);
      });
    });
  }

  idOf(pattern: PythonDiscoveryPattern): string | undefined {
    return this.patterns.get(pattern);
  }

  patternOf(id: string): PythonDiscoveryPattern | undefined {
    const [packAt, patternAt] = id.split("/").map(Number);
    return this.packs[packAt ?? -1]?.discovery[patternAt ?? -1];
  }

  formAt(at: readonly [number, number, number]): FormOf | undefined {
    const pack = this.packs[at[0]];
    const pattern = pack?.discovery[at[1]];
    const form = pattern?.wrappers?.[at[2]];
    return pack === undefined || pattern === undefined || form === undefined
      ? undefined
      : { pack, pattern, form };
  }

  positionOf(declared: FormOf): readonly [number, number, number] | undefined {
    const packAt = this.packs.indexOf(declared.pack);
    const patternAt = declared.pack.discovery.indexOf(declared.pattern);
    const formAt = declared.pattern.wrappers?.indexOf(declared.form) ?? -1;
    return packAt === -1 || patternAt === -1 || formAt === -1
      ? undefined
      : [packAt, patternAt, formAt];
  }
}

/** A name set whose lookups are noted, for the storage recognizer's method names. */
export class WatchedNames extends Set<string> {
  constructor(
    names: Iterable<string>,
    private readonly db: Database,
  ) {
    super(names);
  }

  override has(name: string): boolean {
    const found = super.has(name);
    noteLookup(this.db, `${COULD_MATCH}${name}`, String(found));
    return found;
  }
}

/** A router index whose lookups are noted, keyed by where the pattern and module are. */
export function watchRouterIndex(
  index: RouterIndex,
  db: Database,
  positions: PackPositions,
  fileOfModule: ReadonlyMap<ModuleBinding, string>,
): RouterIndex {
  const note = (id: string, found: unknown): void => {
    noteLookup(db, id, JSON.stringify(found));
  };
  return {
    resolve(pattern, module, objectName) {
      const found = index.resolve(pattern, module, objectName);
      note(
        `${ROUTER}${[positions.idOf(pattern), fileOfModule.get(module), objectName].join(SEPARATOR)}`,
        found,
      );
      return found;
    },
    resolveConstruction(pattern, module, constructorName, constructionKey) {
      const found = index.resolveConstruction(
        pattern,
        module,
        constructorName,
        constructionKey,
      );
      note(
        `${ROUTER_BUILT}${[positions.idOf(pattern), fileOfModule.get(module), constructorName, constructionKey].join(SEPARATOR)}`,
        found,
      );
      return found;
    },
  };
}

/** Each noted lookup made again over this run's indexes, which must be the ones nothing watches. */
export function lookAgainIn(args: {
  db: Database;
  couldMatch: ReadonlySet<string>;
  routerIndex: RouterIndex;
  wrapperIndex: PythonWrapperIndex;
  positions: PackPositions;
  moduleOfFile: ReadonlyMap<string, ModuleBinding>;
}): (id: string) => string | null {
  const router = (
    rest: string,
    ask: (
      pattern: PythonDiscoveryPattern,
      module: ModuleBinding,
      parts: string[],
    ) => unknown,
  ): string | null => {
    const [patternId, file, ...parts] = rest.split(SEPARATOR);
    const pattern =
      patternId === undefined ? undefined : args.positions.patternOf(patternId);
    const module = file === undefined ? undefined : args.moduleOfFile.get(file);
    return pattern === undefined || module === undefined
      ? null
      : JSON.stringify(ask(pattern, module, parts));
  };
  return (id) => {
    if (id.startsWith(COULD_MATCH)) {
      return String(args.couldMatch.has(id.slice(COULD_MATCH.length)));
    }
    if (id.startsWith(ROUTER_BUILT)) {
      return router(
        id.slice(ROUTER_BUILT.length),
        (pattern, module, [constructorName, key]) =>
          args.routerIndex.resolveConstruction(
            pattern,
            module,
            constructorName ?? "",
            key ?? "",
          ),
      );
    }
    if (id.startsWith(ROUTER)) {
      return router(id.slice(ROUTER.length), (pattern, module, [name]) =>
        args.routerIndex.resolve(pattern, module, name ?? ""),
      );
    }
    return args.wrapperIndex.lookAgain(id) ?? envLookupAgain(args.db, id);
  };
}
