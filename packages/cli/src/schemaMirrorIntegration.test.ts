/**
 * The Prisma copy in fixtures/schema-mirror, compared column by column
 * with the Rails app's dump of the same two tables. The app keeps the
 * dump as db/schema.rb or as db/structure.sql, and either one gives the
 * same findings. Each column schema.prisma comments on gives one
 * finding, and every other column agrees.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkSchemaAgreement } from "@suss/checker";
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";
import { railsSchemaToSummaries } from "@suss/contract-rails-schema";

import { readContract } from "./contract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtureRoot = path.resolve(__dirname, "../../../fixtures/schema-mirror");

const DUMPS = ["db/schema.rb", "db/structure.sql"];

function prismaCopy(): BehavioralSummary[] {
  return prismaSchemaFileToSummaries(path.join(fixtureRoot, "schema.prisma"));
}

async function dump(file: string): Promise<BehavioralSummary[]> {
  return readContract({
    from: "rails-schema",
    spec: path.join(fixtureRoot, file),
    warnings: [],
  });
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

describe.each(DUMPS)("a Prisma copy of the tables %s declares", (file) => {
  it("reads the engine from config/database.yml and marks each table a dump", async () => {
    const tables = await dump(file);
    expect(
      tables.map((table) => [
        table.identity.name,
        table.identity.boundaryBinding?.semantics,
      ]),
    ).toEqual([
      ["attachments", expect.objectContaining({ storageSystem: "postgresql" })],
      ["orders", expect.objectContaining({ storageSystem: "postgresql" })],
    ]);
    expect(tables.map((table) => table.metadata?.storageContract)).toEqual([
      expect.objectContaining({ origin: "dump" }),
      expect.objectContaining({ origin: "dump" }),
    ]);
  });

  it("gives one finding for each column that disagrees, and none for the rest", async () => {
    const { findings, unchecked } = findingsOf([
      ...prismaCopy(),
      ...(await dump(file)),
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

  it("reports no default on a now() column the database leaves without one, since the client sends the time", async () => {
    const { findings } = findingsOf([...prismaCopy(), ...(await dump(file))]);
    const createdAt = findings.filter((finding) =>
      finding.column?.endsWith(".created_at"),
    );
    expect(createdAt).toEqual([]);
  });
});

describe("a dump keyed differently from its copy", () => {
  it("compares no column of the table", async () => {
    const keyedOnBigint = await railsSchemaToSummaries(`
ActiveRecord::Schema[7.1].define(version: 2024_06_01_000000) do
  create_table "attachments", force: :cascade do |t|
    t.uuid "blob_id", null: false
  end
end
`);
    const { findings } = findingsOf([...prismaCopy(), ...keyedOnBigint]);
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
