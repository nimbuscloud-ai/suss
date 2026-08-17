import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { isImportedFrom, ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { dynamoFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

function effectsIn(source: string): Effect[] {
  const project = createTestProject();
  const sourceFile: SourceFile = project.createSourceFile("/dao.ts", source);
  const store = new ResolutionStore();
  const recognizers = dynamoFramework().invocationRecognizers ?? [];
  const effects: Effect[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: () => [],
      isImportedFrom,
      resolveWrittenValue: (value: Node) => store.resolveWrittenValue(value),
    };
    for (const recognizer of recognizers) {
      const emitted = recognizer(node, ctx);
      if (emitted !== null) {
        effects.push(...emitted);
      }
    }
  });
  return effects;
}

function storageOf(effect: Effect) {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return { semantics, interaction: effect.interaction };
}

const IMPORTS = `import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";`;

describe("a DynamoDB command", () => {
  it("reads a table a call names outright", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function getOrder(id: string) {
        return client.send(new GetCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
        }));
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "dynamodb",
      container: "orders-v1",
      accessPath: null,
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "GetCommand",
      selector: ["orderId"],
    });
  });

  it("follows a table name through the field a constructor set, as a pattern", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export class OrdersDao {
        private readonly tableName: string;
        constructor(stage: string) {
          this.tableName = \`\${stage}-orders-v1\`;
        }
        async find(id: string) {
          const command = new GetCommand({
            TableName: this.tableName,
            Key: { orderId: id },
          });
          return client.send(command);
        }
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0]).semantics.container).toBe("{stage}-orders-v1");
  });

  it("takes the index a query goes through as its own way in", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function byCustomer(customerId: string) {
        return client.send(new QueryCommand({
          TableName: "orders-v1",
          IndexName: "byCustomer",
          KeyConditionExpression: "customerId = :c",
        }));
      }
    `);

    expect(storageOf(effects[0]).semantics).toMatchObject({
      container: "orders-v1",
      accessPath: "byCustomer",
    });
  });

  it("reads the attributes a write states as the item it puts", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function place(order: { id: string; total: number }) {
        return client.send(new PutCommand({
          TableName: "orders-v1",
          Item: { orderId: order.id, total: order.total },
        }));
      }
    `);

    const { interaction } = storageOf(effects[0]);
    expect(interaction).toMatchObject({
      kind: "write",
      fields: ["orderId", "total"],
    });
  });

  it("reads a projection as the attributes it asks for", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function summary(id: string) {
        return client.send(new GetCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          ProjectionExpression: "orderId, total",
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["orderId", "total"],
    });
  });

  it("reads a call with no projection as a read of the whole item", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function whole(id: string) {
        return client.send(new GetCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ fields: ["*"] });
  });

  it("reads the attributes a query keys on out of its key condition", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function recent(customerId: string, since: string) {
        return client.send(new QueryCommand({
          TableName: "orders-v1",
          IndexName: "byCustomer",
          KeyConditionExpression: "customerId = :c AND placedAt > :since",
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["customerId", "placedAt"],
    });
  });

  it("looks an aliased attribute up, since a reserved word has to be written as one", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function byStatus(status: string) {
        return client.send(new QueryCommand({
          TableName: "orders-v1",
          KeyConditionExpression: "#s = :status",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":status": status },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["status"],
    });
  });

  it("reads the attributes a begins_with condition keys on", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function underPrefix(pk: string, prefix: string) {
        return client.send(new QueryCommand({
          TableName: "orders-v1",
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["pk", "sk"],
    });
  });

  it("gives a batch write one effect per table in its request map", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function writeBoth(orderId: string) {
        return client.send(new BatchWriteCommand({
          RequestItems: {
            "orders-v1": [{ PutRequest: { Item: { orderId, total: 1 } } }],
            "audit-v1": [{ PutRequest: { Item: { orderId, at: "now" } } }],
          },
        }));
      }
    `);

    expect(effects).toHaveLength(2);
    expect(effects.map((e) => storageOf(e).semantics.container)).toEqual([
      "orders-v1",
      "audit-v1",
    ]);
    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["orderId", "total"],
    });
  });

  it("follows a computed table name in a request map the same way", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export class OrdersDao {
        private readonly tableName: string;
        constructor(stage: string) {
          this.tableName = \`\${stage}-orders-v1\`;
        }
        async readMany(ids: string[]) {
          return client.send(new BatchGetCommand({
            RequestItems: {
              [this.tableName]: { Keys: [{ orderId: "a" }] },
            },
          }));
        }
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("{stage}-orders-v1");
    expect(interaction).toMatchObject({ kind: "read", fields: ["orderId"] });
  });

  it("states no container for a table name it cannot settle", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function get(table: string, id: string) {
        return client.send(new GetCommand({
          TableName: table,
          Key: { orderId: id },
        }));
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBeNull();
  });

  it("leaves a command class of the same name from somewhere else alone", () => {
    const effects = effectsIn(`
      import { GetCommand } from "./ourOwnCommands";
      declare const client: { send(command: unknown): Promise<unknown> };
      export async function get(id: string) {
        return client.send(new GetCommand({ TableName: "orders-v1" }));
      }
    `);

    expect(effects).toEqual([]);
  });

  it("leaves a send of something that is not a command alone", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function send(payload: unknown) {
        return client.send(payload);
      }
    `);

    expect(effects).toEqual([]);
  });
});
