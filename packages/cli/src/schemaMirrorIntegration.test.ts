/**
 * The Prisma copy in fixtures/schema-mirror, compared column by column
 * with the Rails declaration of the same two tables. No reader for
 * `db/schema.rb` exists yet, so this file builds that declaration by
 * hand, the way such a reader would write each `create_table`. Each
 * column the fixture comments on gives one finding, and every other
 * column agrees.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";
import { checkSchemaAgreement } from "@suss/checker";
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";

import type {
  BehavioralSummary,
  StorageContractMetadata,
} from "@suss/behavioral-ir";

type Field = NonNullable<StorageContractMetadata["fields"]>[number];

const fixtureRoot = path.resolve(__dirname, "../../../fixtures/schema-mirror");

function railsTable(container: string, fields: Field[]): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "db/schema.rb",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: container,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "rails-schema",
        storageSystem: "postgresql",
        scope: "default",
        container,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: { fieldSet: "exhaustive", fields, origin: "dump" },
    },
  };
}

function column(
  name: string,
  type: string,
  nullable: boolean,
  more: Partial<Field> = {},
): Field {
  return { name, type, nullable, default: false, ...more };
}

const ORDERS = railsTable("orders", [
  column("id", "bigint", false, { primary: true, default: true }),
  column("customer_id", "bigint", false, { foreignKey: "users" }),
  column("status", "string", false, { default: true }),
  column("priority", "integer", false),
  // `t.integer "quantity", limit: 2`
  column("quantity", "smallint", false),
  column("total", "decimal", false),
  column("weight", "float", true),
  column("paid", "boolean", false, { default: true }),
  column("public_id", "uuid", false),
  column("metadata", "jsonb", true),
  column("receipt", "binary", true),
  column("tags", "string[]", false, { default: true }),
  column("state", "enum", false, { default: true }),
  column("ship_on", "date", true),
  column("notes", "text", true),
  column("reference", "string", false),
  column("legacy_code", "string", true),
  column("created_at", "datetime", false),
  column("updated_at", "datetime", false),
]);

const ATTACHMENTS = railsTable("attachments", [
  column("id", "uuid", false, { primary: true, default: true }),
  column("blob_id", "uuid", false),
  column("order_id", "bigint", false, { foreignKey: "orders" }),
  column("filename", "string", false),
  column("created_at", "datetime", false),
]);

function prismaCopy(): BehavioralSummary[] {
  return prismaSchemaFileToSummaries(path.join(fixtureRoot, "schema.prisma"));
}

function findingsOf(summaries: BehavioralSummary[]) {
  const result = checkSchemaAgreement(summaries);
  return {
    unchecked: result.unchecked,
    findings: result.findings
      .map((finding) => ({
        kind: finding.kind,
        severity: finding.severity,
        column: finding.description.split(":")[0],
        field: finding.consumer.field ?? finding.provider.field,
      }))
      .sort((a, b) => (a.column ?? "").localeCompare(b.column ?? "")),
  };
}

describe("a Prisma copy of tables a Rails app owns", () => {
  it("gives one finding for each column that disagrees, and none for the rest", () => {
    const { findings, unchecked } = findingsOf([
      ...prismaCopy(),
      ORDERS,
      ATTACHMENTS,
    ]);

    expect(unchecked).toEqual([]);
    expect(findings).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        column: "attachments.blob_id",
        field: "blobId",
      },
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        column: "orders.customer_id",
        field: "customerId",
      },
      {
        kind: "boundaryFieldUnknown",
        severity: "error",
        column: "orders.discount_code",
        field: "discountCode",
      },
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        column: "orders.notes",
        field: "notes",
      },
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        column: "orders.public_id",
        field: "publicId",
      },
      {
        kind: "boundaryFieldUnknown",
        severity: "error",
        column: "orders.reference",
        field: "reference",
      },
      {
        kind: "boundaryShapeMismatch",
        severity: "error",
        column: "orders.weight",
        field: "weight",
      },
    ]);
  });

  it("reports no default on a now() column the database leaves without one, since the client sends the time", () => {
    const { findings } = findingsOf([...prismaCopy(), ORDERS, ATTACHMENTS]);
    const createdAt = findings.filter((finding) =>
      finding.column?.endsWith(".created_at"),
    );
    expect(createdAt).toEqual([]);
  });

  it("compares no column of a table whose two declarations are keyed differently", () => {
    const keyedOnBigint = railsTable("attachments", [
      column("id", "bigint", false, { primary: true, default: true }),
      column("blob_id", "uuid", false),
    ]);
    const { findings } = findingsOf([...prismaCopy(), keyedOnBigint]);
    expect(findings).toEqual([
      {
        kind: "boundaryShapeMismatch",
        severity: "warning",
        column: "attachments",
        field: undefined,
      },
    ]);
  });
});
