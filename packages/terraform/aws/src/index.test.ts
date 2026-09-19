// What the entries say, read through the reader they are written for.
// A test that only looked at the table would pass on entries that
// describe nothing.

import { describe, expect, it } from "vitest";

import {
  readMetricReadingMetadata,
  readStorageContractMetadata,
} from "@suss/behavioral-ir";
import { terraformToSummaries } from "@suss/contract-terraform";

import { awsTerraform } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const PACKS = { packs: [awsTerraform()] };

const CONFIGURATION = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_dynamodb_table" "orders" {
  name      = "\${local.environment}-orders-v1"
  hash_key  = "order_id"
  range_key = "placed_at"

  attribute {
    name = "order_id"
    type = "S"
  }

  global_secondary_index {
    name     = "by-customer-v1"
    hash_key = "customer_id"
  }
}

resource "aws_s3_bucket" "uploads" {
  bucket = "\${local.environment}-uploads"
}

resource "aws_sqs_queue" "jobs" {
  name = "\${local.environment}-jobs"
}

resource "aws_sns_topic" "alerts" {
  name = "\${local.environment}-alerts"
}

resource "aws_cloudwatch_event_bus" "orders" {
  name = "\${local.environment}-order-events"
}

resource "aws_elasticache_cluster" "sessions" {
  cluster_id = "sessions-v1"
  engine     = "redis"
  node_type  = "cache.t3.micro"
}

resource "aws_elasticache_cluster" "fragments" {
  cluster_id = "fragments-v1"
  engine     = "memcached"
  node_type  = "cache.t3.micro"
}

resource "aws_elasticache_cluster" "sessions_member" {
  cluster_id           = "sessions-v1-002"
  replication_group_id = "sessions-v1-group"
}

resource "aws_elasticache_replication_group" "editions" {
  replication_group_id = "editions-v1"
  description          = "edition cache"
}

resource "aws_rds_cluster" "ledger" {
  cluster_identifier = "\${local.environment}-ledger"
  engine             = "aurora-postgresql"
  database_name      = "ledger"
}

resource "aws_db_instance" "reporting" {
  identifier = "reporting"
  engine     = "mariadb"
}

resource "aws_db_instance" "archive" {
  identifier = "archive"
  engine     = "sqlserver-ex"
}

resource "aws_kinesis_stream" "clicks" {
  name = "\${local.environment}-clicks"
}

resource "aws_kinesis_firehose_delivery_stream" "clicks_archive" {
  name        = "\${local.environment}-clicks-archive"
  destination = "extended_s3"
}

