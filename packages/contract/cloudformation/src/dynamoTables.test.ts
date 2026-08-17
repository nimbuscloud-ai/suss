// What the reader says about a DynamoDB table: the table and each of
// its secondary indexes become boundaries of their own, and the
// contract states the keys rather than everything an item has.

import { describe, expect, it } from "vitest";

import { readStorageContractMetadata } from "@suss/behavioral-ir";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary, StorageSemantics } from "@suss/behavioral-ir";

function storageSummaries(
  summaries: BehavioralSummary[],
): Array<{ summary: BehavioralSummary; semantics: StorageSemantics }> {
  return summaries.flatMap((summary) => {
    const semantics = summary.identity.boundaryBinding?.semantics;
    return semantics?.name === "storage" ? [{ summary, semantics }] : [];
  });
}

const ordersTable = {
  Type: "AWS::DynamoDB::Table",
  Properties: {
    TableName: "orders-prod",
    AttributeDefinitions: [
      { AttributeName: "orderId", AttributeType: "S" },
      { AttributeName: "placedAt", AttributeType: "N" },
      { AttributeName: "customerId", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "placedAt", KeyType: "RANGE" },
      { AttributeName: "orderId", KeyType: "HASH" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "byCustomer",
        KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
      },
    ],
  },
};

function ordersSummaries() {
  return storageSummaries(
    cloudFormationToSummaries({ Resources: { Orders: ordersTable } }),
  );
}

describe("a DynamoDB table", () => {
  it("becomes a storage boundary the template's own name reaches", () => {
    const [table] = ordersSummaries().filter(
      (s) => s.semantics.accessPath === null,
    );

    expect(table.semantics).toMatchObject({
      storageSystem: "dynamodb",
      scope: "default",
      container: "Orders",
      accessPath: null,
    });
    expect(table.summary.identity.boundaryBinding?.transport).toBe("aws-sdk");
    expect(readStorageContractMetadata(table.summary)?.physicalTable).toBe(
      "orders-prod",
    );
  });

  it("says its key attributes are not every field an item has", () => {
    const [table] = ordersSummaries().filter(
      (s) => s.semantics.accessPath === null,
    );

    const contract = readStorageContractMetadata(table.summary);
    expect(contract?.fieldSet).toBe("partial");
    expect(contract?.fields).toEqual([
      { name: "orderId", type: "S", primary: true },
      { name: "placedAt", type: "N", primary: true },
    ]);
  });

  it("states the partition key before the sort key, whatever order the template lists them in", () => {
    const [table] = ordersSummaries().filter(
      (s) => s.semantics.accessPath === null,
    );

    expect(readStorageContractMetadata(table.summary)?.identifies).toEqual({
      kind: "keyFields",
      fields: ["orderId", "placedAt"],
    });
  });

  it("gives a secondary index its own boundary, keyed on the index's fields", () => {
    const [index] = ordersSummaries().filter(
      (s) => s.semantics.accessPath !== null,
    );

    expect(index.semantics).toMatchObject({
      container: "Orders",
      accessPath: "byCustomer",
    });
    expect(readStorageContractMetadata(index.summary)?.identifies).toEqual({
      kind: "keyFields",
      fields: ["customerId"],
    });
  });

  it("reads a local secondary index the same way as a global one", () => {
    const summaries = storageSummaries(
      cloudFormationToSummaries({
        Resources: {
          Orders: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
              LocalSecondaryIndexes: [
                {
                  IndexName: "byStatus",
                  KeySchema: [
                    { AttributeName: "orderId", KeyType: "HASH" },
                    { AttributeName: "status", KeyType: "RANGE" },
                  ],
                },
              ],
            },
          },
        },
      }),
    );

    expect(summaries.map((s) => s.semantics.accessPath)).toEqual([
      null,
      "byStatus",
    ]);
    expect(
      readStorageContractMetadata(summaries[1].summary)?.identifies,
    ).toEqual({ kind: "keyFields", fields: ["orderId", "status"] });
  });

  it("takes the logical id as the container when the template states no TableName", () => {
    const [table] = storageSummaries(
      cloudFormationToSummaries({
        Resources: {
          Sessions: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              KeySchema: [{ AttributeName: "sid", KeyType: "HASH" }],
            },
          },
        },
      }),
    );

    expect(table.semantics.container).toBe("Sessions");
    expect(
      readStorageContractMetadata(table.summary)?.physicalTable,
    ).toBeUndefined();
  });

  it("skips the entries of a template it cannot read and keeps the rest", () => {
    const summaries = storageSummaries(
      cloudFormationToSummaries({
        Resources: {
          Orders: {
            Type: "AWS::DynamoDB::Table",
            Properties: {
              AttributeDefinitions: [
                "orderId",
                { AttributeName: "orderId", AttributeType: "S" },
                { AttributeName: "noType" },
              ],
              KeySchema: [
                "orderId",
                { KeyType: "HASH" },
                { AttributeName: "orderId", KeyType: "HASH" },
              ],
              GlobalSecondaryIndexes: [
                "byCustomer",
                { KeySchema: [] },
                {
                  IndexName: "byCustomer",
                  KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
                },
              ],
            },
          },
        },
      }),
    );

    expect(summaries.map((s) => s.semantics.accessPath)).toEqual([
      null,
      "byCustomer",
    ]);
    expect(readStorageContractMetadata(summaries[0].summary)?.fields).toEqual([
      { name: "orderId", type: "S", primary: true },
    ]);
  });

  it("declares an empty key for a table whose key schema the template leaves out", () => {
    const [table] = storageSummaries(
      cloudFormationToSummaries({
        Resources: {
          Sessions: { Type: "AWS::DynamoDB::Table", Properties: {} },
        },
      }),
    );

    expect(readStorageContractMetadata(table.summary)?.identifies).toEqual({
      kind: "keyFields",
      fields: [],
    });
  });
});
