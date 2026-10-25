/**
 * Runs one extract a project lists as its own `suss` process, with a time
 * limit and a heap limit.
 *
 * A read in the same process as the command that asked for it cannot be
 * stopped: the TypeScript compiler runs synchronously, so a timer never
 * fires, and a read that runs out of heap takes the whole command down.
 * In its own process, a read that runs too long is killed, one that runs
 * out of heap dies alone, and either way the command goes on with the
 * reads that finished. The child gets the same command a user would type,
 * so a read here writes what `suss extract` writes.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packSpecFrom } from "./extract.js";

import type { ExtractEntry } from "./projectFile.js";
import type { ReadLimits } from "./readLimits.js";

/** How a read in its own process ended. */
export type ChildReadEnd =
  | { kind: "finished" }
  | { kind: "failed"; exitCode: number | null; signal: string | null }
  | { kind: "timedOut" }
  | { kind: "outOfMemory" };

export interface ChildRead {
  end: ChildReadEnd;
  /** The end of what the read printed, stdout and stderr together. */
  output: string;
}

/** Enough of a read's output to show why it failed. */
const OUTPUT_KEPT_CHARS = 64 * 1024;

/** What V8 prints when a process reaches its heap limit. */
const OUT_OF_HEAP = /heap out of memory|Reached heap limit/;

/** The arguments `suss` takes to run this entry, writing to `out`. */
export function childArgsFor(
  entry: ExtractEntry,
  root: string,
  out: string,
): string[] {
  return [
    "extract",
    "--lang",
    entry.language,
    "--dir",
    path.resolve(root, entry.dir ?? "."),
    ...(entry.project === undefined
      ? []
      : ["-p", path.resolve(root, entry.project)]),
    ...entry.packs.flatMap((spec) => ["-f", packSpecFrom(root, spec)]),
    "-o",
    out,
    "--allow-empty",
  ];
}

/**
 * The `suss` executable to run a read with: the one beside this module
 * in a build, or the package's build when this module runs from source,
 * as it does under the tests.
 */
export function sussExecutable(): string {
  const candidates = [
    fileURLToPath(new URL("./bin.js", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}

/** The processes still running, so a signal to this one can stop them too. */
const running = new Set<number>();

/**
 * Runs one entry in its own process. The promise never rejects: a read
 * that cannot start comes back as failed, with the reason as its output.
 */
export function readInChild(
  entry: ExtractEntry,
  root: string,
  out: string,
  limits: ReadLimits,
): Promise<ChildRead> {
  const args = [
    `--max-old-space-size=${limits.memoryMb}`,
    sussExecutable(),
    ...childArgsFor(entry, root, out),
  ];
  return new Promise((resolve) => {
    // Its own process group, so a time limit stops whatever it started too.
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    const collect = (chunk: unknown): void => {
      output = (output + String(chunk)).slice(-OUTPUT_KEPT_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    if (child.pid !== undefined) {
      running.add(child.pid);
      stopChildrenOnSignal();
    }

    let timedOut = false;
    const timer =
      limits.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stopProcess(child.pid);
          }, limits.timeoutMs)
        : undefined;

    const settle = (end: ChildReadEnd): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      if (child.pid !== undefined) {
        running.delete(child.pid);
      }
      resolve({ end, output });
    };
    child.on("error", (error) => {
      output = `${output}${error.message}\n`;
      settle({ kind: "failed", exitCode: null, signal: null });
    });
    child.on("close", (exitCode, signal) => {
      settle(endOf({ timedOut, exitCode, signal, output }));
    });
  });
}

function endOf(facts: {
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  output: string;
}): ChildReadEnd {
  if (facts.timedOut) {
    return { kind: "timedOut" };
  }

  if (facts.exitCode === 0) {
    return { kind: "finished" };
  }

  if (OUT_OF_HEAP.test(facts.output)) {
    return { kind: "outOfMemory" };
  }
  return { kind: "failed", exitCode: facts.exitCode, signal: facts.signal };
}

/**
 * The line that says why a read failed: the message of a stack trace, or
 * else the first line of the last paragraph it printed, since suss puts
 * the problem first and the detail after it.
 */
export function errorLineOf(output: string): string | null {
  const lines = output.split("\n").map((line) => line.trim());
  const error = lines.find((line) => line.startsWith("Error"));
  if (error !== undefined) {
    return error;
  }
  const paragraphs = lines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return paragraphs.at(-1)?.split("\n")[0] ?? null;
}

/** Kills the read and anything it started. */
function stopProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // It ended on its own between the timer firing and the kill.
  }
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let listening = false;

/** Kills every read still running, as this process does before it exits. */
export function stopEveryRead(): void {
  for (const pid of running) {
    stopProcess(pid);
  }
  running.clear();
}

/**
 * A read in its own process group does not hear the Ctrl-C the terminal
 * sends this one, so this process stops each read before it goes, then
 * ends the way the signal would have ended it.
 */
function stopChildrenOnSignal(): void {
  if (listening) {
    return;
  }

  listening = true;
  for (const signal of SIGNALS) {
    process.on(signal, stopReadsAndEnd);
  }
  process.off("exit", stopEveryRead);
  process.on("exit", stopEveryRead);
}

/**
 * Stops every read, then sends the signal on with this handler removed,
 * so the process ends the way the signal would have ended it. `send` is
 * there so a test can watch it instead of ending.
 */
export function stopReadsAndEnd(
  signal: NodeJS.Signals,
  send: (signal: NodeJS.Signals) => void = (one) => {
    process.kill(process.pid, one);
  },
): void {
  stopEveryRead();
  for (const one of SIGNALS) {
    process.off(one, stopReadsAndEnd);
  }
  listening = false;
  send(signal);
}
