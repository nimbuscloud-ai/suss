// What the reader says about a table Terraform declares. The shapes
// here are the ones a module writes: a name built at deploy time, keys
// stated on the resource, and indexes as their own blocks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readMetricContractMetadata,
  readMetricReadingMetadata,
  readStorageContractMetadata,
} from "@suss/behavioral-ir";

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
        serves: {
          kindAttribute: "projection_type",
          fieldsAttribute: "non_key_attributes",
          everything: "ALL",
        },
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

describe("shapes a configuration writes that the reader has to take as they come", () => {
  it("marks a queue the provider is told to make FIFO", () => {
    const [queue] = terraformToSummaries(
      [
        'resource "aws_sqs_queue" "jobs" {',
        '  name       = "jobs.fifo"',
        "  fifo_queue = true",
        "}",
      ].join("\n"),
      "main.tf",
      PACKS,
    );

    expect(queue.metadata?.messageBus).toEqual({
      physicalName: "jobs.fifo",
      fifoQueue: true,
    });
  });

  it("does not record a deployed name when the resource states none", () => {
    const [queue] = terraformToSummaries(
      ['resource "aws_sqs_queue" "jobs" {', "  delay_seconds = 90", "}"].join(
        "\n",
      ),
      "main.tf",
      PACKS,
    );

    expect(queue.identity.boundaryBinding?.semantics).toMatchObject({
      channel: "jobs",
    });
    expect(queue.metadata?.messageBus).toEqual({});
  });

  it("reads two resources of one type, which HCL writes as a list", () => {
    const summaries = terraformToSummaries(
      [
        'resource "aws_sqs_queue" "first" {',
        '  name = "first"',
        "}",
        'resource "aws_sqs_queue" "second" {',
        '  name = "second"',
        "}",
      ].join("\n"),
      "main.tf",
      PACKS,
    );

    expect(summaries.map((s) => s.identity.name)).toEqual([
      "aws_sqs_queue.first",
      "aws_sqs_queue.second",
    ]);
  });

  it("skips an index block without a name, since nothing addresses it", () => {
    const summaries = terraformToSummaries(
      [
        'resource "aws_dynamodb_table" "orders" {',
        '  name     = "orders"',
        '  hash_key = "order_id"',
        "  global_secondary_index {",
        '    hash_key = "customer_id"',
        "  }",
        "}",
      ].join("\n"),
      "main.tf",
      PACKS,
    );

    expect(summaries).toHaveLength(1);
  });

  it("leaves a resource alone when the pack that states it is for another provider", () => {
    const google = {
      name: "test-google",
      provider: "google",
      resources: [
        {
          resource: "aws_sqs_queue",
          providerVersions: ">=1",
          boundary: {
            kind: "message-bus" as const,
            messageBus: "sqs" as const,
            nameAttribute: "name",
          },
        },
      ],
    };
    const source = [
      "terraform {",
      "  required_providers {",
      "    aws = {",
      '      version = "~> 5.0"',
      "    }",
      "  }",
      "}",
      'resource "aws_sqs_queue" "jobs" {',
      '  name = "jobs"',
      "}",
    ].join("\n");

    // The pin is on `aws`, and this pack speaks for `google`, so its
    // entry is read whatever the aws pin says.
    expect(
      terraformToSummaries(source, "main.tf", { packs: [google] }),
    ).toHaveLength(1);
  });

  it("reads an entry when the pin is text semver cannot settle", () => {
    const source = [
      "terraform {",
      "  required_providers {",
      "    aws = {",
      '      version = "whatever hashicorp ships"',
      "    }",
      "  }",
      "}",
      'resource "aws_sqs_queue" "jobs" {',
      '  name = "jobs"',
      "}",
    ].join("\n");

    expect(terraformToSummaries(source, "main.tf", PACKS)).toHaveLength(1);
  });
});

