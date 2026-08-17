// What the reader says about a table Terraform declares. The shapes
// here are the ones a module writes: a name built at deploy time, keys
// stated on the resource, and indexes as their own blocks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readStorageContractMetadata } from "@suss/behavioral-ir";

import { terraformFileToSummaries, terraformToSummaries } from "./index.js";

import type { BehavioralSummary, StorageSemantics } from "@suss/behavioral-ir";
import type { TerraformPack } from "./pack.js";

/**
 * What a pack says about the two resources these tests use. The reader
 * has no AWS knowledge of its own, so every test states it here.
 */
const AWS: TerraformPack = {
  name: "test-aws",
  provider: "aws",
  resources: [
    {
      resource: "aws_dynamodb_table",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "storage",
        storageSystem: "dynamodb",
        transport: "aws-sdk",
        nameAttribute: "name",
        fieldSet: "partial",
        identifies: ["hash_key", "range_key"],
        accessPathBlocks: ["global_secondary_index", "local_secondary_index"],
        fieldTypes: {
          block: "attribute",
          nameAttribute: "name",
          typeAttribute: "type",
        },
      },
    },
    {
      resource: "aws_sqs_queue",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "message-bus",
        messageBus: "sqs",
        nameAttribute: "name",
      },
    },
  ],
};

const PACKS = { packs: [AWS] };

const ORDERS = `
resource "aws_dynamodb_table" "orders" {
  name         = "\${local.environment}-orders-v1"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "order_id"
  range_key    = "placed_at"

  attribute {
    name = "order_id"
    type = "S"
  }
  attribute {
    name = "placed_at"
    type = "N"
  }
  attribute {
    name = "customer_id"
    type = "S"
  }

  global_secondary_index {
    name            = "by-customer-v1"
    hash_key        = "customer_id"
    projection_type = "ALL"
  }
}
`;

function storageOf(
  summaries: BehavioralSummary[],
): Array<{ summary: BehavioralSummary; semantics: StorageSemantics }> {
  return summaries.flatMap((summary) => {
    const semantics = summary.identity.boundaryBinding?.semantics;
    return semantics?.name === "storage" ? [{ summary, semantics }] : [];
  });
}

