/**
 * Reusing a Ruby run's cache entry file by file.
 *
 * Each file's record says what its discovery found and what that depended
 * on, and what the walk found for each method written in the file. A run
 * after an edit parses every file and emits every fact again, works out
 * which files and whose facts changed, and replays each record whose
 * dependencies are all unchanged. The package's DESIGN.md describes the
 * records and the checks.
 */

import {
  EntryReuse,
  nodeOfKey,
  noteLookup,
  WatchedMap,
} from "@suss/resolution";

import { instanceMethodsByName, singletonMethodsByName } from "./ast.js";
import { envLookupAgain } from "./envReads.js";
import { nodeId } from "./facts/values.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  Changes,
  DependencyLedger,
  StoredFileRecord,
  StoredWalkRecord,
} from "@suss/resolution";
import type { Ancestry, ReachedBody } from "./ancestry.js";
import type { BodyBlocks } from "./ast.js";
import type { DefinedNames, DynamicNames } from "./defineMethod.js";
import type { FileCache } from "./discovery.js";
import type { RbNode } from "./parser.js";
import type { StoredScan } from "./reach/closure.js";
import type { ReachContext, ReachedFunction } from "./reach/resolveCallee.js";

/** The method a unit's walk starts from, as a cache stores it. */
export interface StoredSeed {
  readonly key: string;
  readonly file: string;
  readonly enclosingQualifiedName: string | null;
}

/** One unit a file's discovery produced, before any file's duplicates were dropped. */
export interface StoredUnit {
  /** What `alreadyDiscovered` compares, so a replay drops the same duplicates. */
  readonly dedup: string;
  /** Whether the run that stored this kept it, or dropped it as a duplicate of an earlier file's unit. */
  readonly kept: boolean;
  readonly recognition?: string;
  readonly seed?: StoredSeed;
  /** Set when kept: the summary before parameter gaps were added. */
  readonly summary?: BehavioralSummary;
}

/** A file's load-time unit. */
export interface StoredModule {
  /** The key of the file's program node, which the walk starts from. */
  readonly seedKey: string;
  /** Null when the walk found it reaches nothing and it was left out. */
  readonly summary: BehavioralSummary | null;
  readonly onlyIfItReaches: boolean;
}

/** What the walk found for one method, and what that depended on. */
export type StoredWalk = StoredWalkRecord<StoredScan, BehavioralSummary>;

/** Everything a Ruby run stores about one file. */
export interface RubyFileRecord
  extends StoredFileRecord<StoredScan, BehavioralSummary> {
  readonly units: readonly StoredUnit[];
  readonly module: StoredModule;
}

/** Which of a stored entry's records a Ruby run can replay. */
export type RubyEntryReuse = EntryReuse<
  StoredScan,
  BehavioralSummary,
  RubyFileRecord
>;

/** The methods a file's kept units and its load-time unit start from. */
export function seedsOfRecord(record: RubyFileRecord): string[] {
  return [
    record.module.seedKey,
    ...record.units.flatMap((unit) =>
      unit.kept && unit.seed !== undefined ? [unit.seed.key] : [],
    ),
  ];
}

const ANCESTRY = "ancestry";
const TOP_LEVEL = "topLevel";
const BLOCKS = "blocks";
const DYNAMIC = "dynamic";

/** A block by its key and every method it defines, which is what a lookup in it reads. */
function describeBlock(block: ReachedBody, bodyBlocks: BodyBlocks): string {
  const body = block.info.bodyNode;
  const methods = (table: ReadonlyMap<string, { startIndex: number }>) =>
    [...table].map(([name, node]) => `${name}=${node.startIndex}`).join(",");
  return body === null
    ? nodeId(block.file, block.info.node)
    : `${nodeId(block.file, block.info.node)}{${methods(instanceMethodsByName(body, bodyBlocks))}|${methods(singletonMethodsByName(body, bodyBlocks))}}`;
}

function describeBlocks(
  blocks: readonly ReachedBody[] | null | undefined,
  bodyBlocks: BodyBlocks,
): string {
  return blocks === null || blocks === undefined
    ? "-"
    : blocks.map((block) => describeBlock(block, bodyBlocks)).join(";");
}

function describeAncestry(
  ancestry: Ancestry | undefined,
  bodyBlocks: BodyBlocks,
): string {
  if (ancestry === undefined) {
    return "-";
  }
  return ancestry
    .map((entry) =>
      entry.type === "bodies"
        ? `${entry.name}[${describeBlocks(entry.blocks, bodyBlocks)}]`
        : `${entry.type}:${entry.name}`,
    )
    .join(">");
}

