/**
 * metricPairing.ts: pair the side that declares a metric against the
 * sides that read it, and report a reading that asks the series for a
 * value it does not have.
 *
 * The declaring side says what one measurement is under
 * `metricContract`, and a reading says under `metricReading` what shape
 * it compares against and what it turns each window into first.
 * Comparing those two is the whole rule, so no pack runs at check time.
 *
 * Both sides key on (metricSystem, metricType), so the generic pairing
 * pass already put them together and recorded the pair. This one only
 * judges.
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
  spread: "a spread of buckets",
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
  // What the reading gets: what it reduces each window to when it
  // reduces, and otherwise what the series measures.
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
 * The setting that would give the reading the shape it compares
 * against, when whoever read it said how one is written.
 */
function howToFix(
  needs: MetricReadingMetadata,
  wanted: MetricValueShape,
): string {
  const reduction = needs.reduction;
  if (reduction === undefined || reduction.options.length === 0) {
    return "";
  }
  return ` unless the reading reduces each window to ${SHAPE_WORDS[wanted]} first, by setting ${reduction.setting} to one of ${reduction.options.join(", ")}`;
}

function sideOf(summary: BehavioralSummary): FindingSide {
  return { summary: summaryRef(summary), location: summary.location };
}
