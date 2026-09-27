/**
 * Which summaries return the value that becomes the process's exit code.
 * The store works the functions out once per run, from the files that
 * end the process or set its exit code, and the shared marker records
 * the answer on every summary the run hands back. A summary's file is
 * still absolute here, the way a function key's is.
 */

import { markReturnsAsExitCode } from "@suss/extractor";

import { offsetKeyOf } from "./walk/nodeKeys.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";
import type { ResolutionStore } from "./facts/store.js";

export function stampExitCodeFrom(
  summaries: readonly BehavioralSummary[],
  project: Project,
  resolution: ResolutionStore,
): void {
  markReturnsAsExitCode(
    summaries,
    new Set(resolution.exitCodeFunctions(project).map(offsetKeyOf)),
  );
}
