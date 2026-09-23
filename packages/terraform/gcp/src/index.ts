/**
 * What Google Cloud's Terraform provider declares, as far as suss reads
 * it.
 *
 * A log-based metric is a boundary. The resource declares a series of
 * measurements, and an alert policy reads it back by the type string
 * Cloud Monitoring gives it, whether the policy writes that string out
 * or builds it from a reference to the metric resource.
 *
 * Google's own terms appear only in this file. Each entry gives the
 * attribute that contains a Google value and what that value means in
 * suss's terms, so `checkMetric` in `@suss/checker` can judge a pair
 * without loading a pack.
 */

import type { MetricAccumulation, MetricValueShape } from "@suss/behavioral-ir";
import type {
  AttributeMeaning,
  EnvDeclaration,
  TerraformPack,
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
const SQL_VERSIONS: AttributeMeaning<string> = {
  attribute: "database_version",
  matches: "prefix",
  means: {
    POSTGRES_: "postgresql",
    MYSQL_: "mysql",
    SQLSERVER_: "mssql",
  },
};

/**
 * BOOL, STRING and MONEY are left out because suss has no value shape
 * for them, and a metric with no value shape is not compared.
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
 * Cloud Monitoring accepts only these four percentiles when comparing a
 * distribution to a threshold, so any other aligner leaves the
 * distribution unreduced.
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
 * The variables each product sets in the environment itself. A service
 * and a job get different ones, so the deployment target alone does not
 * decide. DESIGN.md gives the page each list comes from.
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
          // Code passes the same name to `bucket()`, so both sides use
          // it as the identity.
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
          // A schema written in the configuration lists every column. A
          // schema from a file or a variable is out of sight, so `none` is
          // the fallback when fieldsFromJson finds nothing.
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
        // A database in Datastore mode uses a different API, so this
        // entry does not describe it.
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
          // Code passes the table id to `instance.table()`, so the
          // declared name matches the accessed one.
          nameAttribute: "name",
          // Column families are not the fields of a row.
          fieldSet: "none",
        },
      },
      {
        resource: "google_sql_database_instance",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          // Code addresses tables inside the database, which no
          // attribute of the instance lists, so the entry declares the
          // store and claims no access.
          storageSystem: SQL_VERSIONS,
          declares: "store",
          fieldSet: "none",
        },
      },
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
          // access. The README explains why.
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
          // itself under this prefix, and an alert policy writes the
          // whole string, so the identity is the whole string.
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
          // service, so it uses the same deployment target as one.
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
          // The entry point is an exported name and does not give the
          // file it is in.
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
