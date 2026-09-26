// The shapes the hook scripts pass around. Types only: the scripts run as
// plain JavaScript, and nothing here exists at runtime.

import type { Finding, RunFinding } from "@suss/behavioral-ir";
import type { ChangedBoundary } from "@suss/checker";
import type { AcceptingRule } from "@suss/cli";

export type { ChangedBoundary, RunFinding };

/** A finding as `suss check --since --json` writes it. */
export type SinceFinding = Finding & {
  identity: string;
  boundaryKey: string;
  atChangedBoundary: boolean;
  rule?: AcceptingRule;
};

/** The parts of the `suss check --since --json` report the hooks read. */
export interface SinceReport {
  since: string;
  findings: SinceFinding[];
  resolved: SinceFinding[];
  changedBoundaries: ChangedBoundary[];
  run: RunFinding[];
}

/** One line of the edit queue. A stop queues a line too, with `tool: "Stop"`. */
export interface EditRequest {
  at: string;
  tool: string;
  file?: string;
}

export interface SnapshotMeta {
  /** How many lines of the edit queue these summaries reflect. */
  edits: number;
  at: string;
  /** When the baseline was taken: at session start, or at a stop that passed. */
  from?: "start" | "stop";
  /** Edits queued while the first read ran, which it may already include. */
  editsDuringRead?: number;
}

/** What the worker found after reading one or more queued edits. */
export interface EditResult {
  /** The queue position this result brings the worker up to. */
  covers: number;
  changed: ChangedBoundary[];
  /** New findings the edit's answer passes on to the agent now. */
  blocking: SinceFinding[];
  resolved: SinceFinding[];
  /** Sentences about the run itself, such as a read that failed. */
  notes: string[];
}

export interface StopRecord {
  /** Identities of the findings a Stop hook has already blocked on. */
  blocked: string[];
  /** Kinds of run findings a Stop report has already mentioned. */
  runReported: string[];
}

/** How long each hook waits before it leaves the work to a later hook. */
export interface Budgets {
  startMs: number;
  editMs: number;
  stopMs: number;
}

export interface HookContext {
  projectDir: string;
  pluginRoot: string;
  budgets: Budgets;
}

/** One way to run suss: the executable, the arguments before suss's own, and where it came from. */
export interface SussCommand {
  command: string;
  prefix: string[];
  from: "project" | "plugin" | "npx";
  version: string | null;
  shell: boolean;
}

export interface SussRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start or was killed at its deadline. */
  failure?: string;
}
