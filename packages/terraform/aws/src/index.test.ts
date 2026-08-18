// What the entries say, read through the reader they are written for.
// A test that only looked at the table would pass on entries that
// describe nothing.

import { describe, expect, it } from "vitest";

import { readStorageContractMetadata } from "@suss/behavioral-ir";
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
