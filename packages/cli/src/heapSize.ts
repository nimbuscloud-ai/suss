/**
 * Gives a suss process more V8 heap than Node picks by default.
 *
 * Node sizes the heap from the machine's memory and stops near 4 GB even
 * on a large machine. Extracting a large TypeScript service with every
 * pack `suss init` suggests can peak above that, and the run then dies
 * with "JavaScript heap out of memory". The `suss` and `suss-mcp`
 * executables call `startWithEnoughHeap` before loading anything else, and
 * when nobody chose a heap size the process starts itself again with
 * `--max-old-space-size`. A size set in NODE_OPTIONS or passed to node
 * directly always wins. The size is a ceiling on growth, so a small
 * project uses no more memory than before and pays one extra node start.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import v8 from "node:v8";

/**
 * About twice the largest peak measured so far, which was 4.4 GB on a
 * NestJS service of around 7,000 units with eleven packs.
 */
export const PREFERRED_HEAP_MB = 8192;

/**
 * On a small machine the heap stays under this share of memory, so a run
 * that outgrows it stops with V8's heap error instead of being killed by
 * the operating system with no message.
 */
const SHARE_OF_MEMORY = 0.75;

const HEAP_SIZE_FLAG = /--max[-_]old[-_]space[-_]size/;

const MB = 1024 * 1024;

export interface HeapFacts {
  /** NODE_OPTIONS as the process received it. */
  nodeOptions: string | undefined;
  /** Flags passed to node itself, before the script path. */
  execArgv: readonly string[];
  /** The heap limit V8 chose for this process. */
  heapLimitMb: number;
  /** Memory the process may use: the machine's, or a container's limit. */
  memoryMb: number;
}

/** Whether the person running suss already chose a heap size. */
export function heapSizeWasChosen(
  nodeOptions: string | undefined,
  execArgv: readonly string[],
): boolean {
  if (HEAP_SIZE_FLAG.test(nodeOptions ?? "")) {
    return true;
  }
  return execArgv.some((flag) => HEAP_SIZE_FLAG.test(flag));
}

/** The heap size suss runs with on a machine with this much memory. */
export function heapSizeFor(memoryMb: number): number {
  return Math.min(PREFERRED_HEAP_MB, Math.floor(memoryMb * SHARE_OF_MEMORY));
}

/**
 * The heap size to start again with, or undefined when this process
 * should keep running as it is.
 */
export function heapSizeToRelaunchWith(facts: HeapFacts): number | undefined {
  if (heapSizeWasChosen(facts.nodeOptions, facts.execArgv)) {
    return undefined;
  }
  const size = heapSizeFor(facts.memoryMb);
  if (size <= facts.heapLimitMb) {
    return undefined;
  }
  return size;
}

/** How much memory this process may use, in megabytes. */
export function availableMemoryMb(): number {
  const machine = os.totalmem();
  // Node 20 returns undefined without a limit, later versions return 0, and
  // a cgroup without a limit can report a number larger than the machine.
  const constrained = process.constrainedMemory?.() ?? 0;
  const bytes = constrained > 0 ? Math.min(machine, constrained) : machine;
  return Math.floor(bytes / MB);
}

function factsAboutThisProcess(): HeapFacts {
  return {
    nodeOptions: process.env.NODE_OPTIONS,
    execArgv: process.execArgv,
    heapLimitMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MB),
    memoryMb: availableMemoryMb(),
  };
}

/**
 * Calls `start` in a process with a large enough heap. When this process
 * has to start again, `start` runs there instead and never runs here.
 */
export function startWithEnoughHeap(start: () => unknown): void {
  const size = heapSizeToRelaunchWith(factsAboutThisProcess());
  if (size === undefined) {
    start();
    return;
  }

  const args = [
    ...process.execArgv,
    `--max-old-space-size=${size}`,
    ...process.argv.slice(1),
  ];
  replaceThisProcess(args);
  relaunchAsChild(args, start);
}

/**
 * Keeps the process id, so a signal, a timeout or a memory sampler aimed
 * at it reaches the run. Returns only when the platform cannot do this.
 */
function replaceThisProcess(args: string[]): void {
  if (typeof process.execve !== "function") {
    return;
  }
  try {
    process.execve(process.execPath, [process.execPath, ...args]);
  } catch {
    // This process keeps running unchanged, and the child below takes over.
  }
}

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs suss as a child that shares this process's terminal and pipes,
 * passes on the signals sent here, and exits the way the child did.
 */
function relaunchAsChild(args: string[], start: () => unknown): void {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const stopForwarding = (): void => {
    for (const signal of FORWARDED_SIGNALS) {
      process.off(signal, forward);
    }
  };
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, forward);
  }

  // Node could not start at all, so this process runs suss after all.
  child.on("error", () => {
    stopForwarding();
    start();
  });
  child.on("exit", (code, signal) => {
    stopForwarding();
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
