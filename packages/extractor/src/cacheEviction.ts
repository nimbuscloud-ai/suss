/**
 * Keeping a cache directory under a size budget.
 *
 * A cache directory has an entry per key, and an entry has a folder per
 * checkout that wrote to it. After each write, every checkout in the
 * directory is taken from the most recently used, and each counts its own
 * folder and the stored files it lists that a more recent checkout of its
 * entry did not. The first checkout that would go past the budget is
 * removed with every older one, and so is a checkout whose worktree is
 * gone. The writing checkout always stays. An entry that lost a checkout
 * drops the stored files nobody left lists, and an entry with no checkout
 * left is removed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { removeStoredOutside, storedFilesOf } from "./cacheShards.js";

export const CHECKOUTS = "checkouts";
export const MANIFEST = "manifest.json";
/** The shards and records a checkout's manifest and the one before it list. */
export const STORED = "stored.json";
/** The checkout's root, as it is, so a later write can tell it was removed. */
export const ROOT = "root.txt";

export const ENTRY_PREFIX = "key-";
const ENTRY_DIR_NAME = new RegExp(`^${ENTRY_PREFIX}[0-9a-f]{16}$`);

/**
 * How long a shard nothing lists yet stays, while another checkout shares
 * the entry. Its write puts the shards on disk before the list of them.
 */
export const SHARED_GRACE_MS = 60_000;

/** How many megabytes a cache directory keeps, when set. */
export const CACHE_BUDGET_ENV = "SUSS_CACHE_MAX_MB";

/** How many bytes a cache directory keeps when `SUSS_CACHE_MAX_MB` is not set. */
export const DEFAULT_CACHE_BUDGET = 1024 ** 3;

/** The budget the environment sets, in bytes, or the default. */
export function cacheBudget(env: NodeJS.ProcessEnv = process.env): number {
  const megabytes = Number(env[CACHE_BUDGET_ENV]);
  return Number.isFinite(megabytes) && megabytes > 0
    ? megabytes * 1024 ** 2
    : DEFAULT_CACHE_BUDGET;
}

/**
 * Eviction deletes recursively and a caller can point `cacheDir` at any
 * directory, so it only touches directories whose names the cache could
 * have written.
 */
export function isEntryDir(name: string): boolean {
  return ENTRY_DIR_NAME.test(name);
}

/** A checkout's folder in an entry, or a whole entry an older layout wrote without checkout folders. */
interface Holder {
  readonly entryDir: string;
  readonly checkoutDir: string | null;
  readonly usedAt: number;
}

/** Removes what lies past `budget` bytes. `own` is the folder of the checkout whose write this follows. */
export async function keepWithinBudget(
  cacheDir: string,
  own: string,
  budget: number,
): Promise<void> {
  const holders = holdersIn(cacheDir).sort(
    (a, b) =>
      Number(b.checkoutDir === own) - Number(a.checkoutDir === own) ||
      b.usedAt - a.usedAt,
  );
  const sizes = new StoredSizes();
  const kept: Holder[] = [];
  const dropped: Holder[] = [];
  let total = 0;
  let full = false;
  for (const holder of holders) {
    const mine = holder.checkoutDir === own;
    if (!mine && (full || !stillThere(holder))) {
      dropped.push(holder);
      continue;
    }
    const bytes = sizes.added(holder);
    if (!mine && total + bytes > budget) {
      full = true;
      dropped.push(holder);
      continue;
    }
    total += bytes;
    kept.push(holder);
  }
  await Promise.all(
    dropped.map((holder) =>
      fs.rm(holder.checkoutDir ?? holder.entryDir, {
        recursive: true,
        force: true,
      }),
    ),
  );
  const ownEntry = path.dirname(path.dirname(own));
  const touched = new Set([
    ownEntry,
    ...dropped.flatMap((holder) =>
      holder.checkoutDir === null ? [] : [holder.entryDir],
    ),
  ]);
  for (const entryDir of touched) {
    const left = kept.filter((holder) => holder.entryDir === entryDir);
    if (left.length === 0) {
      await fs.rm(entryDir, { recursive: true, force: true });
      continue;
    }
    // Another process may be writing to an entry this one did not write.
    const alone = entryDir === ownEntry && left.length === 1;
    removeStoredOutside(
      entryDir,
      new Set(left.flatMap((holder) => storedBy(holder.checkoutDir))),
      alone ? 0 : SHARED_GRACE_MS,
    );
  }
}

function holdersIn(cacheDir: string): Holder[] {
  return namesIn(cacheDir)
    .filter(isEntryDir)
    .flatMap((name): Holder[] => {
      const entryDir = path.join(cacheDir, name);
      const checkouts = path.join(entryDir, CHECKOUTS);
      if (!existsSync(checkouts)) {
        return [{ entryDir, checkoutDir: null, usedAt: usedAt(entryDir) }];
      }
      return namesIn(checkouts).map((checkout) => {
        const checkoutDir = path.join(checkouts, checkout);
        return { entryDir, checkoutDir, usedAt: usedAt(checkoutDir) };
      });
    });
}

/** A folder's time, which a write into it and a hit both move. */
function usedAt(dir: string): number {
  return statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** A checkout outside git doesn't record a root, so it stays until the budget drops it. */
function stillThere(holder: Holder): boolean {
  if (holder.checkoutDir === null) {
    return true;
  }
  const rootFile = path.join(holder.checkoutDir, ROOT);
  if (!existsSync(rootFile)) {
    return true;
  }
  return existsSync(readFileSync(rootFile, "utf8"));
}

/** The shards and records one checkout's manifests list, or none when its list cannot be read. */
export function storedBy(checkoutDir: string | null): string[] {
  if (checkoutDir === null) {
    return [];
  }
  try {
    const ids = JSON.parse(
      readFileSync(path.join(checkoutDir, STORED), "utf8"),
    );
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Bytes on disk, each stored file counted once per entry. */
class StoredSizes {
  private readonly byEntry = new Map<string, Map<string, number>>();
  private readonly counted = new Map<string, Set<string>>();

  /** What keeping `holder` adds to the files already counted. */
  added(holder: Holder): number {
    if (holder.checkoutDir === null) {
      return sizeOf(holder.entryDir);
    }
    const sizes = this.sizesIn(holder.entryDir);
    const counted = this.counted.get(holder.entryDir) ?? new Set<string>();
    this.counted.set(holder.entryDir, counted);
    let bytes = sizeOf(holder.checkoutDir);
    for (const id of storedBy(holder.checkoutDir)) {
      if (!counted.has(id)) {
        counted.add(id);
        bytes += sizes.get(id) ?? 0;
      }
    }
    return bytes;
  }

  private sizesIn(entryDir: string): Map<string, number> {
    let sizes = this.byEntry.get(entryDir);
    if (sizes === undefined) {
      sizes = new Map(
        storedFilesOf(entryDir).map(({ id, file }) => [id, fileSize(file)]),
      );
      this.byEntry.set(entryDir, sizes);
    }
    return sizes;
  }
}

function sizeOf(dir: string): number {
  let bytes = 0;
  for (const entry of direntsIn(dir)) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? sizeOf(full) : fileSize(full);
  }
  return bytes;
}

function fileSize(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function direntsIn(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
