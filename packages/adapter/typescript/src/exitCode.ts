/**
 * Which summaries return the value that becomes the process's exit code,
 * recorded as `metadata.process.exitCodeFrom: "return"`.
 *
 * The store works the functions out once per run, from the files that
 * end the process or set its exit code. Every summary the run hands back
 * is marked or cleared here, reused ones included. The chain runs from
 * the file that sets the code into files that never record that file as
 * a dependency, so a mark the cache kept could otherwise outlive an edit
 * to the entry file.
 */

import { offsetKeyFor, offsetKeyOf } from "./walk/nodeKeys.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";
import type { ResolutionStore } from "./facts/store.js";

export function stampExitCodeFrom(
  summaries: readonly BehavioralSummary[],
  project: Project,
  resolution: ResolutionStore,
): void {
  const returnsTheCode = new Set(
    resolution.exitCodeFunctions(project).map(offsetKeyOf),
  );
  for (const summary of summaries) {
    const span = summary.location.span;
    markExitCodeFrom(
      summary,
      span !== undefined &&
        returnsTheCode.has(offsetKeyFor(summary.location.file, span)),
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
