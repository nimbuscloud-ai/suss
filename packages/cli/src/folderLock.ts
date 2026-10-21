/**
 * An exclusive lock on a folder several processes share, held as a file
 * next to it.
 *
 * The file is created with `wx`, so only one process can create it, and
 * it contains that process's id. A process that finds it waits and tries
 * again. When the process that wrote the file is gone, the lock is stale
 * and the next process removes it. A process that waits past the timeout
 * gives up with an error rather than reading the folder unguarded.
 */

import fs from "node:fs";

import { UsageError } from "./usageError.js";

export interface FolderLock {
  file: string;
}

const RETRY_MS = 250;

export async function acquireFolderLock(
  file: string,
  timeoutMs: number,
): Promise<FolderLock> {
  const giveUpAt = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(file)) {
      return { file };
    }

    if (holderIsGone(file)) {
      fs.rmSync(file, { force: true });
      continue;
    }

    if (Date.now() > giveUpAt) {
      throw new UsageError(
        `Waited ${Math.round(timeoutMs / 1000)}s for another suss process to finish with ${file}. Remove the file if no other suss is running.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/** Removes the lock file, when it is still the one this process wrote. */
export function releaseFolderLock(lock: FolderLock): void {
  if (holderOf(lock.file) === process.pid) {
    fs.rmSync(lock.file, { force: true });
  }
}

function tryCreate(file: string): boolean {
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function holderOf(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** How long a lock file may stay without an id before its writer counts as gone. */
const UNWRITTEN_MS = 10_000;

/**
 * Whether the process that wrote the lock has exited. A file with no
 * readable id counts as held for a few seconds, since its writer may be
 * between creating it and writing the id.
 */
function holderIsGone(file: string): boolean {
  const pid = holderOf(file);
  if (pid === null) {
    return ageOf(file) > UNWRITTEN_MS;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Milliseconds since the file last changed, or zero once it is gone. */
function ageOf(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
