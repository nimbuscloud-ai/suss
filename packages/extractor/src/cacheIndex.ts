/**
 * The extraction cache's index: which shard has each file's units, which
 * units serve or call each boundary, and which units make each call by
 * the callee's spelling. A unit is a pair of positions, its file in
 * `files` and its place in that file's shard.
 *
 * The index is small enough to read on every run, so a question can find
 * the shards it needs without opening the rest. What a shard contributes
 * depends on nothing but its text, so a write copies the entries of every
 * shard whose id did not change from the previous index and works out
 * only the rest.
 */

import { BOUNDARY_ROLE, displayLabel } from "@suss/behavioral-ir";
import { readJsonFile, writeDocumentFile } from "@suss/behavioral-ir/files";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

export type IndexRole = "serves" | "calls";

export interface StoreIndex {
  /** Each file and the id of its shard. */
  files: [string, string][];
  /** Boundary label to `[file position, unit position, role]`. */
  boundaries: Record<string, [number, number, IndexRole][]>;
  /** Call spelling to `[file position, unit position]`. */
  callees: Record<string, [number, number][]>;
}

/** What one shard contributes, with units by their place in the shard. */
export interface ShardEntries {
  boundaries: [string, number, IndexRole][];
  callees: [string, number][];
}

/** The entries for a shard's units, in the order the shard lists them. */
export function entriesOf(units: readonly BehavioralSummary[]): ShardEntries {
  const boundaries: [string, number, IndexRole][] = [];
  const callees: [string, number][] = [];
  units.forEach((summary, unit) => {
    const seen = new Set<string>();
    const add = (key: string | null, role: IndexRole): void => {
      if (key !== null && !seen.has(`${role} ${key}`)) {
        seen.add(`${role} ${key}`);
        boundaries.push([key, unit, role]);
      }
    };
    const own = summary.identity?.boundaryBinding ?? null;
    if (own !== null) {
      add(
        keyOf(own),
        BOUNDARY_ROLE[summary.kind] === "provider" ? "serves" : "calls",
      );
    }
    const spellings = new Set<string>();
    for (const transition of summary.transitions ?? []) {
      for (const effect of transition.effects ?? []) {
        if (effect.type === "interaction") {
          add(keyOf(effect.binding), "calls");
        }

        if (effect.type === "invocation") {
          spellings.add(effect.callee);
        }
      }
    }
    for (const spelling of spellings) {
      callees.push([spelling, unit]);
    }
  });
  return { boundaries, callees };
}

/** The index over these shards, in the order the manifest lists them. */
export function indexOf(
  shards: readonly { file: string; id: string; entries: ShardEntries }[],
): StoreIndex {
  const boundaries: StoreIndex["boundaries"] = {};
  const callees: StoreIndex["callees"] = {};
  shards.forEach(({ entries }, file) => {
    for (const [key, unit, role] of entries.boundaries) {
      listAt(boundaries, key).push([file, unit, role]);
    }
    for (const [spelling, unit] of entries.callees) {
      listAt(callees, spelling).push([file, unit]);
    }
  });
  return {
    files: shards.map(({ file, id }) => [file, id]),
    boundaries,
    callees,
  };
}

function listAt<T>(record: Record<string, T[]>, key: string): T[] {
  const existing = record[key];
  if (existing !== undefined) {
    return existing;
  }
  const created: T[] = [];
  record[key] = created;
  return created;
}

/** Each shard's entries in a stored index, by shard id. */
export function entriesByShard(index: StoreIndex): Map<string, ShardEntries> {
  const byShard = new Map<string, ShardEntries>();
  const at = index.files.map(([, id]) => {
    const entries: ShardEntries = { boundaries: [], callees: [] };
    byShard.set(id, entries);
    return entries;
  });
  for (const [key, units] of Object.entries(index.boundaries)) {
    for (const [file, unit, role] of units) {
      at[file]?.boundaries.push([key, unit, role]);
    }
  }
  for (const [spelling, units] of Object.entries(index.callees)) {
    for (const [file, unit] of units) {
      at[file]?.callees.push([spelling, unit]);
    }
  }
  return byShard;
}

/** The index at `file`, or null when there is none or it cannot be read. */
export function readStoreIndex(file: string): StoreIndex | null {
  try {
    const index = readJsonFile(file) as StoreIndex;
    return Array.isArray(index.files) ? index : null;
  } catch {
    return null;
  }
}

export function writeStoreIndex(file: string, index: StoreIndex): void {
  writeDocumentFile(file, index);
}

/**
 * The label a report prints for the boundary, which is how a question
 * spells it. Storage has no pairing key, so `boundaryKey` would leave
 * every table out. A protocol this build does not know has no label.
 */
function keyOf(binding: BoundaryBinding): string | null {
  try {
    return displayLabel(binding);
  } catch {
    return null;
  }
}
