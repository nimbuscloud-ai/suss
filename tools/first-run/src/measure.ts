/**
 * Runs one command under `timeout` and the system `time`, and returns
 * its exit code, wall time and peak resident memory. The peak is the
 * largest single process `time` waited on, so a worker the command
 * spawned is counted only when it is larger than the command itself.
 */

import { spawnSync } from "node:child_process";

export interface Measured {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  peakRssBytes: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
}

const TIMEOUT_EXIT = 124;
const MAX_OUTPUT = 512 * 1024 * 1024;

export function runMeasured(argv: string[], options: RunOptions): Measured {
  const seconds = Math.max(1, Math.floor(options.timeoutSeconds));
  const wrapped = ["-l", "timeout", String(seconds), ...argv];
  const started = Date.now();
  const result = spawnSync("/usr/bin/time", wrapped, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  const wallMs = Date.now() - started;
  const stdout = result.stdout ?? "";
  const { stderr, peakRssBytes } = splitTimeReport(result.stderr ?? "");
  const measured: Measured = {
    argv,
    cwd: options.cwd,
    exitCode: result.status,
    timedOut: result.status === TIMEOUT_EXIT,
    wallMs,
    peakRssBytes,
    stdout,
    stderr,
  };
  return measured;
}

const RSS_LINE = /^\s*(\d+)\s+maximum resident set size\s*$/m;
const TIME_REPORT_START = /^\s+[\d.]+ real\s+[\d.]+ user\s+[\d.]+ sys\s*$/m;

/** `time -l` appends its report to the command's stderr; this separates the two. */
export function splitTimeReport(raw: string): {
  stderr: string;
  peakRssBytes: number | null;
} {
  const rss = RSS_LINE.exec(raw);
  const reportAt = raw.search(TIME_REPORT_START);
  const stderr = reportAt >= 0 ? raw.slice(0, reportAt) : raw;
  return {
    stderr,
    peakRssBytes: rss?.[1] === undefined ? null : Number(rss[1]),
  };
}

const LOGGED_STDOUT = 200_000;

export function formatLog(measured: Measured): string {
  const stdout =
    measured.stdout.length > LOGGED_STDOUT
      ? `${measured.stdout.slice(0, LOGGED_STDOUT)}\n[truncated]`
      : measured.stdout;
  return [
    `$ (cd ${measured.cwd} && ${measured.argv.join(" ")})`,
    `exit ${measured.exitCode} wall ${measured.wallMs}ms peak ${measured.peakRssBytes}`,
    "---- stdout ----",
    stdout,
    "---- stderr ----",
    measured.stderr,
  ].join("\n");
}
