/**
 * Which summaries return the value that becomes the process's exit code.
 * The store works the functions out once per run, from the files that
 * end the process or set its exit code, and the shared marker records
 * the answer on every summary the run hands back.
 */

import { markReturnsAsExitCode } from "@suss/extractor";

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
  markReturnsAsExitCode(summaries, (summary) => {
    const span = summary.location.span;
    return (
      span !== undefined &&
      returnsTheCode.has(offsetKeyFor(summary.location.file, span))
    );
  });
}