// An index that copies part of an item serves those fields and no
// others. A reader asking for anything else gets nothing back and no
// error from the store, which is why the declaration matters.
const NARROW_INDEX = `
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

  global_secondary_index {
    name            = "by-edition-v1"
    hash_key        = "entry_id"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "keys-only-v1"
    hash_key        = "status"
    projection_type = "KEYS_ONLY"
  }
}
`;

describe("an index that copies part of an item", () => {
  const summaries = terraformToSummaries(NARROW_INDEX, "main.tf", PACKS);
  const byAccessPath = (path: string) =>
    readStorageContractMetadata(
      summaries.find((summary) =>
        summary.identity.name.endsWith(`#${path}`),
      ) as BehavioralSummary,
    );

  it("says every field it can serve, its own keys and the table's included", () => {
    const contract = byAccessPath("by-tenant-v2");

    expect(contract?.fieldSet).toBe("exhaustive");
    expect(contract?.fields?.map((field) => field.name).sort()).toEqual([
      "created_at",
      "entry_id",
      "headline",
      "status",
      "tenant_id",
    ]);
  });

  it("says nothing about fields for an index that copies the whole item", () => {
    const contract = byAccessPath("by-edition-v1");

    expect(contract?.fieldSet).toBe("partial");
    expect(contract?.fields?.map((field) => field.name)).toEqual(["entry_id"]);
  });

  it("serves only keys when that is all it copies", () => {
    const contract = byAccessPath("keys-only-v1");

    expect(contract?.fieldSet).toBe("exhaustive");
    expect(contract?.fields?.map((field) => field.name).sort()).toEqual([
      "created_at",
      "entry_id",
      "status",
    ]);
  });

  it("leaves the table itself saying what it always said", () => {
    const table = summaries.find(
      (summary) => !summary.identity.name.includes("#"),
    ) as BehavioralSummary;

    expect(readStorageContractMetadata(table)?.fieldSet).toBe("partial");
  });
});

/**
 * A pack for a provider nobody ships, so what the reader does with a
 * metric and with a resource that reads one is visible without any
 * shipped provider's vocabulary being involved.
 */
const SIGNALS: TerraformPack = {
  name: "test-signals",
  provider: "signals",
  resources: [
    {
      resource: "signals_counter",
      providerVersions: ">=1 <2",
      boundary: {
        kind: "metric",
        metricSystem: "signals",
        nameAttribute: "name",
        metricTypeTemplate: "signals.example/counters/{name}",
        values: {
          attribute: "shape.value_type",
          means: { SPREAD: "spread", SCALAR: "number" },
        },
        accumulates: {
          attribute: "shape.reset",
          means: { NEVER: "sinceStart", EACH_WINDOW: "interval" },
        },
      },
    },
    {
      resource: "signals_watch",
      providerVersions: ">=1 <2",
      boundary: {
        kind: "metric-reading",
        metricSystem: "signals",
        readingBlocks: ["rules", "over_threshold"],
        queryAttribute: "selector",
        queryIdentityKey: "signal.id",
        comparesTo: { attribute: "limit", whenSet: "number" },
        reducesTo: {
          attribute: "window.reducer",
          means: { MEDIAN: "number", EVERY_BUCKET: "spread" },
        },
      },
    },
  ],
};

const SIGNAL_CONFIGURATION = `
resource "signals_counter" "refusals" {
  name = "\${var.environment}-refusals"

  shape {
    value_type = "SPREAD"
    reset      = "EACH_WINDOW"
  }
}

resource "signals_watch" "refusals_climbing" {
  rules {
    over_threshold {
      selector = "signal.id=\\"signals.example/counters/\${var.environment}-refusals\\" AND region=\\"west\\""
      limit    = 5

      window {
        reducer = "MEDIAN"
      }
    }
  }

  rules {
    over_threshold {
      selector = "signal.id ="
    }
  }

  rules {
    over_threshold {
      limit = 9
    }
  }
}
`;

