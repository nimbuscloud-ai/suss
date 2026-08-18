import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { isImportedFrom, ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { dynamoFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { DynamoPackOptions } from "./index.js";

function effectsIn(source: string, options: DynamoPackOptions = {}): Effect[] {
  const project = createTestProject();
  const sourceFile: SourceFile = project.createSourceFile("/dao.ts", source);
  const store = new ResolutionStore();
  const recognizers = dynamoFramework(options).invocationRecognizers ?? [];
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
      storageSystem: "aws.dynamodb",
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

  it("reads the default a class ships when the caller passes no table", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export class MappingsDao {
        private readonly tableName: string;
        constructor(tableName?: string) {
          const stage = process.env.STAGE || "staging";
          this.tableName = tableName || \`\${stage}-mappings-v2\`;
        }
        async get(id: string) {
          return client.send(new GetCommand({
            TableName: this.tableName,
            Key: { id },
          }));
        }
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe(
      "{stage}-mappings-v2",
    );
  });

  it("reads a default written with the nullish operator the same way", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export class MappingsDao {
        private readonly tableName: string;
        constructor(tableName?: string) {
          this.tableName = tableName ?? "mappings-v2";
        }
        async get(id: string) {
          return client.send(new GetCommand({
            TableName: this.tableName,
            Key: { id },
          }));
        }
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("mappings-v2");
  });

  it("says which constructor argument the table name comes from", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export class SubscribersRepository {
        constructor(private readonly tableName: string) {}
        async get(id: string) {
          return client.send(new GetCommand({
            TableName: this.tableName,
            Key: { id },
          }));
        }
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("{tableName}");
  });

  it("reads a table name joined with a plus the same way as a template", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export class MappingsDao {
        private readonly tableName: string;
        constructor(prefix: string) {
          this.tableName = prefix + "-mappings-v2";
        }
        async get(id: string) {
          return client.send(new GetCommand({
            TableName: this.tableName,
            Key: { id },
          }));
        }
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe(
      "{prefix}-mappings-v2",
    );
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

  it("says which value a table name it cannot settle comes from", () => {
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

    expect(storageOf(effects[0]).semantics.container).toBe("{table}");
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

/**
 * A project that signs and posts the request itself. The helper takes
 * the operation third and the request fourth, which is what the config
 * has to say for the pack to read either.
 */
const SIGNED_REQUEST: DynamoPackOptions = {
  requestFunctions: [
    {
      name: "sendRequest",
      operationArg: 2,
      requestArg: 3,
      operations: { Query: "read", GetItem: "read", PutItem: "write" },
    },
  ],
};

const CLIENT_IMPORT = `import { signer, sendRequest } from "@acme/dynamo-http";`;

describe("a project's own request function", () => {
  it("reads the table, the index, the fields and the selector", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function byCustomer(customerId: string) {
        return sendRequest(env, signer, "Query", {
          TableName: "orders-v1",
          IndexName: "byCustomer",
          KeyConditionExpression: "customerId = :c",
          ProjectionExpression: "orderId, total",
          ExpressionAttributeValues: { ":c": { S: customerId } },
        });
      }
    `,
      SIGNED_REQUEST,
    );

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "aws.dynamodb",
      container: "orders-v1",
      accessPath: "byCustomer",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "Query",
      fields: ["orderId", "total"],
      selector: ["customerId"],
    });
  });

  it("looks a projected attribute up through the alias the call declares", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function open(customerId: string) {
        return sendRequest(env, signer, "Query", {
          TableName: "orders-v1",
          KeyConditionExpression: "#c = :c",
          ProjectionExpression: "orderId, #s",
          ExpressionAttributeNames: { "#c": "customerId", "#s": "status" },
          ExpressionAttributeValues: { ":c": { S: customerId } },
        });
      }
    `,
      SIGNED_REQUEST,
    );

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["orderId", "status"],
      selector: ["customerId"],
    });
  });

  it("takes an operation the config calls a write as one", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function place(orderId: string, total: number) {
        return sendRequest(env, signer, "PutItem", {
          TableName: "orders-v1",
          Item: { orderId: { S: orderId }, total: { N: String(total) } },
        });
      }
    `,
      SIGNED_REQUEST,
    );

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "PutItem",
      fields: ["orderId", "total"],
    });
  });

  it("follows a table name the code keeps in deploy-time config", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: env.ORDERS_TABLE,
          Key: { orderId: { S: id } },
        });
      }
    `,
      SIGNED_REQUEST,
    );

    expect(storageOf(effects[0]).semantics.container).toBe("{ORDERS_TABLE}");
  });

  it("follows a request built into a const a few lines up", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        const request = {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        };
        return sendRequest(env, signer, "GetItem", request);
      }
    `,
      SIGNED_REQUEST,
    );

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      selector: ["orderId"],
    });
  });

  it("leaves a call that stops short of the request alone", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one() {
        return sendRequest(env, signer, "GetItem");
      }
    `,
      SIGNED_REQUEST,
    );

    expect(effects).toEqual([]);
  });

  it("leaves an operation the config does not list alone", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function drop(id: string) {
        return sendRequest(env, signer, "DeleteItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      SIGNED_REQUEST,
    );

    expect(effects).toEqual([]);
  });

  it("reads the function the configured module declares", () => {
    const effects = effectsIn(
      `
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      {
        requestFunctions: [
          {
            ...(SIGNED_REQUEST.requestFunctions ?? [])[0],
            module: "@acme/dynamo-http",
          },
        ],
      },
    );

    expect(storageOf(effects[0]).semantics.container).toBe("orders-v1");
  });

  it("leaves a function of the same name from somewhere else alone", () => {
    const effects = effectsIn(
      `
      import { signer, sendRequest } from "./ourOwnClient";
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      {
        requestFunctions: [
          {
            ...(SIGNED_REQUEST.requestFunctions ?? [])[0],
            module: "@acme/dynamo-http",
          },
        ],
      },
    );

    expect(effects).toEqual([]);
  });

  it("reads nothing from the same call when the pack was given no config", () => {
    const effects = effectsIn(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `);

    expect(effects).toEqual([]);
  });
});

