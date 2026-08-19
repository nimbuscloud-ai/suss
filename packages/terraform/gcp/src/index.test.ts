// What the entries say, read through the reader they are written for
// and checked by the pass that judges the pairs. A test that stopped at
// the reader would pass on entries nothing judges.

import { describe, expect, it } from "vitest";

import {
  readMetricContractMetadata,
  readMetricReadingMetadata,
} from "@suss/behavioral-ir";
import { checkMetric } from "@suss/checker";
import { terraformToSummaries } from "@suss/contract-terraform";

import { googleTerraform } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const PACKS = { packs: [googleTerraform()] };

/** The pair the provider refuses: a distribution against a number. */
const REFUSED = `
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_logging_metric" "sweep_refused" {
  name   = "sweep-refused"
  filter = "resource.type=\\"cloud_run_revision\\" AND jsonPayload.outcome=\\"refused\\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
  }
}

resource "google_monitoring_alert_policy" "sweep_refused_sustained" {
  display_name = "sweep refused, sustained"

  conditions {
    display_name = "refusals above five"

    condition_threshold {
      filter          = "metric.type=\\"logging.googleapis.com/user/sweep-refused\\" AND resource.type=\\"cloud_run_revision\\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
    }
  }
}
`;

function read(configuration: string): BehavioralSummary[] {
  return terraformToSummaries(configuration, "monitoring.tf", PACKS);
}

function boundary(configuration: string, name: string): BehavioralSummary {
  const found = read(configuration).find((s) => s.identity.name === name);
  if (found === undefined) {
    throw new Error(`nothing read for ${name}`);
  }
  return found;
}

/** The same configuration with one attribute rewritten. */
function withEdit(from: string, to: string): string {
  if (!REFUSED.includes(from)) {
    throw new Error(`the fixture does not state ${from}`);
  }
  return REFUSED.replace(from, to);
}

describe("what the Google entries read", () => {
  it("reads a log-based metric as the metric type it produces", () => {
    const metric = boundary(REFUSED, "google_logging_metric.sweep_refused");
    expect(metric.identity.boundaryBinding?.semantics).toEqual({
      name: "metric",
      metricSystem: "cloud-monitoring",
      metricType: "logging.googleapis.com/user/sweep-refused",
    });
    expect(readMetricContractMetadata(metric)).toEqual({
      values: "histogram",
      accumulates: "delta",
    });
  });

  it("reads an alert condition as the metric its filter states", () => {
    const condition = boundary(
      REFUSED,
      "google_monitoring_alert_policy.sweep_refused_sustained#0",
    );
    expect(condition.kind).toBe("consumer");
    expect(condition.identity.boundaryBinding?.semantics).toMatchObject({
      name: "metric",
      metricType: "logging.googleapis.com/user/sweep-refused",
    });
    expect(readMetricReadingMetadata(condition)).toEqual({
      comparesTo: "number",
      reduction: {
        setting: "aggregations.per_series_aligner",
        leaves: {
          ALIGN_PERCENTILE_99: "number",
          ALIGN_PERCENTILE_95: "number",
          ALIGN_PERCENTILE_50: "number",
          ALIGN_PERCENTILE_05: "number",
        },
      },
    });
  });

  it("says nothing about a resource no entry describes", () => {
    const names = read(REFUSED).map((s) => s.identity.name);
    expect(names).toHaveLength(2);
  });
});

describe("a threshold on a distribution", () => {
  it("is an error when nothing reduces the distribution", () => {
    const findings = checkMetric(read(REFUSED));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "boundaryShapeMismatch",
      aspect: "read",
      severity: "error",
    });
    expect(findings[0]?.description).toContain("ALIGN_PERCENTILE_95");
    expect(findings[0]?.provider.summary).toContain(
      "google_logging_metric.sweep_refused",
    );
  });

  it("is fine once an aligner reduces it to a percentile", () => {
    const aligned = withEdit(
      `      duration        = "300s"`,
      `      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }`,
    );
    const condition = boundary(
      aligned,
      "google_monitoring_alert_policy.sweep_refused_sustained#0",
    );
    expect(readMetricReadingMetadata(condition)?.reducesTo).toBe("number");
    expect(checkMetric(read(aligned))).toEqual([]);
  });

  it("is fine when the metric is a single number", () => {
    const gauge = withEdit(
      `    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"`,
      `    metric_kind = "GAUGE"
    value_type  = "INT64"`,
    );
    expect(
      readMetricContractMetadata(
        boundary(gauge, "google_logging_metric.sweep_refused"),
      ),
    ).toEqual({ values: "number", accumulates: "gauge" });
    expect(checkMetric(read(gauge))).toEqual([]);
  });

  it("says nothing about a metric this run never read", () => {
    const elsewhere = withEdit(
      "logging.googleapis.com/user/sweep-refused",
      "run.googleapis.com/request_latencies",
    );
    const summaries = read(elsewhere);
    expect(
      summaries.some(
        (s) =>
          s.kind === "consumer" &&
          s.identity.boundaryBinding?.semantics.name === "metric",
      ),
    ).toBe(true);
    expect(checkMetric(summaries)).toEqual([]);
  });

  it("reads a condition whose filter it cannot parse as naming no metric", () => {
    const unreadable = withEdit(
      `metric.type=\\"logging.googleapis.com/user/sweep-refused\\" AND resource.type=\\"cloud_run_revision\\"`,
      "metric.type =",
    );
    const summaries = read(unreadable);
    const condition = summaries.find((s) => s.kind === "consumer");
    expect(condition?.identity.boundaryBinding?.semantics).toMatchObject({
      metricType: null,
    });
    expect(checkMetric(summaries)).toEqual([]);
  });

  it("says nothing about a value type this pack does not describe", () => {
    const bool = withEdit(
      `value_type  = "DISTRIBUTION"`,
      `value_type  = "BOOL"`,
    );
    expect(
      readMetricContractMetadata(
        boundary(bool, "google_logging_metric.sweep_refused"),
      )?.values,
    ).toBeUndefined();
    expect(checkMetric(read(bool))).toEqual([]);
  });
});

describe("an alert whose filter refers to the metric resource", () => {
  const REFERRED = withEdit(
    'metric.type=\\"logging.googleapis.com/user/sweep-refused\\"',
    'metric.type=\\"logging.googleapis.com/user/${google_logging_metric.sweep_refused.name}\\"',
  );

  it("reads the condition as the metric that resource declares", () => {
    const condition = boundary(
      REFERRED,
      "google_monitoring_alert_policy.sweep_refused_sustained#0",
    );
    expect(condition.identity.boundaryBinding?.semantics).toMatchObject({
      metricType: "logging.googleapis.com/user/sweep-refused",
    });
  });

  it("reports the threshold on a distribution, as the literal filter does", () => {
    const findings = checkMetric(read(REFERRED));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.provider.summary).toContain(
      "google_logging_metric.sweep_refused",
    );
  });
});
