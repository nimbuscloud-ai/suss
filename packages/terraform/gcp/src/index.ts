/**
 * What Google Cloud's Terraform provider declares, as far as suss reads
 * it.
 *
 * A log-based metric is a boundary: the resource declares a series of
 * measurements, and an alert policy elsewhere reads it back by the type
 * string Cloud Monitoring gives it. That string is what the two share,
 * whether the policy writes it out or builds it from a reference to the
 * metric resource.
 *
 * Google's vocabulary starts and stops in this file. Each entry says
 * which attribute a resource writes which of Google's words in, and
 * what they mean in the terms suss compares boundaries in, so
 * `checkMetric` in `@suss/checker` judges a pair with no pack loaded.
 */

import type { MetricAccumulation, MetricValueShape } from "@suss/behavioral-ir";
import type { TerraformPack } from "@suss/contract-terraform";

/** The versions each entry below was written against. */
const CURRENT = ">=4 <8";

/** The system a log-based metric and an alert policy are both part of. */
const METRIC_SYSTEM = "cloud-monitoring";

/**
 * What each value type measures. BOOL, STRING, and MONEY are left out:
 * no word suss has describes them, and a metric this pack says nothing
 * about is compared against nothing.
 */
const VALUE_TYPES: Record<string, MetricValueShape> = {
  INT64: "number",
  DOUBLE: "number",
  DISTRIBUTION: "histogram",
};

/** What each metric kind says one measurement covers. */
const METRIC_KINDS: Record<string, MetricAccumulation> = {
  GAUGE: "gauge",
  DELTA: "delta",
  CUMULATIVE: "cumulative",
};

/**
 * What each aligner leaves behind. Cloud Monitoring's error message on
 * a bad apply lists the percentile four, and refuses every other way of
 * comparing a distribution to a threshold, so an aligner missing from
 * here is one that leaves the distribution alone.
 */
const ALIGNERS: Record<string, MetricValueShape> = {
  ALIGN_PERCENTILE_99: "number",
  ALIGN_PERCENTILE_95: "number",
  ALIGN_PERCENTILE_50: "number",
  ALIGN_PERCENTILE_05: "number",
};

export function googleTerraform(): TerraformPack {
  return {
    name: "terraform-gcp",
    provider: "google",
    resources: [
      {
        resource: "google_storage_bucket",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "gcs",
          // The name is what code passes to `bucket()`, so it is the
          // identity both sides spell.
          nameAttribute: "name",
          // An object has no fields to compare a read against.
          fieldSet: "none",
        },
      },
      {
        resource: "google_redis_instance",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "redis",
          // Code addresses key namespaces, which no attribute of the
          // instance lists, so it declares the store and claims no
          // access. The README says how the sides meet.
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "google_logging_metric",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric",
          metricSystem: METRIC_SYSTEM,
          nameAttribute: "name",
          // Cloud Monitoring puts every metric a project defines for
          // itself under this prefix, and an alert policy spells the
          // whole string, so the whole string is the shared identity.
          metricTypeTemplate: "logging.googleapis.com/user/{name}",
          values: {
            attribute: "metric_descriptor.value_type",
            means: VALUE_TYPES,
          },
          accumulates: {
            attribute: "metric_descriptor.metric_kind",
            means: METRIC_KINDS,
          },
        },
      },
      {
        resource: "google_monitoring_alert_policy",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric-reading",
          metricSystem: METRIC_SYSTEM,
          readingBlocks: ["conditions", "condition_threshold"],
          queryAttribute: "filter",
          queryIdentityKey: "metric.type",
          comparesTo: { attribute: "threshold_value", whenSet: "number" },
          reducesTo: {
            attribute: "aggregations.per_series_aligner",
            means: ALIGNERS,
          },
        },
      },
    ],
  };
}

export default googleTerraform;
