/**
 * How a `suss check` run ended, and the exit code each ending returns.
 *
 * CI branches on the exit code, so a run that found an error and a run
 * that had nothing to compare get different codes, and both fail. A
 * repository with no source in a language suss reads passes, so a job
 * in a repository suss was never meant to read stays green.
 *
 * Code 2 is left unused, because the shell and the repository's own
 * scripts exit 2 on a bad command line. The JSON report says the same
 * thing as the code: every ending other than a finding or a pass adds a
 * run finding of its own kind under `run`.
 */

import { hasReadableSource } from "./language.js";

import type { RunFinding, RunFindingKind } from "@suss/behavioral-ir";

export type CheckOutcome =
  | "passed"
  | "findings"
  | "nothingCompared"
  | "noPackMatched"
  | "notCovered";

export const CHECK_EXIT_CODES: Record<CheckOutcome, number> = {
  passed: 0,
  findings: 1,
  nothingCompared: 3,
  noPackMatched: 4,
  notCovered: 0,
};

/**
 * How the run ended when a run finding of this kind is an error. The
 * flags that ask for a stricter run, such as `--fail-on-unreadable`,
 * fail it the way a finding does.
 */
const OUTCOME_OF_RUN_FINDING: Record<RunFindingKind, CheckOutcome> = {
  nothingPaired: "nothingCompared",
  noPackMatched: "noPackMatched",
  notCovered: "notCovered",
  unreadableInput: "findings",
  mostlyUnpaired: "findings",
  packNeedsConfig: "findings",
};

/**
 * A finding at or above the threshold decides the run first. After that
 * the first run finding at error decides it, and a `notCovered` entry
 * means the run passed because suss reads nothing in the repository.
 */
export function checkOutcome(
  failedOnFindings: boolean,
  run: readonly RunFinding[] = [],
): CheckOutcome {
  if (failedOnFindings) {
    return "findings";
  }

  const failing = run.find((finding) => finding.severity === "error");
  if (failing !== undefined) {
    return OUTCOME_OF_RUN_FINDING[failing.kind];
  }

  if (run.some((finding) => finding.kind === "notCovered")) {
    return "notCovered";
  }
  return "passed";
}

export function exitCodeOf(outcome: CheckOutcome): number {
  return CHECK_EXIT_CODES[outcome];
}

/**
 * The run finding for a project where no pack matched anything. With no
 * source file suss can read, suss does not cover the project and the
 * run passes. With source that nothing recognized, the run fails.
 */
export function emptyProjectFinding(root: string): RunFinding {
  if (!hasReadableSource(root)) {
    return {
      kind: "notCovered",
      severity: "info",
      description: `suss does not cover ${root}. It has no TypeScript, JavaScript, Python or Ruby source, so there is nothing to compare.`,
      remedy:
        "Nothing to do here. To check a spec in this repository, read it with `suss contract`.",
    };
  }
  return {
    kind: "noPackMatched",
    severity: "error",
    description: `Nothing in ${root} matched a pack, so there is nothing to read or compare.`,
    remedy:
      "Run `suss init` to see what suss looked for, name a pack yourself with `suss extract -f`, or pass a summaries file.",
  };
}