describe("the pack a project configures", () => {
  it("gates on the SDK's own modules and on nothing else by default", () => {
    expect(dynamoFramework().requiresImport).toEqual([
      "@aws-sdk/lib-dynamodb",
      "@aws-sdk/client-dynamodb",
    ]);
    expect(dynamoFramework().invocationRecognizers).toHaveLength(1);
  });

  it("admits the modules a configured function reaches the call site through", () => {
    const pack = dynamoFramework({
      ...SIGNED_REQUEST,
      requiresImport: ["aws4fetch"],
    });

    expect(pack.requiresImport).toContain("aws4fetch");
    expect(pack.invocationRecognizers).toHaveLength(2);
  });

  it("refuses an entry with no function to read", () => {
    expect(() =>
      dynamoFramework({
        requestFunctions: [
          { operationArg: 2, requestArg: 3, operations: {} } as never,
        ],
      }),
    ).toThrow(/function/);
  });

  it("refuses an entry that does not say which argument the operation is", () => {
    expect(() =>
      dynamoFramework({
        requestFunctions: [
          {
            name: "sendRequest",
            requestArg: 3,
            operations: { Query: "read" },
          } as never,
        ],
      }),
    ).toThrow(/operationArg/);
  });

  it("refuses an entry that lists no operations", () => {
    expect(() =>
      dynamoFramework({
        requestFunctions: [
          {
            name: "sendRequest",
            operationArg: 2,
            requestArg: 3,
            operations: {},
          },
        ],
      }),
    ).toThrow(/operations/);
  });

  it("refuses an entry that does not say which argument the request is", () => {
    expect(() =>
      dynamoFramework({
        requestFunctions: [
          {
            name: "sendRequest",
            operationArg: 2,
            operations: { Query: "read" },
          } as never,
        ],
      }),
    ).toThrow(/requestArg/);
  });

  it("refuses an entry whose operations say something other than read or write", () => {
    expect(() =>
      dynamoFramework({
        requestFunctions: [
          {
            name: "sendRequest",
            operationArg: 2,
            requestArg: 3,
            operations: { Query: "fetch" },
          } as never,
        ],
      }),
    ).toThrow(/Query/);
  });
});

describe("a query that hides its attributes behind aliases", () => {
  it("reads the projection through the names the call declares", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function feed(tenantId: string) {
        return client.send(new QueryCommand({
          TableName: "ledger-v2",
          IndexName: "by-tenant-v2",
          KeyConditionExpression: "#pub = :pub",
          ProjectionExpression: "#pid, #status, headline",
          ExpressionAttributeNames: {
            "#pub": "tenant_id",
            "#pid": "receipt_id",
            "#status": "status",
          },
          ExpressionAttributeValues: { ":pub": tenantId },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      fields: ["receipt_id", "status", "headline"],
    });
    expect(storageOf(effects[0]).semantics).toMatchObject({
      container: "ledger-v2",
      accessPath: "by-tenant-v2",
    });
  });
});
