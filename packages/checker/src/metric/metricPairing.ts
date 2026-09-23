/**
 * Compares the side that declares a metric with the sides that read it,
 * and reports a reading that asks the series for a value it does not
 * have.
 *
 * The declaring side records what one measurement is under
 * `metricContract`. A reading records under `metricReading` which shape
 * it compares against and what it reduces each window to first. The
 * check compares those two fields, so no pack runs at check time.
 *
 * Both sides key on (metricSystem, metricType), so the generic pairing
 * pass has already paired them and recorded the pair. This pass only
 * compares them.
 */

import {
  BOUNDARY_ROLE,
  readMetricContractMetadata,
  readMetricReadingMetadata,
  summaryRef,
} from "@suss/behavioral-ir";
import { metricIdentityKey } from "@suss/ir-core";

import {
  buildInteractionIndex,
  type InteractionIndex,
  providersOf,
} from "../interactions/dispatcher.js";

import type {
  BehavioralSummary,
  Finding,
  FindingSide,
  MetricReadingMetadata,
  MetricSemantics,
  MetricValueShape,
} from "@suss/behavioral-ir";

/** How a finding says what a measurement is. */
const SHAPE_WORDS: Record<MetricValueShape, string> = {
  number: "a single number",
  histogram: "a histogram of buckets",
};

/**
 * A reading about a metric nothing in the run declares is left alone.
 * Most alerts watch metrics the platform publishes, and a metric
 * declared in a module this run did not read looks the same from here.
 */
export function checkMetric(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
): Finding[] {
  const idx = index ?? buildInteractionIndex(summaries);
  const metrics = providersOf(idx, "metric");
  const declared = new Map<string, BehavioralSummary>();
  for (const summary of metrics) {
    const key = keyOf(summary);
    if (key !== null && BOUNDARY_ROLE[summary.kind] === "provider") {
      declared.set(key, summary);
    }
  }

  const findings: Finding[] = [];
  for (const reading of metrics) {
    if (BOUNDARY_ROLE[reading.kind] !== "consumer") {
      continue;
    }
    const key = keyOf(reading);
    const provider = key === null ? undefined : declared.get(key);
    if (provider === undefined) {
      continue;
    }
    const finding = shapeMismatch(provider, reading);
    if (finding !== null) {
      findings.push(finding);
    }
  }
  return findings;
}

/** The system and type both sides spell, or null when either is missing. */
function keyOf(summary: BehavioralSummary): string | null {
  const semantics = summary.identity.boundaryBinding?.semantics;
  if (semantics === undefined || semantics.name !== "metric") {
    return null;
  }
  const metric = semantics as MetricSemantics;
  if (metric.metricType === null) {
    return null;
  }
  return metricIdentityKey(metric.metricSystem, metric.metricType);
}

/**
 * The finding for a reading that compares the series against a shape it
 * does not produce. A side that says nothing about the shape makes no
 * claim, so it is left alone rather than assumed to be a number.
 */
function shapeMismatch(
  provider: BehavioralSummary,
  reading: BehavioralSummary,
): Finding | null {
  const needs = readMetricReadingMetadata(reading);
  const wanted = needs?.comparesTo;
  if (needs === undefined || wanted === undefined) {
    return null;
  }
  // A reading that reduces each window gets the reduced value, and one
  // that does not gets the raw measurement.
  const got = needs.reducesTo ?? readMetricContractMetadata(provider)?.values;
  const binding = reading.identity.boundaryBinding;
  if (got === undefined || got === wanted || binding === null) {
    return null;
  }
  const semantics = binding.semantics as MetricSemantics;
  return {
    kind: "boundaryShapeMismatch",
    aspect: "read",
    boundary: binding,
    provider: sideOf(provider),
    consumer: sideOf(reading),
    description: `${reading.identity.name} compares ${semantics.metricType} against ${SHAPE_WORDS[wanted]}, and ${provider.identity.name} declares that metric's measurements as ${SHAPE_WORDS[got]}, so the comparison has nothing to run against${howToFix(needs, wanted)}.`,
    severity: "error",
  };
}

/**
 * A hint giving the setting, and the values of it, that would reduce
 * each window to the shape the reading compares against. Empty when the
 * reading's metadata does not describe its reduction setting.
 */
function howToFix(
  needs: MetricReadingMetadata,
  wanted: MetricValueShape,
): string {
  const reduction = needs.reduction;
  if (reduction === undefined) {
    return "";
  }
  const options = Object.entries(reduction.leaves)
    .filter(([, shape]) => shape === wanted)
    .map(([option]) => option);
  if (options.length === 0) {
    return "";
  }
  return ` unless the reading reduces each window to ${SHAPE_WORDS[wanted]} first, by setting ${reduction.setting} to one of ${options.join(", ")}`;
}

function sideOf(summary: BehavioralSummary): FindingSide {
  return { summary: summaryRef(summary), location: summary.location };
}
