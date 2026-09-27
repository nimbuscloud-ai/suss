/**
 * The stamps and hashes the extraction cache records for each file, and
 * when it takes them.
 *
 * A run stats every file before the adapter reads any of them, and the
 * manifest records those stamps. A write after the stat then moves the
 * stamp the next run sees. The exception is a write in the same clock
 * tick as the change before the stat, with the same size: a file system
 * can keep the old mtime. So a file changed shortly before the stat is
 * hashed before the read, and its entry is marked for the next lookup to
 * compare that hash even when the stamp matches. A file whose stat moved
 * between the start of the run and the manifest write is left out, and
 * the next run treats it as unread. The package's design notes say more.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export interface FileStamp {
  /** Absolute path. */
  path: string;
  /** mtime in ms. */
  mtimeMs: number;
  size: number;
  /** Absent on entries written without per-file attribution. */
  contentHash?: string;
  /** The stamp alone cannot vouch for the file, so a lookup compares the hash. */
  verifyHash?: true;
}

/**
 * How recent a file's last change can be, measured back from a stat,
 * before a later write might leave the stat's mtime as it was. Some file
 * systems stamp with a one second clock, and a kernel's coarse clock can
 * trail the process clock by a tick, so the margin covers two seconds.
 */
const RECENT_CHANGE_MS = 2000;

/**
 * Whether a write after `statAt` could leave this file's mtime and size
 * where the stat saw them, because its last change was that recent.
 */
export function stampMayMissAWrite(
  stat: { mtimeMs: number; ctimeMs: number },
  statAt: number,
): boolean {
  return Math.max(stat.mtimeMs, stat.ctimeMs) > statAt - RECENT_CHANGE_MS;
}

/** A file as a run found it before reading it. Null ctime means it was missing. */
interface StatAtStart {
  stamp: FileStamp;
  ctimeMs: number | null;
}

/** What a run saw before its adapter read anything. */
export interface RunStart {
  /** Taken before the first stat. */
  startedAt: number;
  config: StatAtStart | null;
  /** Sorted by path. */
  files: StatAtStart[];
  /** Hashes taken during this run, each before the adapter read the file. */
  hashes: Map<string, string | null>;
}

export async function startRun(
  files: ReadonlyArray<string>,
  configPath: string | undefined,
): Promise<RunStart> {
  const startedAt = Date.now();
  const config =
    configPath === undefined ? null : await statAtStart(configPath);
  // The stats run concurrently, limited by libuv's thread pool. On a
  // project of several thousand files they take around 25ms.
  const stats = await Promise.all(files.map(statAtStart));
  // Lists are compared position by position, so both are kept in path order.
  stats.sort((a, b) =>
    a.stamp.path < b.stamp.path ? -1 : a.stamp.path > b.stamp.path ? 1 : 0,
  );
  return {
    startedAt,
    config: config?.ctimeMs === null ? null : config,
    files: stats,
    hashes: new Map(),
  };
}

async function statAtStart(filePath: string): Promise<StatAtStart> {
  try {
    const stat = await fs.stat(filePath);
    return {
      stamp: { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size },
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    // Deleted after the list was made. The sentinel never matches a
    // stored stamp, so the lookup misses.
    return { stamp: { path: filePath, mtimeMs: -1, size: -1 }, ctimeMs: null };
  }
}

/** The file's hash, read at most once per run. */
export async function hashOf(
  run: RunStart,
  filePath: string,
): Promise<string | null> {
  const known = run.hashes.get(filePath);
  if (known !== undefined) {
    return known;
  }
  const hash = await hashFile(filePath);
  run.hashes.set(filePath, hash);
  return hash;
}

/**
 * Hashes every file whose stamp may miss a write, before the adapter
 * reads it, so the manifest can record the text the run read.
 */
export async function hashRecentChanges(run: RunStart): Promise<void> {
  const recent = [...(run.config === null ? [] : [run.config]), ...run.files]
    .filter(
      (file) =>
        file.ctimeMs !== null &&
        stampMayMissAWrite(
          { mtimeMs: file.stamp.mtimeMs, ctimeMs: file.ctimeMs },
          run.startedAt,
        ),
    )
    .map((file) => file.stamp.path);
  await Promise.all(recent.map((filePath) => hashOf(run, filePath)));
}

/** Whether a stored stamp still describes the file the run found. */
export async function stillMatches(
  stored: FileStamp | null,
  found: FileStamp | null,
  run: RunStart,
): Promise<boolean> {
  if (!fileStampEquals(stored, found)) {
    return false;
  }
  if (stored === null || stored.verifyHash !== true) {
    return true;
  }
  return (await hashOf(run, stored.path)) === stored.contentHash;
}

/** Whether every stored file still describes the file the run found. */
export async function filesStillMatch(
  stored: ReadonlyArray<FileStamp>,
  run: RunStart,
): Promise<boolean> {
  if (
    stored.length !== run.files.length ||
    !stored.every((s, i) => fileStampEquals(s, run.files[i]?.stamp ?? null))
  ) {
    return false;
  }
  const checks = await Promise.all(
    stored.map((s, i) => stillMatches(s, run.files[i]?.stamp ?? null, run)),
  );
  return checks.every(Boolean);
}

/**
 * The entry a file gets in the manifest this run writes, or null when it
 * changed while the run read it. `prior` is its entry in the manifest the
 * run started from, whose hash is reused while the stamp is the same.
 */
export async function recordedStamp(
  start: StatAtStart,
  run: RunStart,
  prior: FileStamp | undefined,
): Promise<FileStamp | null> {
  if (start.ctimeMs === null) {
    return start.stamp;
  }
  const filePath = start.stamp.path;
  const now = await fs.stat(filePath).catch(() => null);
  if (
    now === null ||
    now.mtimeMs !== start.stamp.mtimeMs ||
    now.size !== start.stamp.size ||
    now.ctimeMs !== start.ctimeMs
  ) {
    return null;
  }
  const atStart = { mtimeMs: start.stamp.mtimeMs, ctimeMs: start.ctimeMs };
  if (stampMayMissAWrite(atStart, run.startedAt)) {
    const readBefore = run.hashes.get(filePath);
    return readBefore === undefined || readBefore === null
      ? null
      : { ...start.stamp, contentHash: readBefore, verifyHash: true };
  }
  // The stamp is older than any write that could keep it, and it did not
  // move, so the text now is the text the run read.
  const hash =
    run.hashes.get(filePath) ??
    reusableHash(prior, start.stamp) ??
    (await hashFile(filePath));
  return hash === null ? start.stamp : { ...start.stamp, contentHash: hash };
}

function reusableHash(
  prior: FileStamp | undefined,
  stamp: FileStamp,
): string | undefined {
  return prior !== undefined &&
    prior.verifyHash !== true &&
    fileStampEquals(prior, stamp)
    ? prior.contentHash
    : undefined;
}

export async function hashFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function fileStampEquals(
  a: FileStamp | null,
  b: FileStamp | null,
): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}