describe("a table Terraform declares", () => {
  it("takes the resource label as the container and the deployed name as a pattern", () => {
    const [table] = storageOf(
      terraformToSummaries(ORDERS, "main.tf", PACKS),
    ).filter((s) => s.semantics.accessPath === null);

    expect(table.semantics).toMatchObject({
      storageSystem: "dynamodb",
      container: "orders",
      accessPath: null,
    });
    expect(table.summary.identity.boundaryBinding?.transport).toBe("aws-sdk");
    expect(readStorageContractMetadata(table.summary)?.physicalTable).toBe(
      "{local.environment}-orders-v1",
    );
  });

  it("states the keys it identifies an item by, partition key first", () => {
    const [table] = storageOf(
      terraformToSummaries(ORDERS, "main.tf", PACKS),
    ).filter((s) => s.semantics.accessPath === null);

    const contract = readStorageContractMetadata(table.summary);
    expect(contract?.fieldSet).toBe("partial");
    expect(contract?.identifies).toEqual({
      kind: "keyFields",
      fields: ["order_id", "placed_at"],
    });
    expect(contract?.fields).toEqual([
      { name: "order_id", type: "S", primary: true },
      { name: "placed_at", type: "N", primary: true },
    ]);
  });

  it("gives a secondary index its own boundary, keyed on that index's fields", () => {
    const [index] = storageOf(
      terraformToSummaries(ORDERS, "main.tf", PACKS),
    ).filter((s) => s.semantics.accessPath !== null);

    expect(index.semantics).toMatchObject({
      container: "orders",
      accessPath: "by-customer-v1",
    });
    expect(readStorageContractMetadata(index.summary)?.identifies).toEqual({
      kind: "keyFields",
      fields: ["customer_id"],
    });
  });

  it("reads a local secondary index the same way as a global one", () => {
    const summaries = storageOf(
      terraformToSummaries(
        `
        resource "aws_dynamodb_table" "orders" {
          name     = "orders-v1"
          hash_key = "order_id"
          local_secondary_index {
            name      = "by-status"
            hash_key  = "order_id"
            range_key = "status"
          }
        }
        `,
        "main.tf",
        PACKS,
      ),
    );

    expect(summaries.map((s) => s.semantics.accessPath)).toEqual([
      null,
      "by-status",
    ]);
  });

  it("reads a name nothing fills in as itself", () => {
    const [table] = storageOf(
      terraformToSummaries(
        [
          'resource "aws_dynamodb_table" "sessions" {',
          '  name     = "sessions-v1"',
          '  hash_key = "sid"',
          "}",
        ].join("\n"),
        "main.tf",
        PACKS,
      ),
    );

    expect(readStorageContractMetadata(table.summary)?.physicalTable).toBe(
      "sessions-v1",
    );
  });

  it("leaves every other resource type alone", () => {
    expect(
      terraformToSummaries(
        `
        resource "aws_security_group" "web" {
          name = "web"
        }
        resource "aws_iam_role" "runner" {
          name = "runner"
        }
        `,
        "main.tf",
        PACKS,
      ),
    ).toEqual([]);
  });

  it("says nothing about a configuration it cannot parse", () => {
    expect(terraformToSummaries("resource {{{", "main.tf", PACKS)).toEqual([]);
  });

  it("reads every .tf file in a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tf-"));
    fs.writeFileSync(path.join(dir, "main.tf"), ORDERS);
    fs.writeFileSync(
      path.join(dir, "sessions.tf"),
      [
        'resource "aws_dynamodb_table" "sessions" {',
        '  name     = "sessions-v1"',
        '  hash_key = "sid"',
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "README.md"), "not terraform");

    expect(
      storageOf(terraformFileToSummaries(dir, PACKS))
        .map((s) => s.semantics.container)
        .sort(),
    ).toEqual(["orders", "orders", "sessions"]);
  });
});

describe("what a pack says, and which provider version it says it for", () => {
  const QUEUE = [
    'resource "aws_sqs_queue" "jobs" {',
    '  name = "${var.environment}-jobs"',
    "}",
  ].join("\n");

  function pinned(version: string): string {
    return [
      "terraform {",
      "  required_providers {",
      "    aws = {",
      '      source  = "hashicorp/aws"',
      `      version = "${version}"`,
      "    }",
      "  }",
      "}",
      QUEUE,
    ].join("\n");
  }

  it("reads a queue as a channel, with its deployed name as a pattern", () => {
    const [queue] = terraformToSummaries(QUEUE, "main.tf", PACKS);
    const semantics = queue.identity.boundaryBinding?.semantics;

    expect(semantics).toMatchObject({
      name: "message-bus",
      messageBus: "sqs",
      channel: "jobs",
    });
    expect(
      (queue.metadata?.messageBus as { physicalName?: string })?.physicalName,
    ).toBe("{var.environment}-jobs");
  });

  it("reads a resource when the configuration pins a version the entry describes", () => {
    expect(
      terraformToSummaries(pinned("~> 5.0"), "main.tf", PACKS),
    ).toHaveLength(1);
  });

  it("says nothing about a resource whose provider version the entry does not describe", () => {
    expect(terraformToSummaries(pinned("~> 3.0"), "main.tf", PACKS)).toEqual(
      [],
    );
  });

  it("reads a configuration that pins nothing, since nothing said otherwise", () => {
    expect(terraformToSummaries(QUEUE, "main.tf", PACKS)).toHaveLength(1);
  });

  it("says nothing when no pack states the resource", () => {
    expect(
      terraformToSummaries(QUEUE, "main.tf", {
        packs: [{ name: "empty", provider: "aws", resources: [] }],
      }),
    ).toEqual([]);
  });
});
