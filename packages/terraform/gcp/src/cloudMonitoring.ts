/**
 * The Cloud Monitoring words both halves of this pack spell.
 *
 * The entries ask the reader for these attributes and the rule reads
 * them back, so a path spelled two ways would leave the rule quietly
 * judging nothing. Written once here, both halves move together.
 */

/** The system a log-based metric and an alert policy are both part of. */
export const METRIC_SYSTEM = "cloud-monitoring";

/**
 * Cloud Monitoring puts every metric a project defines for itself under
 * this prefix, and an alert policy spells the whole string, so the whole
 * string is the identity the two sides share.
 */
export const METRIC_TYPE_TEMPLATE = "logging.googleapis.com/user/{name}";

/** Whether the metric counts, gauges, or accumulates. */
export const METRIC_KIND = "metric_descriptor.metric_kind";

/** Whether one measurement is a number, a spread, or something else. */
export const VALUE_TYPE = "metric_descriptor.value_type";

/** A value type whose measurements are a spread of buckets. */
export const DISTRIBUTION = "DISTRIBUTION";

/** How a condition compares the series to its threshold. */
export const COMPARISON = "comparison";

/** The number a condition compares the series to. */
export const THRESHOLD = "threshold_value";

/** What a condition does to each series before it compares anything. */
export const ALIGNER = "aggregations.per_series_aligner";

/**
 * The aligners that turn a distribution into one number per window.
 * Cloud Monitoring's own error message on a bad apply lists these, and
 * refuses every other way of comparing a distribution to a threshold.
 */
export const PERCENTILE_ALIGNERS = new Set([
  "ALIGN_PERCENTILE_99",
  "ALIGN_PERCENTILE_95",
  "ALIGN_PERCENTILE_50",
  "ALIGN_PERCENTILE_05",
]);