describe("a metric one resource declares and another reads", () => {
  const summaries = terraformToSummaries(SIGNAL_CONFIGURATION, "signals.tf", {
    packs: [SIGNALS],
  });
  const named = (name: string) =>
    summaries.find((summary) => summary.identity.name === name);

  it("gives the metric the identity the deployed series has", () => {
    const metric = named("signals_counter.refusals");

    expect(metric?.kind).toBe("library");
    expect(metric?.identity.boundaryBinding?.semantics).toEqual({
      name: "metric",
      metricSystem: "signals",
      metricType: "signals.example/counters/{var.environment}-refusals",
    });
  });

  it("says what the metric measures in the words the pack translated to", () => {
    expect(
      readMetricContractMetadata(
        named("signals_counter.refusals") as BehavioralSummary,
      ),
    ).toEqual({ values: "spread", accumulates: "interval" });
  });

  it("says what a rule needs, and how a fix to it would be written", () => {
    expect(
      readMetricReadingMetadata(
        named("signals_watch.refusals_climbing#0") as BehavioralSummary,
      ),
    ).toEqual({
      comparesTo: "number",
      reducesTo: "number",
      reduction: {
        setting: "window.reducer",
        leaves: { MEDIAN: "number", EVERY_BUCKET: "spread" },
      },
    });
  });

  it("leaves out what a rule states nothing about", () => {
    expect(
      readMetricReadingMetadata(
        named("signals_watch.refusals_climbing#1") as BehavioralSummary,
      ),
    ).toEqual({
      reduction: {
        setting: "window.reducer",
        leaves: { MEDIAN: "number", EVERY_BUCKET: "spread" },
      },
    });
  });

  it("reads each rule as its own consumer, spelling the metric the same way", () => {
    const reading = named("signals_watch.refusals_climbing#0");

    expect(reading?.kind).toBe("consumer");
    expect(reading?.identity.boundaryBinding?.semantics).toMatchObject({
      metricType: "signals.example/counters/{var.environment}-refusals",
    });
  });

  it("says a rule whose selector it could not read is about no metric", () => {
    const unreadable = named("signals_watch.refusals_climbing#1");

    expect(unreadable?.identity.boundaryBinding?.semantics).toMatchObject({
      metricType: null,
    });
  });

  it("says the same of a rule that states no selector at all", () => {
    const unsaid = named("signals_watch.refusals_climbing#2");

    expect(unsaid?.identity.boundaryBinding?.semantics).toMatchObject({
      metricType: null,
    });
    expect(
      readMetricReadingMetadata(unsaid as BehavioralSummary),
    ).toMatchObject({ comparesTo: "number" });
  });
});

describe("a pack that only wants the metric's identity", () => {
  const summaries = terraformToSummaries(SIGNAL_CONFIGURATION, "signals.tf", {
    packs: [
      {
        name: "test-signals-bare",
        provider: "signals",
        resources: SIGNALS.resources.map((pattern) => ({
          ...pattern,
          boundary:
            pattern.boundary.kind === "metric"
              ? {
                  kind: "metric",
                  metricSystem: "signals",
                  nameAttribute: "name",
                  metricTypeTemplate: "signals.example/counters/{name}",
                }
              : {
                  kind: "metric-reading",
                  metricSystem: "signals",
                  readingBlocks: ["rules", "over_threshold"],
                  queryAttribute: "selector",
                  queryIdentityKey: "signal.id",
                },
        })),
      },
    ],
  });
  const named = (name: string) =>
    summaries.find((summary) => summary.identity.name === name);

  it("says nothing about what either side measures or needs", () => {
    expect(
      readMetricContractMetadata(
        named("signals_counter.refusals") as BehavioralSummary,
      ),
    ).toEqual({});
    expect(
      readMetricReadingMetadata(
        named("signals_watch.refusals_climbing#0") as BehavioralSummary,
      ),
    ).toEqual({});
  });
});
