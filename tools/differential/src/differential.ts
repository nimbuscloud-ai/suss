// differential.ts — the adjudicator.
//
// For one generated program: extract a summary once, execute the same
// body against a deterministic request battery, and check the summary's
// claims against each observation. Two verdicts, mapped one-to-one onto
// the extraction algorithm's correctness principles
// (docs/extraction-algorithm.md §Correctness principles):
//
// - `falseClaim` (principle #2, "no false conditions"): a transition
//   whose conditions all evaluate concretely true promised a status
//   different from the one observed. The summary asserted something
//   about this execution and was wrong.
// - `uncovered` (principle #1, exhaustiveness): every transition's
//   conditions evaluate concretely false, no gap is declared, yet the
//   handler responded. The observed behavior isn't accounted for.
//
// Abstention is never a finding: transitions with unknown conditions or
// unknown status can neither falsify nor be falsified.

import { type DispatchTable, dispatchByType } from "./dispatch.js";
import { executeHandler } from "./execute.js";
import { extractHandlerSummary } from "./extract.js";
import { evalConditions, type Tri } from "./interpret.js";
import {
  type HandlerProgram,
  renderBodyLines,
  renderHandlerSource,
} from "./program.js";
import { type GeneratedRequest, requestBattery } from "./requests.js";
import { EXPRESS_TARGET, type FuzzTarget } from "./target.js";

import type {
  BehavioralSummary,
  Output,
  Transition,
} from "@suss/behavioral-ir";

export type TransitionStatus =
  | { type: "known"; status: number }
  | { type: "unknownStatus" }
  | { type: "nonResponse" };

const OUTPUT_STATUS: DispatchTable<Output, TransitionStatus> = {
  response: (output) => {
    if (
      output.statusCode !== null &&
      output.statusCode.type === "literal" &&
      typeof output.statusCode.value === "number"
    ) {
      return { type: "known", status: output.statusCode.value };
    }
    return { type: "unknownStatus" };
  },
  throw: () => ({ type: "nonResponse" }),
  render: () => ({ type: "nonResponse" }),
  return: () => ({ type: "nonResponse" }),
  delegate: () => ({ type: "nonResponse" }),
  emit: () => ({ type: "nonResponse" }),
  void: () => ({ type: "nonResponse" }),
};

export function transitionStatus(transition: Transition): TransitionStatus {
  return dispatchByType(OUTPUT_STATUS, transition.output);
}

export interface TransitionEvaluation {
  transition: Transition;
  conditions: Tri;
  status: TransitionStatus;
}

export interface Mismatch {
  verdict: "falseClaim" | "uncovered";
  request: GeneratedRequest;
  observedStatus: number;
  detail: string;
}

export interface HarnessFailure {
  request: GeneratedRequest;
  message: string;
}

export interface DifferentialResult {
  moduleSource: string;
  summary: BehavioralSummary;
  requestsRun: number;
  mismatches: Mismatch[];
  harnessFailures: HarnessFailure[];
}

function describeTransition(evaluation: TransitionEvaluation): string {
  const { transition, conditions, status } = evaluation;
  const statusText =
    status.type === "known" ? String(status.status) : status.type;
  return `${transition.id} (conditions: ${conditions}, status: ${statusText})`;
}

/**
 * Judge one observation against the summary's transitions. Returns the
 * mismatch if the observation falsifies the summary, else null.
 */
export function judgeObservation(
  summary: BehavioralSummary,
  request: GeneratedRequest,
  observedStatus: number,
): Mismatch | null {
  const env = { req: request };
  const evaluations: TransitionEvaluation[] = summary.transitions.map(
    (transition) => ({
      transition,
      conditions: evalConditions(transition.conditions, env),
      status: transitionStatus(transition),
    }),
  );

  const falseClaims = evaluations.filter(
    (e) =>
      e.conditions === "true" &&
      e.status.type === "known" &&
      e.status.status !== observedStatus,
  );
  if (falseClaims.length > 0) {
    return {
      verdict: "falseClaim",
      request,
      observedStatus,
      detail:
        `observed ${observedStatus}, but transitions with all-true conditions promise a different status: ` +
        falseClaims.map(describeTransition).join("; "),
    };
  }

  const covered = evaluations.some(
    (e) =>
      (e.conditions === "true" || e.conditions === "unknown") &&
      (e.status.type === "unknownStatus" ||
        (e.status.type === "known" && e.status.status === observedStatus)),
  );
  if (!covered && summary.gaps.length === 0) {
    return {
      verdict: "uncovered",
      request,
      observedStatus,
      detail:
        `observed ${observedStatus}, but no transition's conditions admit it and no gap is declared. Transitions: ` +
        evaluations.map(describeTransition).join("; "),
    };
  }

  return null;
}

/** Both rendered views of a program for a target. */
export function renderProgram(
  program: HandlerProgram,
  target: FuzzTarget,
): { moduleSource: string; handlerSource: string } {
  return {
    moduleSource: target.renderModule(
      renderBodyLines(program, target.renderTerminal),
    ),
    handlerSource: renderHandlerSource(program, target.renderTerminal),
  };
}

/** Extract once, execute the battery, adjudicate every observation. */
export async function runDifferential(
  program: HandlerProgram,
  target: FuzzTarget = EXPRESS_TARGET,
): Promise<DifferentialResult> {
  const { moduleSource, handlerSource } = renderProgram(program, target);
  const summary = await extractHandlerSummary(moduleSource, target.pack());
  const requests = requestBattery(program);

  const mismatches: Mismatch[] = [];
  const harnessFailures: HarnessFailure[] = [];

  for (const request of requests) {
    const execution = executeHandler(
      handlerSource,
      request,
      target.makeResponder,
    );
    if (execution.type === "error") {
      harnessFailures.push({ request, message: execution.message });
      continue;
    }
    const mismatch = judgeObservation(
      summary,
      request,
      execution.observed.status,
    );
    if (mismatch !== null) {
      mismatches.push(mismatch);
    }
  }

  return {
    moduleSource,
    summary,
    requestsRun: requests.length,
    mismatches,
    harnessFailures,
  };
}