function describeFunctions(
  found: readonly ReachedFunction[] | undefined,
): string {
  return found === undefined
    ? "-"
    : found.map((one) => nodeId(one.file, one.node)).join(",");
}

function describeDefined(found: DefinedNames | undefined): string {
  if (found === undefined) {
    return "-";
  }
  return [
    [...found.names].sort().join(","),
    found.patterns.map((pattern) => pattern.source).join(","),
    String(found.unreadable),
  ].join("|");
}

/** Notes lookups of one kind, building each description once per run, since the indexes do not change within one. */
function noterOf(
  db: Database,
  kind: string,
): (name: string, describe: () => string) => void {
  const described = new Map<string, string>();
  return (name, describe) => {
    let found = described.get(name);
    if (found === undefined) {
      found = describe();
      described.set(name, found);
    }
    noteLookup(db, `${kind} ${name}`, found);
  };
}

/** A map whose lookups are noted. */
function watched<V>(
  map: ReadonlyMap<string, V>,
  db: Database,
  kind: string,
  describe: (value: V | undefined) => string,
): ReadonlyMap<string, V> {
  const note = noterOf(db, kind);
  return new WatchedMap(map, (name, value) =>
    note(name, () => describe(value)),
  );
}

/** The walk's indexes, with every lookup by name noted so a later run can look again. */
export function watchReachContext(ctx: ReachContext): ReachContext {
  const db = ctx.facts;
  const localDefinition = ctx.lookup.localDefinition;
  const noteBlocks = noterOf(db, BLOCKS);
  return {
    ...ctx,
    ancestries: watched(ctx.ancestries, db, ANCESTRY, (found) =>
      describeAncestry(found, ctx.bodyBlocks),
    ),
    topLevelMethods: watched(
      ctx.topLevelMethods,
      db,
      TOP_LEVEL,
      describeFunctions,
    ),
    lookup: {
      ...ctx.lookup,
      localDefinition: (name) => {
        const found = localDefinition?.(name) ?? null;
        noteBlocks(name, () => describeBlocks(found, ctx.bodyBlocks));
        return found;
      },
    },
  };
}

/** What each class defines dynamically, with every lookup noted. */
export function watchDynamicNames(
  names: DynamicNames,
  db: Database,
): DynamicNames {
  return watched(names, db, DYNAMIC, describeDefined);
}

/** A file cache whose every read is charged as a file the work read. */
export function watchFileCache(
  cache: FileCache,
  ledger: DependencyLedger,
): FileCache {
  return {
    constantFiles: cache.constantFiles,
    get: (absPath) => {
      ledger.readFile(absPath);
      return cache.get(absPath);
    },
  };
}

/** Each noted lookup made again over this run's indexes, which must be the ones nothing watches. */
export function lookAgainIn(
  ctx: ReachContext,
  names: DynamicNames,
): (id: string) => string | null {
  const table: Record<string, (argument: string) => string> = {
    [ANCESTRY]: (name) =>
      describeAncestry(ctx.ancestries.get(name), ctx.bodyBlocks),
    [TOP_LEVEL]: (name) => describeFunctions(ctx.topLevelMethods.get(name)),
    [BLOCKS]: (name) =>
      describeBlocks(ctx.lookup.localDefinition?.(name), ctx.bodyBlocks),
    [DYNAMIC]: (classKey) => describeDefined(names.get(classKey)),
  };
  return (id) => {
    const space = id.indexOf(" ");
    const again = space === -1 ? undefined : table[id.slice(0, space)];
    return again === undefined
      ? envLookupAgain(ctx.facts, id)
      : again(id.slice(space + 1));
  };
}

/** The replay decision over a stored Ruby entry, given what changed. */
export function rubyEntryReuse(
  records: ReadonlyMap<string, RubyFileRecord>,
  changedFiles: ReadonlySet<string>,
  changes: Changes,
): RubyEntryReuse {
  return new EntryReuse(records, changedFiles, changes, seedsOfRecord);
}

/** What an earlier run's walk found, for the bodies whose inputs have not changed since. */
export class WalkReplay {
  constructor(
    private readonly reuse: RubyEntryReuse,
    private readonly rootsByFile: ReadonlyMap<string, RbNode>,
  ) {}

  scanOf(key: string): StoredScan | undefined {
    return this.reuse.walkOf(key)?.scan;
  }

  /** The summary a reached method had before parameter gaps were added. */
  summaryOf(key: string): BehavioralSummary | undefined {
    return this.reuse.walkOf(key)?.summary;
  }

  /** The node a stored key refers to, found again in this run's trees. */
  nodeOf(key: string): RbNode | null {
    return nodeOfKey(this.rootsByFile, key);
  }
}
