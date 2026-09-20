// What the entries say, read through the reader they are written for
// and checked by the pass that judges the pairs. A test that stopped at
// the reader would pass on entries nothing judges.

import { describe, expect, it } from "vitest";

import {
  readMetricContractMetadata,
  readMetricReadingMetadata,
  readStorageContractMetadata,
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

const STORES = `
resource "google_storage_bucket" "uploads" {
  name     = "acme-uploads"
  location = "US"
}

resource "google_redis_instance" "sessions" {
  name           = "sessions-v1"
  memory_size_gb = 1
}

resource "google_bigquery_dataset" "analytics" {
  dataset_id = "analytics"
  location   = "US"
}

resource "google_bigquery_table" "orders" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  table_id   = "orders"

  schema = jsonencode([
    { name = "order_id", type = "STRING", mode = "REQUIRED" },
    { name = "placed_at", type = "TIMESTAMP", mode = "NULLABLE" },
  ])
}

resource "google_bigquery_table" "sessions" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  table_id   = "sessions"
  schema     = file("schema/sessions.json")
}

resource "google_sql_database_instance" "ledger" {
  name             = "ledger"
  database_version = "POSTGRES_15"
  region           = "us-central1"
}

resource "google_sql_database_instance" "reporting" {
  name             = "reporting"
  database_version = "MYSQL_8_0_31"
  region           = "us-central1"
}

resource "google_sql_database_instance" "legacy" {
  name             = "legacy"
  database_version = "SQLSERVER_2019_STANDARD"
  region           = "us-central1"
}

resource "google_sql_database_instance" "archive" {
  name             = "archive"
  database_version = "ORACLE_19"
  region           = "us-central1"
}

variable "accounts_version" {
  type    = string
  default = "POSTGRES_15"
}

resource "google_sql_database_instance" "accounts" {
  name             = "accounts"
  database_version = var.accounts_version
  region           = "us-central1"
}

resource "google_spanner_database" "ledger" {
  name     = "ledger"
  instance = "spanner-main"
}

resource "google_firestore_database" "documents" {
  name        = "(default)"
  location_id = "nam5"
  type        = "FIRESTORE_NATIVE"
}

resource "google_firestore_database" "legacy_documents" {
  name        = "legacy"
  location_id = "nam5"
  type        = "DATASTORE_MODE"
}

resource "google_bigtable_table" "events" {
  name          = "events"
  instance_name = "bigtable-main"
}

resource "google_pubsub_topic" "orders" {
  name = "orders"
}

resource "google_pubsub_subscription" "orders_worker" {
  name  = "orders-worker"
  topic = google_pubsub_topic.orders.name
}
`;

describe("what the storage entries read", () => {
  it("reads a bucket under the name code passes to bucket()", () => {
    const bucket = boundary(STORES, "google_storage_bucket.uploads");
    expect(bucket.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "gcs",
      container: "uploads",
    });
    const contract = readStorageContractMetadata(bucket);
    expect(contract?.fieldSet).toBe("none");
    expect(contract?.physicalTable).toBe("acme-uploads");
  });

  it("reads a Memorystore instance as a store with no container to pair on", () => {
    const instance = boundary(STORES, "google_redis_instance.sessions");
    expect(instance.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "redis",
      container: null,
    });
    expect(
      readStorageContractMetadata(instance)?.physicalTable,
    ).toBeUndefined();
  });

  it("reads a BigQuery table in the dataset its reference resolves to", () => {
    const table = boundary(STORES, "google_bigquery_table.orders");
    expect(table.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "gcp.bigquery",
      scope: "analytics",
      container: "orders",
    });
    expect(readStorageContractMetadata(table)?.physicalTable).toBe("orders");
  });

  it("reads every column a table's schema states, and calls the list complete", () => {
    const contract = readStorageContractMetadata(
      boundary(STORES, "google_bigquery_table.orders"),
    );
    expect(contract?.fieldSet).toBe("exhaustive");
    expect(contract?.fields).toEqual([
      { name: "order_id", type: "STRING", nullable: false },
      { name: "placed_at", type: "TIMESTAMP", nullable: true },
    ]);
  });

  it("records no columns for a schema a file supplies", () => {
    const contract = readStorageContractMetadata(
      boundary(STORES, "google_bigquery_table.sessions"),
    );
    expect(contract?.fieldSet).toBe("none");
    expect(contract?.fields).toBeUndefined();
  });

  it("reads a dataset as the store its tables live in", () => {
    expect(
      boundary(STORES, "google_bigquery_dataset.analytics").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "gcp.bigquery", container: null });
  });

  it("reads a Cloud SQL instance as the store its database_version picks", () => {
    expect(
      boundary(STORES, "google_sql_database_instance.ledger").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "postgresql", container: null });
    expect(
      boundary(STORES, "google_sql_database_instance.reporting").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "mysql" });
  });

  it("reads a SQL Server instance as the store its database_version picks", () => {
    expect(
      boundary(STORES, "google_sql_database_instance.legacy").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "mssql" });
  });

  it("reads an instance whose engine the entry does not list, with no engine on it", () => {
    const archive = boundary(STORES, "google_sql_database_instance.archive");
    expect(archive.identity.boundaryBinding?.semantics).toMatchObject({
      storageSystem: null,
    });
    expect(archive.gaps.map((gap) => gap.description)).toEqual([
      '"database_version" states an engine this run could not settle, so which store this is stays unknown and it pairs with an access on any engine.',
    ]);
  });

  it("reads an instance whose version a variable supplies, with no engine on it", () => {
    expect(
      boundary(STORES, "google_sql_database_instance.accounts").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: null });
  });

  it("reads Spanner and Firestore as stores with no container to pair on", () => {
    expect(
      boundary(STORES, "google_spanner_database.ledger").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "gcp.spanner", container: null });
    expect(
      boundary(STORES, "google_firestore_database.documents").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "gcp.firestore", container: null });
  });

  it("skips a Firestore database in Datastore mode, which speaks another API", () => {
    expect(
      read(STORES).some(
        (s) => s.identity.name === "google_firestore_database.legacy_documents",
      ),
    ).toBe(false);
  });

  it("reads a Bigtable table under the id code passes to table()", () => {
    const table = boundary(STORES, "google_bigtable_table.events");
    expect(table.identity.boundaryBinding?.semantics).toMatchObject({
      storageSystem: "gcp.bigtable",
      container: "events",
    });
    expect(readStorageContractMetadata(table)?.physicalTable).toBe("events");
  });

  it("reads a topic and a subscription as channels of their own", () => {
    expect(
      boundary(STORES, "google_pubsub_topic.orders").identity.boundaryBinding
        ?.semantics,
    ).toMatchObject({
      name: "message-bus",
      messageBus: "gcp_pubsub",
      channel: "orders",
    });
    expect(
      boundary(STORES, "google_pubsub_subscription.orders_worker").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ messageBus: "gcp_pubsub", channel: "orders_worker" });
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
