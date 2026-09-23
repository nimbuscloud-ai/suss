# @suss/framework-aws-dynamodb

This pack records which DynamoDB tables a TypeScript service reads and writes, and what it touches in each one.

## What this package is

A pattern pack. It matches the command a call was given, `client.send(new GetCommand({ ... }))`, and reads everything else from the command: which table, which index, whether the call reads or writes, and which attributes it lists. A project that signs and posts the request itself declares its own helper in config, and the same reading runs from there.

```ts
import { dynamoFramework } from "@suss/framework-aws-dynamodb";

const pack = dynamoFramework();
```

The pack matches on the command class, so the client can be the document client or the raw one. It only fires when the class comes from `@aws-sdk/lib-dynamodb` or `@aws-sdk/client-dynamodb`, and ignores a class with the same name from another module.

## The table a call addresses

A data access class rarely writes the table name at the call site:

```ts
export class OrdersDao {
  private readonly tableName: string;
  constructor(stage: string) {
    this.tableName = `${stage}-orders-v1`;
  }
  async find(id: string) {
    const command = new GetCommand({ TableName: this.tableName, Key: { orderId: id } });
    return this.docClient.send(command);
  }
}
```

It takes two hops to get from that `send` to the name. The command was built into a local variable, so the pack looks up what the local was set to. The table name is a field, so it looks up what the constructor set. The result is a template literal, and the container becomes `{stage}-orders-v1`: the fixed text, with the part set at deploy time as a hole. A template that declares `TableName: !Sub '${StageName}-orders-v1'` records the same pattern, and the two pair on the fixed text.

When the pack cannot settle a name, it records null. A null name does not pair with anything, even a table spelled the same way.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| `TableName` | the container |
| `IndexName` | the access path, since a query through an index keys on that index's fields |
| `Key` | the selector, the attributes that pick one item |
| `KeyConditionExpression` | the selector for a query, the attributes it filters on |
| `Item` | the fields a write touches |
| `UpdateExpression` | the fields an update writes, read out of its SET, REMOVE, ADD and DELETE clauses, with `#alias` names resolved through `ExpressionAttributeNames` |
| `ProjectionExpression` | the fields a read asks for, with `#alias` names resolved through `ExpressionAttributeNames` |
| `RequestItems` | one effect per table, for a batch or a transaction |

A read with no projection reads whatever the item has. That is recorded as `*`, the same wildcard a Prisma call with no `select` uses. A DynamoDB table's contract declares its key attributes and nothing else, so the checker never reports an attribute as unknown here. It can report a declared key that nothing reads.

## Why three of the links are code

The pack is a declaration in `@suss/recognize`, so most of it is data: the command table, where the table name is, where the index is, and where a batch lists the tables it touched. Three links are functions written in the pack, and pack health prints them on every run.

All three are code for the same reason. `ProjectionExpression`, `KeyConditionExpression` and `UpdateExpression` are written in a small language of DynamoDB's own, with `ExpressionAttributeNames` next to them as the lookup table for aliased names. Reading one takes a parser, and picking out arguments and properties cannot express a parser. The pack receives the request object and returns which attributes the call touched. That keeps the parser out of the adapter, and lets the same declaration run on another language's adapter once that adapter implements the operations.

A parser that also covered `FilterExpression` would be the same parser, and would be useful once filters matter. Filters are not read today.

## A project that signs the request itself

An edge service often skips the SDK and signs the HTTP request with
a small library, so there is no command class to match on. Nothing at
the call site mentions DynamoDB. The helper's body does:

```ts
// the project's own helper
export async function sendRequest(
  region: string,
  signer: Signer,
  operation: string,
  request: object,
): Promise<Response> {
  return signer.fetch(`https://dynamodb.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "X-Amz-Target": `DynamoDB_20120810.${operation}` },
    body: JSON.stringify(request),
  });
}

// the call site
await sendRequest(env.REGION, signer, "Query", {
  TableName: env.ORDERS_TABLE,
  IndexName: "byCustomer",
  KeyConditionExpression: "customerId = :c",
  ProjectionExpression: "orderId, total",
});
```

Before anything is extracted, the pack has suss read the project's own
helpers in every file that contains `DynamoDB_20120810.`, the prefix
DynamoDB's wire protocol puts in front of every operation. The parameter
that ends up in that header is the operation, and the one posted as the
body is the request. So `sendRequest` above is read with the operation
at argument 2 and the request at argument 3. Each call site is matched
with the arguments it was written with, and the table, the index, the
fields and the selector come out the same way they do for a command
class.

What each operation does to the table (`Query` reads, `PutItem` writes)
is defined by DynamoDB, so it lives in the pack. The pack reads nothing
from an operation DynamoDB does not have.

One option remains, `requiresImport`. It lists modules that get a file
read when the file imports them, directly or through a file the project
imports. Use it when the call sites are in files that import
neither the SDK nor anything else that would get them read. The usual
entry is the signing library the helper itself imports.

## Out of scope for now

- **A filter is not read.** `FilterExpression` narrows what a query returns after DynamoDB has read it, and the attributes it mentions are attributes the call touches. The pack reads the key condition, the projection and the update expression, and skips the filter.
- **AWS SDK v2** (`new AWS.DynamoDB.DocumentClient().get(...)`) uses a different call pattern.
- **A request helper is matched by name.** The pack knows which file it read the helper from, but a call site imports it by a relative path that is written differently at every depth, so there is no import to match against. A function with the same name from another module would be read as the helper.

## Where it fits in suss

The pack depends on `@suss/recognize`, which compiles the declaration into the recognizer hooks the adapters call and asks the running adapter everything about a call site. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the table. For a template that declares one, that is `@suss/contract-cloudformation`.
