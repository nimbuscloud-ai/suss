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
import type {
  EnvDeclaration,
  TerraformPack,
  TerraformResourcePattern,
} from "@suss/contract-terraform";

/** The versions each entry below was written against. */
const CURRENT = ">=4 <8";

/** The system a log-based metric and an alert policy are both part of. */
const METRIC_SYSTEM = "cloud-monitoring";

/** The store a dataset and the tables in it are both part of. */
const BIGQUERY = "gcp.bigquery";

/**
 * The store each `database_version` prefix picks. The attribute states
 * an engine and a release together, `POSTGRES_15` and `MYSQL_8_0_31`,
 * and the releases change every quarter, so the entry matches the
 * engine part and leaves the rest alone.
 */
const SQL_VERSIONS = [
  { storageSystem: "postgresql", prefix: "POSTGRES_" },
  { storageSystem: "mysql", prefix: "MYSQL_" },
];

/**
 * One entry per SQL engine an instance can run. Code addresses tables
 * inside the database, which no attribute of the instance lists, so
 * each entry declares the store and claims no access.
 */
function sqlStores(): TerraformResourcePattern[] {
  return SQL_VERSIONS.map(({ storageSystem, prefix }) => ({
    resource: "google_sql_database_instance",
    providerVersions: CURRENT,
    appliesWhen: { attribute: "database_version", startsWith: [prefix] },
    boundary: {
      kind: "storage" as const,
      storageSystem,
      declares: "store" as const,
      fieldSet: "none" as const,
    },
  }));
}

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

/**
 * How a Cloud Run container writes one variable. The value is either
 * written out or supplied by a secret, and a secret's contents are not
 * in the configuration, so only the secret it comes from is read.
 */
const CONTAINER_ENV: EnvDeclaration = {
  style: "entries",
  block: "env",
  nameAttribute: "name",
  valueAttribute: "value",
  secretAttribute: "value_source.secret_key_ref.secret",
};

/**
 * What each product puts in the environment on its own. Google's
 * container runtime contract states them, and the pack README says
 * which page each list comes from. A service and a job get different
 * ones, so the target alone cannot say.
 */
const CLOUD_RUN_SERVICE_ENV = [
  "PORT",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
];

const CLOUD_RUN_JOB_ENV = [
  "CLOUD_RUN_JOB",
  "CLOUD_RUN_EXECUTION",
  "CLOUD_RUN_TASK_INDEX",
  "CLOUD_RUN_TASK_ATTEMPT",
  "CLOUD_RUN_TASK_COUNT",
];

const CLOUD_FUNCTION_ENV = [
  "PORT",
  "K_SERVICE",
  "K_REVISION",
  "FUNCTION_TARGET",
  "FUNCTION_SIGNATURE_TYPE",
];

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
        resource: "google_bigquery_dataset",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: BIGQUERY,
          // A dataset is the namespace a table is addressed through
          // rather than something a query reads on its own.
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "google_bigquery_table",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: BIGQUERY,
          nameAttribute: "table_id",
          scopeAttribute: "dataset_id",
          // A schema written in the configuration is every column the
          // table has; one a file or a variable supplies says nothing.
          fieldSet: "none",
          fieldsFromJson: {
            attribute: "schema",
            nameKey: "name",
            typeKey: "type",
            requires: { key: "mode", values: ["REQUIRED", "REPEATED"] },
          },
        },
      },
      {
        resource: "google_spanner_database",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "gcp.spanner",
          // The tables are in the `ddl` statements rather than in an
          // attribute, so the database declares the store and no more.
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "google_firestore_database",
        providerVersions: CURRENT,
        // A database in Datastore mode speaks a different API, so it is
        // not the store this entry describes.
        appliesWhen: { attribute: "type", equals: ["FIRESTORE_NATIVE"] },
        boundary: {
          kind: "storage",
          storageSystem: "gcp.firestore",
          // Code addresses collections, which no attribute of the
          // database lists.
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "google_bigtable_table",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "gcp.bigtable",
          // A table id is what code passes to `instance.table()`, so
          // the declared name and the accessed name meet.
          nameAttribute: "name",
          // Column families are not the fields of a row.
          fieldSet: "none",
        },
      },
      ...sqlStores(),
      {
        resource: "google_pubsub_topic",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "gcp_pubsub",
          nameAttribute: "name",
        },
      },
      {
        resource: "google_pubsub_subscription",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "gcp_pubsub",
          // A subscriber asks for the subscription rather than the
          // topic, so the subscription is its own channel.
          nameAttribute: "name",
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
        resource: "google_cloud_run_v2_service",
        providerVersions: CURRENT,
        boundary: {
          kind: "deployable",
          deploymentTarget: "container",
          containers: { blocks: ["template", "containers"] },
          env: [CONTAINER_ENV],
          code: { imageAttribute: "image" },
          platformEnvVars: CLOUD_RUN_SERVICE_ENV,
        },
      },
      {
        resource: "google_cloud_run_v2_job",
        providerVersions: CURRENT,
        boundary: {
          kind: "deployable",
          deploymentTarget: "container",
          // A job's containers sit one template deeper than a
          // service's: an execution template around a task template.
          containers: { blocks: ["template", "template", "containers"] },
          env: [CONTAINER_ENV],
          code: { imageAttribute: "image" },
          platformEnvVars: CLOUD_RUN_JOB_ENV,
        },
      },
      {
        resource: "google_cloudfunctions2_function",
        providerVersions: CURRENT,
        boundary: {
          kind: "deployable",
          // A second-generation function is deployed as a Cloud Run
          // service, so it runs on the same medium as one.
          deploymentTarget: "container",
          runtimeAttribute: "build_config.runtime",
          env: [
            { style: "map", attribute: "service_config.environment_variables" },
            {
              style: "entries",
              block: "service_config.secret_environment_variables",
              nameAttribute: "key",
              secretAttribute: "secret",
            },
          ],
          // The entry point is an exported name and says nothing about
          // which file it is in.
          code: {
            handler: {
              attribute: "build_config.entry_point",
              spelling: "name",
            },
          },
          platformEnvVars: CLOUD_FUNCTION_ENV,
        },
      },
      {
        resource: "google_monitoring_alert_policy",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric-reading",
          metricSystem: METRIC_SYSTEM,
          readingBlocks: ["conditions", "condition_threshold"],
          identifies: {
            from: "query",
            attribute: "filter",
            key: "metric.type",
          },
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
