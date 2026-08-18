/**
 * What Cloud Monitoring refuses to do with a distribution.
 *
 * A condition that compares a series to a threshold compares one number
 * to another. A DISTRIBUTION metric produces a spread of buckets rather
 * than a number, so the comparison has nothing to run against unless an
 * aligner reduces each window to a percentile first. Both resources are
 * well formed on their own, terraform validate and plan both pass, and
 * the provider refuses the pair minutes into an apply.
 *
 * The reader knows none of this. It reads the attributes the entries in
 * `index.ts` ask for and pairs the two sides on the metric type; this
 * file is where knowing what those attribute values mean lives.
 */

import { BOUNDARY_ROLE, summaryRef } from "@suss/behavioral-ir";
import { readTerraformDeclaration } from "@suss/contract-terraform";

import {
  ALIGNER,
  COMPARISON,
  DISTRIBUTION,
  METRIC_SYSTEM,
  PERCENTILE_ALIGNERS,
  THRESHOLD,
  VALUE_TYPE,
} from "./cloudMonitoring.js";

import type {
  BehavioralSummary,
  Finding,
  FindingSide,
  MetricSemantics,
} from "@suss/behavioral-ir";

/** One condition, with what it says about the metric it reads. */
interface Condition {
  summary: BehavioralSummary;
  metricType: string;
  stated: Record<string, string | number | boolean>;
}

/**
 * Every condition that compares a distribution to a threshold with
 * nothing reducing it to a number first.
 *
 * A condition about a metric nothing in the run declares is left alone:
 * most alerts watch metrics the platform publishes, and a metric
 * declared in a module this run did not read is the same from here. The
 * pairing pass reports a boundary with one side missing.
 */
export function checkAlertConditions(
  summaries: BehavioralSummary[],
): Finding[] {
  const declared = declaredMetrics(summaries);
  const findings: Finding[] = [];
  for (const condition of conditionsIn(summaries)) {
    const metric = declared.get(condition.metricType);
    if (metric === undefined) {
      continue;
    }
    if (!comparesADistribution(metric, condition)) {
      continue;
    }
    findings.push(makeThresholdFinding(metric, condition));
  }
  return findings;
}

function comparesADistribution(
  metric: BehavioralSummary,
  condition: Condition,
): boolean {
  if (stateOf(metric)[VALUE_TYPE] !== DISTRIBUTION) {
    return false;
  }
  if (condition.stated[THRESHOLD] === undefined) {
    return false;
  }
  const aligner = condition.stated[ALIGNER];
  return typeof aligner !== "string" || !PERCENTILE_ALIGNERS.has(aligner);
}

/** Every metric a configuration in this run declares, by its type. */
function declaredMetrics(
  summaries: BehavioralSummary[],
): Map<string, BehavioralSummary> {
  const declared = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    const metricType = metricTypeOf(summary, "provider");
    if (metricType !== null) {
      declared.set(metricType, summary);
    }
  }
  return declared;
}

/** Every reading of a metric, with what the reading states about it. */
function conditionsIn(summaries: BehavioralSummary[]): Condition[] {
  const conditions: Condition[] = [];
  for (const summary of summaries) {
    const metricType = metricTypeOf(summary, "consumer");
    if (metricType !== null) {
      conditions.push({ summary, metricType, stated: stateOf(summary) });
    }
  }
  return conditions;
}

/**
 * The Cloud Monitoring metric this summary is about, from whichever
 * side, or null when it is about something else.
 */
function metricTypeOf(
  summary: BehavioralSummary,
  side: "provider" | "consumer",
): string | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "metric") {
    return null;
  }
  const semantics = binding.semantics as MetricSemantics;
  if (
    semantics.metricSystem !== METRIC_SYSTEM ||
    BOUNDARY_ROLE[summary.kind] !== side
  ) {
    return null;
  }
  return semantics.metricType;
}

function stateOf(
  summary: BehavioralSummary,
): Record<string, string | number | boolean> {
  return readTerraformDeclaration(summary)?.attributes ?? {};
}

function makeThresholdFinding(
  metric: BehavioralSummary,
  condition: Condition,
): Finding {
  const binding = condition.summary.identity.boundaryBinding;
  if (binding === null) {
    // Unreachable: a condition without a binding never got a metric
    // type, and one without a metric type never reached this.
    throw new Error(`${condition.summary.identity.name} has no boundary`);
  }
  const comparison = condition.stated[COMPARISON];
  const compares =
    comparison === undefined ? "compares" : `compares (${comparison})`;
  return {
    kind: "boundaryShapeMismatch",
    aspect: "read",
    boundary: binding,
    provider: sideOf(metric),
    consumer: sideOf(condition.summary),
    description: `${condition.summary.identity.name} ${compares} ${condition.metricType} against the threshold ${condition.stated[THRESHOLD]}, and ${metric.identity.name} declares that metric as a ${DISTRIBUTION}. A distribution has no single value to compare, so the apply fails unless the condition aligns it to a percentile first, with per_series_aligner set to one of ${[...PERCENTILE_ALIGNERS].join(", ")}.`,
    severity: "error",
  };
}

function sideOf(summary: BehavioralSummary): FindingSide {
  return { summary: summaryRef(summary), location: summary.location };
}
