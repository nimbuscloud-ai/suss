/**
 * The extraction cache's summaries, one source file to a shard.
 *
 * A shard has the summaries whose `location.file` is that file, and the
 * adapter's record for the file when the run walked it. It is named by a
 * hash of its own text, so a write skips every shard whose content did
 * not change, and an edited file replaces only the shards it changed.
 * Conditions and effects repeat heavily within one file, so a shard keeps
 * each distinct one once, in `intern`, and its units refer to them by
 * position. The manifest says which shard has each file, where each unit
 * comes in the run's order, and which walked files own it.
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
const SHARD_ID = /^[0-9a-f]{32}\.json$/;

/** What one shard says about one source file. */
export interface ShardContent<Meta> {
  file: string;
  units: BehavioralSummary[];
  /** Present when the run walked the file and kept a record for it. */
  record?: { meta: Meta };
}

/** A shard as it is on disk, with conditions and effects replaced by positions in `intern`. */
interface StoredShard {
  file: string;
  intern: unknown[];
  units: Record<string, unknown>[];
  record?: { meta: unknown };
}

/** Writes the shard unless one with the same text is there already, and returns its id. */
export function writeShard<Meta>(
  entryDir: string,
  content: ShardContent<Meta>,
): string {
  const pieces = [...documentPieces(interned(content))];
  const hash = createHash("sha256");
  for (const piece of pieces) {
    hash.update(piece);
  }
  const id = hash.digest("hex").slice(0, 32);
  const file = shardPath(entryDir, id);
  if (!fs.existsSync(file)) {
    writeFileAtomically(file, pieces);
  }
  return id;
}

/** The shard's content with fresh copies of every interned value, or null when it cannot be read. */
export function readShard<Meta>(
  entryDir: string,
  id: string,
  file: string,
): ShardContent<Meta> | null {
  let stored: StoredShard;
  try {
    stored = readJsonFile(shardPath(entryDir, id)) as StoredShard;
  } catch {
    return null;
  }
  if (stored.file !== file || !Array.isArray(stored.units)) {
    return null;
  }
  const take = takerFor(stored.intern ?? []);
  return {
    file: stored.file,
    units: stored.units.map((unit) => expanded(unit, take)),
    ...(stored.record === undefined
      ? {}
      : { record: stored.record as { meta: Meta } }),
  };
}

/**
 * Deletes every shard outside `keep`. A reader that opened the previous
 * manifest may still be reading its shards, so a caller keeps those too.
 */
export function removeShardsOutside(
  entryDir: string,
  keep: ReadonlySet<string>,
): void {
  const root = path.join(entryDir, SHARDS_DIR);
  let fanout: string[];
  try {
    fanout = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const prefix of fanout) {
    const dir = path.join(root, prefix);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SHARD_ID.test(name) && !keep.has(name.slice(0, -".json".length))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }
}

function shardPath(entryDir: string, id: string): string {
  return path.join(entryDir, SHARDS_DIR, id.slice(0, 2), `${id}.json`);
}

/**
 * The shard with every condition and effect moved into one table. The
 * same object met twice is looked up by identity first, which spares
 * stringifying an effect the walk put on several branches.
 */
function interned<Meta>(content: ShardContent<Meta>): StoredShard {
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
    ...(content.record === undefined ? {} : { record: content.record }),
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
