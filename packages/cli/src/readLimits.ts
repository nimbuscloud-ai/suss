/**
 * How a bare `check`, `map` or `extract --out-dir` runs the reads a
 * project lists: how many at once, how long each may take, and how much
 * heap each may grow to.
 *
 * Each read runs as its own `suss` process, so a read that hangs or runs
 * out of memory is stopped without taking the others with it. A monorepo
 * can list over a hundred reads, and one of them can run for half an
 * hour, so the defaults stop a read after twenty minutes and run up to four
 * at once. Fewer run at once when the machine does not have the memory
 * for four reads at full heap.
 */

import os from "node:os";

import { availableMemoryMb, heapSizeFor } from "./heapSize.js";
import { UsageError } from "./usageError.js";

export interface ReadLimits {
  /** How many reads run at the same time. */
  jobs: number;
  /** How long one read may run before it is stopped, in milliseconds. Zero means no limit. */
  timeoutMs: number;
  /** The V8 heap one read may grow to, in megabytes. */
  memoryMb: number;
}

export const DEFAULT_READ_TIMEOUT_MINUTES = 20;

const MOST_JOBS_BY_DEFAULT = 4;

/** Reads at full heap may use this share of memory between them. */
const SHARE_OF_MEMORY = 0.75;

/** The flags that set the limits, as `parseArgs` takes them. */
export const READ_LIMIT_OPTIONS = {
  jobs: { type: "string" },
  "read-timeout": { type: "string" },
  "read-memory": { type: "string" },
} as const;

export interface ReadLimitFlags {
  jobs?: string | undefined;
  "read-timeout"?: string | undefined;
  "read-memory"?: string | undefined;
}

export const READ_LIMIT_FLAGS = Object.keys(
  READ_LIMIT_OPTIONS,
) as (keyof typeof READ_LIMIT_OPTIONS)[];

/** The limits the flags ask for, with a default for each flag left off. */
export function readLimitsFrom(
  flags: ReadLimitFlags,
  machine: { memoryMb: number; cpus: number } = thisMachine(),
): ReadLimits {
  const memoryMb =
    flags["read-memory"] === undefined
      ? heapSizeFor(machine.memoryMb)
      : wholeNumber("--read-memory", flags["read-memory"], 1, "megabytes");
  const timeoutMinutes =
    flags["read-timeout"] === undefined
      ? DEFAULT_READ_TIMEOUT_MINUTES
      : minutes(flags["read-timeout"]);
  const jobs =
    flags.jobs === undefined
      ? defaultJobs(machine, memoryMb)
      : wholeNumber("--jobs", flags.jobs, 1, "reads");
  return { jobs, timeoutMs: Math.round(timeoutMinutes * 60_000), memoryMb };
}

function defaultJobs(
  machine: { memoryMb: number; cpus: number },
  memoryMb: number,
): number {
  const fitInMemory = Math.floor(
    (machine.memoryMb * SHARE_OF_MEMORY) / memoryMb,
  );
  return Math.max(1, Math.min(MOST_JOBS_BY_DEFAULT, machine.cpus, fitInMemory));
}

function thisMachine(): { memoryMb: number; cpus: number } {
  return { memoryMb: availableMemoryMb(), cpus: os.availableParallelism() };
}

function wholeNumber(
  flag: string,
  text: string,
  least: number,
  unit: string,
): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < least) {
    throw new UsageError(
      `${flag} takes a whole number of ${unit}, ${least} or more. It got "${text}".`,
    );
  }
  return value;
}

function minutes(text: string): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < 0) {
    throw new UsageError(
      `--read-timeout takes the minutes one read may run, such as 10 or 0.5, and 0 turns the limit off. It got "${text}".`,
    );
  }
  return value;
}

/** A duration as the progress lines print it: 850ms, 4.2s or 12m 5s. */
export function durationText(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
