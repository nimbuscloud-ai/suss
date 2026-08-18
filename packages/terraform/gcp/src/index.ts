/**
 * What Google Cloud's Terraform provider declares, as far as suss reads
 * it.
 *
 * A log-based metric is a boundary: the resource declares a series of
 * measurements, and an alert policy elsewhere reads it back by the type
 * string Cloud Monitoring gives it. Neither resource refers to the
 * other, so that string is all they share.
 *
 * Every entry says which provider versions it describes, the same way
 * the AWS entries do. The rule that judges a pair of them is in
 * `alertConditions.ts` next door.
 */

import {
  ALIGNER,
  COMPARISON,
  METRIC_KIND,
  METRIC_SYSTEM,
  METRIC_TYPE_TEMPLATE,
  THRESHOLD,
  VALUE_TYPE,
} from "./cloudMonitoring.js";

import type { TerraformPack } from "@suss/contract-terraform";

/** The versions each entry below was written against. */
const CURRENT = ">=4 <8";

export function googleTerraform(): TerraformPack {
  return {
    name: "terraform-gcp",
    provider: "google",
    resources: [
      {
        resource: "google_logging_metric",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric",
          metricSystem: METRIC_SYSTEM,
          nameAttribute: "name",
          metricTypeTemplate: METRIC_TYPE_TEMPLATE,
          states: [METRIC_KIND, VALUE_TYPE],
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
          states: [COMPARISON, THRESHOLD, ALIGNER],
        },
      },
    ],
  };
}

export { checkAlertConditions } from "./alertConditions.js";

export default googleTerraform;