resource "aws_cloudwatch_log_metric_filter" "refusals" {
  name           = "refusals"
  pattern        = "{ $.outcome = \\"refused\\" }"
  log_group_name = "/aws/lambda/orders"

  metric_transformation {
    name      = "Refusals"
    namespace = "OrderService"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "refusals_climbing" {
  alarm_name          = "refusals-climbing"
  namespace           = "OrderService"
  metric_name         = "Refusals"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
}

resource "aws_iam_role" "runner" {
  name = "runner"
}
`;

function read(): BehavioralSummary[] {
  return terraformToSummaries(CONFIGURATION, "main.tf", PACKS);
}

function boundary(name: string): BehavioralSummary {
  const found = read().find((s) => s.identity.name === name);
  if (found === undefined) {
    throw new Error(`nothing read for ${name}`);
  }
  return found;
}

describe("what the AWS entries read", () => {
  it("reads a table, keyed the way the resource states", () => {
    const table = boundary("aws_dynamodb_table.orders");
    expect(table.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "aws.dynamodb",
      container: "orders",
      accessPath: null,
    });

    const contract = readStorageContractMetadata(table);
    expect(contract?.fieldSet).toBe("partial");
    expect(contract?.physicalTable).toBe("{local.environment}-orders-v1");
    expect(contract?.identifies).toEqual({
      kind: "keyFields",
      fields: ["order_id", "placed_at"],
    });
    expect(contract?.fields?.[0]).toEqual({
      name: "order_id",
      type: "S",
      primary: true,
    });
  });

  it("gives a secondary index its own boundary", () => {
    expect(
      boundary("aws_dynamodb_table.orders#by-customer-v1").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ container: "orders", accessPath: "by-customer-v1" });
  });

  it("reads a bucket as a store with no fields to compare against", () => {
    const bucket = boundary("aws_s3_bucket.uploads");
    expect(bucket.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "s3",
      container: "uploads",
    });
    const contract = readStorageContractMetadata(bucket);
    expect(contract?.fieldSet).toBe("none");
    expect(contract?.identifies).toBeUndefined();
    expect(contract?.physicalTable).toBe("{local.environment}-uploads");
  });

  it("reads a queue, a topic, and an event bus as channels", () => {
    expect(
      boundary("aws_sqs_queue.jobs").identity.boundaryBinding?.semantics,
    ).toMatchObject({
      name: "message-bus",
      messageBus: "aws_sqs",
      channel: "jobs",
    });
    expect(
      boundary("aws_sns_topic.alerts").identity.boundaryBinding?.semantics,
    ).toMatchObject({ messageBus: "aws.sns" });
    const bus = read().find(
      (s) =>
        s.identity.boundaryBinding?.semantics.name === "message-bus" &&
        s.identity.boundaryBinding.semantics.messageBus === "eventbridge",
    );
    expect(bus?.identity.name).toBe("aws_cloudwatch_event_bus.orders");
  });

  it("reads a Redis cluster as a store with no container to pair on", () => {
    const cluster = boundary("aws_elasticache_cluster.sessions");
    expect(cluster.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "redis",
      container: null,
    });
    const contract = readStorageContractMetadata(cluster);
    expect(contract?.fieldSet).toBe("none");
    expect(contract?.physicalTable).toBeUndefined();
  });

  it("skips a Memcached cluster, which is not the store the entry describes", () => {
    expect(read().some((s) => s.identity.name.includes("fragments"))).toBe(
      false,
    );
  });

  it("reads a cluster with no engine of its own, since it joins a replication group", () => {
    expect(
      boundary("aws_elasticache_cluster.sessions_member").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "redis" });
  });

  it("reads a replication group as the same kind of store", () => {
    expect(
      boundary("aws_elasticache_replication_group.editions").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "redis", container: null });
  });

  it("reads an Aurora cluster as the PostgreSQL store its engine picks", () => {
    const cluster = boundary("aws_rds_cluster.ledger");
    expect(cluster.identity.boundaryBinding?.semantics).toMatchObject({
      name: "storage",
      storageSystem: "postgresql",
      container: null,
    });
    expect(readStorageContractMetadata(cluster)?.fieldSet).toBe("none");
  });

  it("reads a MariaDB instance as a MySQL store, which is what its driver speaks", () => {
    expect(
      boundary("aws_db_instance.reporting").identity.boundaryBinding?.semantics,
    ).toMatchObject({ storageSystem: "mysql" });
  });

  it("skips an engine no entry describes", () => {
    expect(
      read().some((s) => s.identity.name === "aws_db_instance.archive"),
    ).toBe(false);
  });

  it("reads a stream and a delivery stream as channels of their own", () => {
    expect(
      boundary("aws_kinesis_stream.clicks").identity.boundaryBinding?.semantics,
    ).toMatchObject({ messageBus: "aws_kinesis", channel: "clicks" });
    expect(
      boundary("aws_kinesis_firehose_delivery_stream.clicks_archive").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({ messageBus: "aws_firehose" });
  });

  it("identifies a log-based metric by its namespace and its name together", () => {
    expect(
      boundary("aws_cloudwatch_log_metric_filter.refusals").identity
        .boundaryBinding?.semantics,
    ).toMatchObject({
      name: "metric",
      metricSystem: "cloudwatch",
      metricType: "OrderService/Refusals",
    });
  });

  it("reads an alarm as a reading of that same metric", () => {
    const alarm = boundary("aws_cloudwatch_metric_alarm.refusals_climbing#0");
    expect(alarm.kind).toBe("consumer");
    expect(alarm.identity.boundaryBinding?.semantics).toMatchObject({
      metricSystem: "cloudwatch",
      metricType: "OrderService/Refusals",
    });
    expect(readMetricReadingMetadata(alarm)).toMatchObject({
      comparesTo: "number",
      reducesTo: "number",
    });
  });

  it("leaves everything that is deployment wiring alone", () => {
    expect(read().some((s) => s.identity.name.includes("runner"))).toBe(false);
  });

  it("says nothing about a configuration pinned to a provider these entries do not describe", () => {
    expect(
      terraformToSummaries(
        CONFIGURATION.replace('version = "~> 5.0"', 'version = "~> 3.0"'),
        "main.tf",
        PACKS,
      ),
    ).toEqual([]);
  });
});

// The case this exists for: an index copies part of an item, a query
// reads a field it does not copy, and DynamoDB returns nothing for that
// field and raises no error. Both sides of that are here, so the
// checker has something to compare.
const NARROW_FEED_INDEX = `
resource "aws_dynamodb_table" "ledger" {
  name      = "ledger-v2"
  hash_key  = "entry_id"
  range_key = "created_at"

  global_secondary_index {
    name            = "by-tenant-v2"
    hash_key        = "tenant_id"
    range_key       = "created_at"
    projection_type = "INCLUDE"
    non_key_attributes = [
      "status",
      "headline",
    ]
  }
}
`;

describe("an index that copies part of an item", () => {
  it("declares what a reader of it can get, and says the list is complete", () => {
    const summaries = terraformToSummaries(NARROW_FEED_INDEX, "main.tf", PACKS);
    const index = summaries.find((summary: BehavioralSummary) =>
      summary.identity.name.endsWith("#by-tenant-v2"),
    );
    const contract = readStorageContractMetadata(index as BehavioralSummary);

    expect(contract?.fieldSet).toBe("exhaustive");
    expect(contract?.fields?.map((field) => field.name).sort()).toEqual([
      "created_at",
      "entry_id",
      "headline",
      "status",
      "tenant_id",
    ]);
  });
});
