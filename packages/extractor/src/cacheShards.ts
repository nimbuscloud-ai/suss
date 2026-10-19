/**
 * The extraction cache's summaries, one source file to a shard, and each
 * walked file's adapter record in a file of its own.
 *
 * A shard has the summaries whose `location.file` is that file. A record
 * is the `meta` an adapter keeps for a walked file, which only a partial
 * run reads, so a hit opens the shards alone. Both are named by a hash of
 * their own text, so a write skips every one whose content did not
 * change. Conditions and effects repeat heavily within one file, so a
 * shard keeps each distinct one once, in `intern`, and its units refer
 * to them by position. The manifest says which shard has each file and
 * which record each walked file has.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  documentPieces,
  readJsonFile,
  writeFileAtomically,
} from "@suss/behavioral-ir/files";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const SHARDS_DIR = "shards";
const RECORDS_DIR = "records";
const STORED_ID = /^[0-9a-f]{32}\.json$/;

/** What one shard says about one source file. */
export interface ShardContent {
  file: string;
  units: BehavioralSummary[];
}

/** A shard as it is on disk, with conditions and effects replaced by positions in `intern`. */
interface StoredShard {
  file: string;
  intern: unknown[];
  units: Record<string, unknown>[];
}

/** Writes the shard unless one with the same text is there already, and returns its id. */
export function writeShard(entryDir: string, content: ShardContent): string {
  return writeOnce(path.join(entryDir, SHARDS_DIR), interned(content));
}

/** The shard's content with fresh copies of every interned value, or null when it cannot be read. */
export function readShard(
  entryDir: string,
  id: string,
  file: string,
): ShardContent | null {
  const stored = readStored(path.join(entryDir, SHARDS_DIR), id) as
    | StoredShard
    | undefined;
  if (stored?.file !== file || !Array.isArray(stored.units)) {
    return null;
  }
  const take = takerFor(stored.intern ?? []);
  return {
    file: stored.file,
    units: stored.units.map((unit) => expanded(unit, take)),
  };
}

/** Writes a walked file's meta unless an equal one is there already, and returns its id. */
export function writeRecord(entryDir: string, meta: unknown): string {
  return writeOnce(path.join(entryDir, RECORDS_DIR), { meta });
}

/** The meta stored under `id`, or null when it cannot be read. */
export function readRecord<Meta>(
  entryDir: string,
  id: string,
): { meta: Meta } | null {
  const stored = readStored(path.join(entryDir, RECORDS_DIR), id);
  return typeof stored === "object" && stored !== null
    ? (stored as { meta: Meta })
    : null;
}

/**
 * Deletes every shard and record outside `keep`. A reader that opened the
 * previous manifest may still be reading what it lists, so a caller keeps
 * those too.
 */
export function removeStoredOutside(
  entryDir: string,
  keep: ReadonlySet<string>,
): void {
  for (const kind of [SHARDS_DIR, RECORDS_DIR]) {
    const root = path.join(entryDir, kind);
    for (const prefix of namesIn(root)) {
      const dir = path.join(root, prefix);
      for (const name of namesIn(dir)) {
        if (STORED_ID.test(name) && !keep.has(name.slice(0, -".json".length))) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    }
  }
}

function namesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Writes `value` in the line layout under the hash of its text, unless that file exists. */
function writeOnce(root: string, value: unknown): string {
  const pieces = [...documentPieces(value)];
  const hash = createHash("sha256");
  for (const piece of pieces) {
    hash.update(piece);
  }
  const id = hash.digest("hex").slice(0, 32);
  const file = storedPath(root, id);
  if (!fs.existsSync(file)) {
    writeFileAtomically(file, pieces);
  }
  return id;
}

function readStored(root: string, id: string): unknown {
  try {
    return readJsonFile(storedPath(root, id));
  } catch {
    return undefined;
  }
}

function storedPath(root: string, id: string): string {
  return path.join(root, id.slice(0, 2), `${id}.json`);
}

/**
 * The shard with every condition and effect moved into one table. The
 * same object met twice is looked up by identity first, which spares
 * stringifying an effect the walk put on several branches.
 */
function interned(content: ShardContent): StoredShard {
  const intern: unknown[] = [];
  const byText = new Map<string, number>();
  const byObject = new Map<unknown, number>();
  const positionOf = (value: unknown): number => {
    const known = byObject.get(value);
    if (known !== undefined) {
      return known;
    }
    const text = JSON.stringify(value) ?? "null";
    let position = byText.get(text);
    if (position === undefined) {
      position = intern.length;
      intern.push(value);
      byText.set(text, position);
    }
    if (typeof value === "object" && value !== null) {
      byObject.set(value, position);
    }
    return position;
  };
  const positions = (values: unknown): unknown =>
    Array.isArray(values) ? values.map(positionOf) : values;
  const units = content.units.map((summary) => ({
    ...summary,
    transitions: summary.transitions.map((transition) => ({
      ...transition,
      conditions: positions(transition.conditions),
      effects: positions(transition.effects),
    })),
    gaps: summary.gaps.map((gap) => ({
      ...gap,
      conditions: positions(gap.conditions),
    })),
  }));
  return {
    file: content.file,
    intern,
    units,
  };
}

/** A unit with its positions replaced by the values they stand for. */
function expanded(
  unit: Record<string, unknown>,
  take: (position: number) => unknown,
): BehavioralSummary {
  const values = (positions: unknown): unknown =>
    Array.isArray(positions)
      ? positions.map((at: number) => take(at))
      : positions;
  const transitions = Array.isArray(unit.transitions) ? unit.transitions : [];
  const gaps = Array.isArray(unit.gaps) ? unit.gaps : [];
  return {
    ...unit,
    transitions: transitions.map((transition: Record<string, unknown>) => ({
      ...transition,
      conditions: values(transition.conditions),
      effects: values(transition.effects),
    })),
    gaps: gaps.map((gap: Record<string, unknown>) => ({
      ...gap,
      conditions: values(gap.conditions),
    })),
  } as BehavioralSummary;
}

/**
 * Hands out each interned value once as parsed and as a copy after that,
 * since a caller may change one transition's effect and the next
 * transition that refers to it must not see the change.
 */
function takerFor(intern: readonly unknown[]): (position: number) => unknown {
  const handedOut = new Set<number>();
  return (position) => {
    const value = intern[position];
    if (!handedOut.has(position)) {
      handedOut.add(position);
      return value;
    }
    return copyOfJson(value);
  };
}

function copyOfJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyOfJson);
  }

  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = copyOfJson((value as Record<string, unknown>)[key]);
    }
    return copy;
  }

  return value;
}
