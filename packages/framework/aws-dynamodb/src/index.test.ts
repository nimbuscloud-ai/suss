import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { dynamoFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { DynamoPackOptions } from "./index.js";

// A project configures this pack, so the pack under test is built per
// call rather than once.
const effectsIn = (source: string, options: DynamoPackOptions = {}): Effect[] =>
  packUnderTest(dynamoFramework(options)).effectsIn(source);

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

  it("reads the attribute a SET clause assigns", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function rename(id: string, name: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "SET customerName = :name",
          ExpressionAttributeValues: { ":name": name },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["customerName"],
      selector: ["orderId"],
    });
  });

  it("reads the attributes a REMOVE clause drops", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function forget(id: string) {
        return client.send(new UpdateCommand({
          TableName: "profiles-v1",
          Key: { accountId: id },
          UpdateExpression: "remove email, phone, address",
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["email", "phone", "address"],
      selector: ["accountId"],
    });
  });

  it("reads the attribute an ADD clause increments", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function bump(id: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "ADD count :one",
          ExpressionAttributeValues: { ":one": 1 },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["count"],
    });
  });

  it("reads the attribute a DELETE clause takes a value out of", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function untag(id: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "DELETE tags :t",
          ExpressionAttributeValues: { ":t": ["urgent"] },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      fields: ["tags"],
    });
  });

  it("looks a written attribute up through the alias the call declares", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function rename(id: string, name: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "SET #n = :name",
          ExpressionAttributeNames: { "#n": "customerName" },
          ExpressionAttributeValues: { ":name": name },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["customerName"],
    });
  });

  it("touches the top-level attribute of a nested path and of an indexed one", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function update(id: string, city: string, first: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "SET address.city = :city, items[0] = :first",
          ExpressionAttributeValues: { ":city": city, ":first": first },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["address", "items"],
    });
  });

  it("still touches the attribute an if_not_exists default targets", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function seed(id: string, total: number) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "SET total = if_not_exists(total, :zero) + :total",
          ExpressionAttributeValues: { ":zero": 0, ":total": total },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["total"],
    });
  });

  it("leaves an alias out of the fields when nothing says which attribute it is", () => {
    const effects = effectsIn(`
      import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
      declare const client: DynamoDBDocumentClient;
      export async function rename(id: string, name: string) {
        return client.send(new UpdateCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
          UpdateExpression: "SET #n = :name, status = :s",
          ExpressionAttributeValues: { ":name": name, ":s": "active" },
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["status"],
    });
  });

  it("reads the same attributes off the raw client's UpdateItemCommand", () => {
    const effects = effectsIn(`
      import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
      declare const client: DynamoDBClient;
      export async function forget(id: string) {
        return client.send(new UpdateItemCommand({
          TableName: "profiles-v1",
          Key: { accountId: { S: id } },
          UpdateExpression: "REMOVE email, phone",
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "UpdateItemCommand",
      fields: ["email", "phone"],
      selector: ["accountId"],
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
 * A project that signs and posts the request itself. Nothing at the
 * call site says DynamoDB; the helper's body does, and which parameter
 * is which comes from where each one ends up.
 */
const SIGNING_HELPER = `
  interface Signer { fetch(url: string, init: unknown): Promise<Response>; }
  export declare const signer: Signer;
  export async function sendRequest(
    region: string,
    signer: Signer,
    operation: string,
    request: object,
  ): Promise<Response> {
    return signer.fetch(\`https://dynamodb.\${region}.amazonaws.com/\`, {
      method: "POST",
      headers: { "X-Amz-Target": \`DynamoDB_20120810.\${operation}\` },
      body: JSON.stringify(request),
    });
  }
`;

const CLIENT_IMPORT = `import { signer, sendRequest } from "./signed";`;

/** The call site, with the project's own helper beside it. */
const calling = (source: string, helper = SIGNING_HELPER): Effect[] =>
  packUnderTest(dynamoFramework()).effectsAcross(
    { "/signed.ts": helper, "/repo.ts": source },
    "/repo.ts",
  );

describe("a project's own request function", () => {
  it("reads the table, the index, the fields and the selector", () => {
    const effects = calling(`
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
    `);

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
    const effects = calling(`
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
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      fields: ["orderId", "status"],
      selector: ["customerId"],
    });
  });

  it("takes an operation the wire writes with as a write", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function place(orderId: string, total: number) {
        return sendRequest(env, signer, "PutItem", {
          TableName: "orders-v1",
          Item: { orderId: { S: orderId }, total: { N: String(total) } },
        });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "PutItem",
      fields: ["orderId", "total"],
    });
  });

  it("reads the attributes an UpdateExpression writes through the wire", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function rename(orderId: string, name: string) {
        return sendRequest(env, signer, "UpdateItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: orderId } },
          UpdateExpression: "SET customerName = :name",
          ExpressionAttributeValues: { ":name": { S: name } },
        });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "UpdateItem",
      fields: ["customerName"],
      selector: ["orderId"],
    });
  });

  it("follows a table name the code keeps in deploy-time config", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: env.ORDERS_TABLE,
          Key: { orderId: { S: id } },
        });
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("{ORDERS_TABLE}");
  });

  it("follows a request built into a const a few lines up", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one(id: string) {
        const request = {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        };
        return sendRequest(env, signer, "GetItem", request);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      selector: ["orderId"],
    });
  });

  it("leaves a call that stops short of the request alone", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function one() {
        return sendRequest(env, signer, "GetItem");
      }
    `);

    expect(effects).toEqual([]);
  });

  it("leaves an operation DynamoDB does not have alone", () => {
    const effects = calling(`
      ${CLIENT_IMPORT}
      declare const env: { ORDERS_TABLE: string };
      export async function drop(id: string) {
        return sendRequest(env, signer, "Frobnicate", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `);

    expect(effects).toEqual([]);
  });

  it("reads nothing when the helper posts somewhere that is not DynamoDB", () => {
    const effects = calling(
      `
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      SIGNING_HELPER.replace("DynamoDB_20120810.", "SomeOtherService."),
    );

    expect(effects).toEqual([]);
  });

  it("reads nothing when the helper sets no headers on the request", () => {
    const effects = calling(
      `
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      `
        export declare const signer: { fetch(url: string, init: unknown): Promise<Response> };
        export async function sendRequest(
          region: string,
          signer: { fetch(url: string, init: unknown): Promise<Response> },
          operation: string,
          request: object,
        ): Promise<Response> {
          const target = \`DynamoDB_20120810.\${operation}\`;
          return signer.fetch(region + target, { body: JSON.stringify(request) });
        }
      `,
    );

    expect(effects).toEqual([]);
  });

  it("reads nothing when the target header is not text it can read", () => {
    const effects = calling(
      `
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      `
        export declare const signer: { fetch(url: string, init: unknown): Promise<Response> };
        export async function sendRequest(
          region: string,
          signer: { fetch(url: string, init: unknown): Promise<Response> },
          operation: string,
          request: object,
        ): Promise<Response> {
          // DynamoDB_20120810. is written here and nowhere the request goes.
          return signer.fetch(region, {
            headers: { "X-Amz-Target": operation },
            body: JSON.stringify(request),
          });
        }
      `,
    );

    expect(effects).toEqual([]);
  });

  it("reads nothing when the helper posts no body", () => {
    const effects = calling(
      `
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      `
        export declare const signer: { fetch(url: string, init: unknown): Promise<Response> };
        export async function sendRequest(
          region: string,
          signer: { fetch(url: string, init: unknown): Promise<Response> },
          operation: string,
          request: object,
        ): Promise<Response> {
          return signer.fetch(region, {
            headers: { "X-Amz-Target": \`DynamoDB_20120810.\${operation}\` },
          });
        }
      `,
    );

    expect(effects).toEqual([]);
  });

  it("reads nothing when the operation is not one of the parameters", () => {
    const effects = calling(
      `
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest(env, signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: { S: id } },
        });
      }
    `,
      SIGNING_HELPER.replace(`$${"{operation}"}`, "GetItem"),
    );

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

  it("admits the modules a helper reaches the call site through", () => {
    const pack = dynamoFramework({ requiresImport: ["aws4fetch"] });

    expect(pack.requiresImport).toContain("aws4fetch");
    expect(pack.invocationRecognizers).toHaveLength(1);
  });

  it("asks for the project's own helpers to be read", () => {
    expect(dynamoFramework().projectHelpers?.find).toEqual({
      by: "text",
      contains: ["DynamoDB_20120810."],
    });
  });

  it("prices what it declared: the two rules over DynamoDB's own strings", () => {
    expect(dynamoFramework().declarations?.declarations).toEqual([
      {
        name: "aws.dynamodb",
        dataLinks: 6,
        functionLinks: ["selector", "fields"],
        astLinks: [],
        example:
          'client.send(new GetCommand({ TableName: "orders-v1", Key: { orderId: "a" } }))',
      },
    ]);
  });

  it("emits the effect its example says it does", () => {
    const ran = runExamples(dynamoFramework(), (code) =>
      effectsIn(`
        ${IMPORTS}
        declare const client: DynamoDBDocumentClient;
        export async function example() {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(1);
    const { semantics, interaction } = storageOf(ran[0].effects[0]);
    expect(semantics.container).toBe("orders-v1");
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "GetCommand",
      selector: ["orderId"],
    });
  });

  it("says the same thing about a request function as about a command", () => {
    const command = calling(`
      ${IMPORTS}
      declare const client: DynamoDBDocumentClient;
      export async function one(id: string) {
        return client.send(new GetCommand({
          TableName: "orders-v1",
          Key: { orderId: id },
        }));
      }
    `);
    const signed = calling(`
      ${CLIENT_IMPORT}
      export async function one(id: string) {
        return sendRequest("us-east-1", signer, "GetItem", {
          TableName: "orders-v1",
          Key: { orderId: id },
        });
      }
    `);

    expect(storageOf(signed[0]).semantics).toEqual(
      storageOf(command[0]).semantics,
    );
    expect(storageOf(signed[0]).interaction).toMatchObject({
      kind: "read",
      selector: ["orderId"],
    });
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
