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

import {
  EntryReuse,
  fileOfKey,
  noteLookup,
  plainKeyOf,
  variantKey,
} from "@suss/resolution";

import { envLookupAgain } from "./envReads.js";
import { factSourceOf } from "./factSource.js";
import { resolveModule } from "./moduleResolver.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  Changes,
  StoredFileRecord,
  StoredWalkRecord,
} from "@suss/resolution";
import type { BoundPythonFile } from "./boundFiles.js";
import type { ModuleResolution, RelativeModuleSpec } from "./moduleResolver.js";
import type { PythonDiscoveryPattern, PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { StoredScan, StoredTarget } from "./reach/closure.js";
import type { ReachedFunction } from "./reach/resolveCallee.js";
import type { DeclaredRouteIndex } from "./routeTables.js";
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
export type StoredRegistration =
  | StoredFormRegistration
  | StoredClosureRegistration;

/** A wrapper a pack's form registered. */
export interface StoredFormRegistration {
  readonly key: string;
  readonly name: string;
  readonly exportPath: string[];
  /** Where the form is declared: the pack, its pattern and the form, by position. */
  readonly form: readonly [number, number, number];
}

/** The closure a project's decorator hands back, read with a route's pattern. */
export interface StoredClosureRegistration {
  readonly key: string;
  readonly name: string;
  readonly exportPath: string[];
  /** The route's pattern, as `PackPositions.idOf` gives it. */
  readonly pattern: string;
  /** The decorator's parameter the closure calls to run the route's function. */
  readonly continuation: string;
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
  const plainKey = plainKeyOf(target.key);
  const node = definitions.get(plainKey);
  const file = filesByPath.get(fileOfKey(target.key));
  const key =
    target.receiverClass === undefined
      ? plainKey
      : variantKey(plainKey, target.receiverClass);
  if (node === undefined || file === undefined || key !== target.key) {
    return null;
  }
  const found = {
    file,
    node,
    name: target.name,
    exportPath: target.exportPath,
  };
  return target.receiverClass === undefined
    ? found
    : { ...found, receiverClass: target.receiverClass };
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

const ROUTES_DECLARED = "routesDeclared ";
const MODULE_NAMED = "moduleNamed ";
const SEPARATOR = "\u0000";

/**
 * What a module name led to from a file: a file of the run, a package
 * with no file of its own, or nothing. A file added at that path changes
 * the answer, which no fact of the run says.
 */
export function moduleFound(
  resolution: ModuleResolution,
  inRun: (file: string) => boolean,
): string {
  if (resolution.status !== "resolved") {
    return resolution.reason === "external" ? "package" : "none";
  }
  return inRun(resolution.file) ? resolution.file : "none";
}

/** Note what a module name led to from a file, so a later run looks it up again. */
export function noteModuleNamed(
  db: Database,
  from: string,
  spec: RelativeModuleSpec,
  found: string,
): void {
  noteLookup(
    db,
    `${MODULE_NAMED}${[from, spec.module, spec.relativeLevel].join(SEPARATOR)}`,
    found,
  );
}

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

  packOf(id: string): PythonPack | undefined {
    const [packAt] = id.split("/").map(Number);
    return this.packs[packAt ?? -1];
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

/** The run's route tables, with what each decorator declares noted, keyed by where the pattern is and the decorator's call. */
export function watchRouteTables(
  routes: DeclaredRouteIndex,
  db: Database,
  positions: PackPositions,
): DeclaredRouteIndex {
  return {
    routesAt(pattern, decorator) {
      const found = routes.routesAt(pattern, decorator);
      noteLookup(
        db,
        `${ROUTES_DECLARED}${[positions.idOf(pattern), decorator].join(SEPARATOR)}`,
        JSON.stringify(found),
      );
      return found;
    },
    // The wrapper index notes what it reads through the mounts, in terms
    // it can look up again.
    mountsAbove: routes.mountsAbove,
    // Read once a run, after every discovery, so no replay depends on them.
    unfollowed: routes.unfollowed,
    declared: routes.declared,
  };
}

/** Each noted lookup made again over this run's indexes, which must be the ones nothing watches. */
export function lookAgainIn(args: {
  db: Database;
  routes: DeclaredRouteIndex;
  wrapperIndex: PythonWrapperIndex;
  positions: PackPositions;
  moduleOfFile: ReadonlyMap<string, ModuleBinding>;
  roots: string[];
}): (id: string) => string | null {
  return (id) => {
    if (id.startsWith(ROUTES_DECLARED)) {
      const [patternId = "", decorator = ""] = id
        .slice(ROUTES_DECLARED.length)
        .split(SEPARATOR);
      const pattern = args.positions.patternOf(patternId);
      return pattern === undefined
        ? null
        : JSON.stringify(args.routes.routesAt(pattern, decorator));
    }
    if (id.startsWith(MODULE_NAMED)) {
      const [from = "", module = "", level = "0"] = id
        .slice(MODULE_NAMED.length)
        .split(SEPARATOR);
      return moduleFound(
        resolveModule(
          from,
          { module, relativeLevel: Number(level) },
          { roots: args.roots },
        ),
        (file) => args.moduleOfFile.has(file),
      );
    }
    return (
      args.wrapperIndex.lookAgain(id) ??
      envLookupAgain(factSourceOf(args.db), id)
    );
  };
}
