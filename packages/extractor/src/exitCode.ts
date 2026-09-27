/**
 * Marks the summaries whose return becomes the process's exit code, as
 * `metadata.process.exitCodeFrom: "return"`, and clears the mark from
 * every other one.
 *
 * Every adapter works the functions out once per run and calls this over
 * every summary the run hands back, reused ones included. The chain runs
 * from the file that sets the code into files that never record that
 * file as a dependency, so a mark a cache kept could otherwise outlive an
 * edit to the entry file.
 */

import path from "node:path";

import { declarationKey } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * `returnsTheCode` contains function keys, the absolute file and the
 * function's span as `declarationKey` writes them. A summary whose file
 * was shortened is resolved against `workspaceRoot` first.
 */
export function markReturnsAsExitCode(
  summaries: readonly BehavioralSummary[],
  returnsTheCode: ReadonlySet<string>,
  workspaceRoot?: string,
): void {
  for (const summary of summaries) {
    const span = summary.location.span;
    const file =
      workspaceRoot === undefined
        ? summary.location.file
        : path.resolve(workspaceRoot, summary.location.file);
    markExitCodeFrom(
      summary,
      span !== undefined && returnsTheCode.has(declarationKey(file, span)),
    );
  }
}

function markExitCodeFrom(summary: BehavioralSummary, marked: boolean): void {
  const process = summary.metadata?.process as
    | Record<string, unknown>
    | undefined;
  if (marked) {
    summary.metadata = {
      ...(summary.metadata ?? {}),
      process: { ...(process ?? {}), exitCodeFrom: "return" },
    };
    return;
  }
  if (process === undefined || !("exitCodeFrom" in process)) {
    return;
  }
  const { exitCodeFrom: _dropped, ...rest } = process;
  const { process: _process, ...others } = summary.metadata ?? {};
  const left =
    Object.keys(rest).length === 0 ? others : { ...others, process: rest };
  // A fresh extract of the same unit has no metadata at all, and the
  // cleared summary has to read the same.
  if (Object.keys(left).length === 0) {
    Reflect.deleteProperty(summary, "metadata");
    return;
  }
  summary.metadata = left;
}
