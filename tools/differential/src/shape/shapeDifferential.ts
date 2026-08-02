// shapeDifferential.ts: run every oracle against one generated shape.
//
// Three oracles, and each catches something the others cannot:
//
// - execution: the program runs, and a transition whose conditions hold
//   promised a different status than the one observed.
// - invariants: the summary set is wrong on its own terms, whatever the
//   program does (nothing said at high confidence, two summaries on one
//   identity, a boundary with no key).
// - equivalence: the same behavior written the plainest way produced a
//   different summary. A spelling that loses a claim is invisible to
//   the other two, because the program still runs and the summary that
//   survives is well-formed.

import { judgeObservation } from "../differential.js";
import { executeHandler } from "../execute.js";
import { extractAllSummaries } from "../extract.js";
import { requestBattery } from "../requests.js";
import {
  type AnnounceShapeSpec,
  renderAnnounceShape,
  SIMPLEST_ANNOUNCEMENT,
} from "./announceShape.js";
import {
  type ComponentShapeSpec,
  renderComponentShape,
  SIMPLEST_COMPONENT_SHAPE,
} from "./componentShape.js";
import { summarySetDifferences } from "./equivalence.js";
import { checkInvariants } from "./invariants.js";
import { renderShape, type ShapeSpec, SIMPLEST_SHAPE } from "./shapeProgram.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { GeneratedRequest } from "../requests.js";
import type { ShapeExpectation } from "./invariants.js";
import type { WideTypeSize } from "./shapeProgram.js";
import type { ShapeTarget } from "./shapeTargets.js";

export type Oracle = "execution" | "invariant" | "equivalence";

export interface ShapeFinding {
  oracle: Oracle;
  detail: string;
}

export interface ShapeHarnessFailure {
  request: GeneratedRequest;
  message: string;
}

export interface ShapeResult {
  spec: ShapeSpec | ComponentShapeSpec | AnnounceShapeSpec;
  /** The dimension values this shape was drawn at, for the failure line. */
  label: string;
  files: Record<string, string>;
  baselineFiles: Record<string, string>;
  summaries: BehavioralSummary[];
  findings: ShapeFinding[];
  harnessFailures: ShapeHarnessFailure[];
  requestsRun: number;
}

/** Kept small: the risk a wide type carries is breadth, not size on disk. */
export const WIDE_TYPE_SIZE: WideTypeSize = { width: 10, depth: 4 };

/** The plainest spelling of the same behavior. */
export function baselineOf(spec: ShapeSpec): ShapeSpec {
  return { ...SIMPLEST_SHAPE, result: spec.result, body: spec.body };
}

const sameShape = (left: ShapeSpec, right: ShapeSpec): boolean =>
  left.form === right.form &&
  left.binding === right.binding &&
  left.reach === right.reach &&
  left.result === right.result;

const EXPECTATION: Omit<ShapeExpectation, "kind"> = {
  boundaryCount: 1,
  unitName: null,
};

export async function runShapeDifferential(
  spec: ShapeSpec,
  shapeTarget: ShapeTarget,
): Promise<ShapeResult> {
  const rendered = renderShape({
    spec,
    syntax: shapeTarget.syntax,
    wideType: WIDE_TYPE_SIZE,
  });
  const pack = shapeTarget.target.pack();
  const summaries = await extractAllSummaries({ files: rendered.files, pack });

  const expectation: ShapeExpectation = { ...EXPECTATION, kind: "handler" };
  const findings: ShapeFinding[] = checkInvariants(summaries, expectation).map(
    (violation) => ({
      oracle: "invariant" as const,
      detail: `${violation.invariant}: ${violation.detail}`,
    }),
  );

  const baseline = baselineOf(spec);
  const baselineRendered = renderShape({
    spec: baseline,
    syntax: shapeTarget.syntax,
    wideType: WIDE_TYPE_SIZE,
  });
  if (!sameShape(spec, baseline)) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  const harnessFailures: ShapeHarnessFailure[] = [];
  const handlerSummaries = summaries.filter((s) => s.kind === "handler");
  const requests = requestBattery(spec.body);
  const runExecution = rendered.executable && handlerSummaries.length === 1;

  if (runExecution) {
    const summary = handlerSummaries[0];
    for (const request of requests) {
      const execution = executeHandler(
        rendered.handlerSource,
        request,
        shapeTarget.target.makeResponder,
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
        findings.push({
          oracle: "execution",
          detail: `${mismatch.verdict}: ${mismatch.detail} (request ${JSON.stringify(mismatch.request)})`,
        });
      }
    }
  }

  return {
    spec,
    label: `${spec.form} / ${spec.binding} / ${spec.reach} / ${spec.result}`,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures,
    requestsRun: runExecution ? requests.length : 0,
  };
}

// ---------------------------------------------------------------------------
// The render boundary
// ---------------------------------------------------------------------------

/**
 * A component shape changes how the component is written, bound, and
 * exported, never what it renders, so execution cannot see a shape bug
 * here at all: the module runs the same whichever way it is exported.
 * The invariants and the baseline comparison are the whole oracle.
 */
export async function runComponentShapeDifferential(
  spec: ComponentShapeSpec,
  pack: PatternPack,
): Promise<ShapeResult> {
  const rendered = renderComponentShape(spec);
  const summaries = await extractAllSummaries({ files: rendered.files, pack });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "component",
    boundaryCount: 1,
    unitName: rendered.expectedName,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baseline = { ...SIMPLEST_COMPONENT_SHAPE, body: spec.body };
  const baselineRendered = renderComponentShape(baseline);
  const isBaseline =
    spec.form === baseline.form &&
    spec.binding === baseline.binding &&
    spec.route === baseline.route;

  if (!isBaseline) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
      { ignorePaths: ["identity.name"] },
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.form} / ${spec.binding} / ${spec.route}`,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// How a boundary announces itself
// ---------------------------------------------------------------------------

/**
 * A decorated controller is not run either: NestJS reads the decorators
 * and calls the method itself, so what a generated one does in a vm
 * says nothing. The invariants and the comparison against the bare
 * decorator are the oracle.
 */
export async function runAnnounceShapeDifferential(
  spec: AnnounceShapeSpec,
  pack: PatternPack,
): Promise<ShapeResult> {
  const files = renderAnnounceShape(spec);
  const summaries = await extractAllSummaries({ files, pack });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "handler",
    boundaryCount: 1,
    unitName: null,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baseline = { ...SIMPLEST_ANNOUNCEMENT, bodyKey: spec.bodyKey };
  const baselineFiles = renderAnnounceShape(baseline);
  const isBaseline =
    spec.announcement === baseline.announcement &&
    spec.method === baseline.method;

  if (!isBaseline) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineFiles,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.announcement} / ${spec.method}`,
    files,
    baselineFiles,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

export const shapeFailed = (result: ShapeResult): boolean =>
  result.findings.length > 0 || result.harnessFailures.length > 0;

/** The failure text a run prints: the finding, then the program it came from. */
export function formatShapeFailure(result: ShapeResult): string {
  const files = Object.entries(result.files)
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join("\n");
  return [
    `shape finding (${result.label})`,
    "",
    ...result.findings.map(
      (finding) => `[${finding.oracle}] ${finding.detail}`,
    ),
    ...result.harnessFailures.map(
      (failure) =>
        `[harness] ${failure.message} (request ${JSON.stringify(failure.request)})`,
    ),
    "",
    "=== program ===",
    files,
  ].join("\n");
}
