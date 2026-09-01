# @suss/framework-aws-dynamodb

Says which DynamoDB tables a TypeScript service reads and writes, and what it touches on each one.

## What this package is

A pattern pack. It recognizes the command a call was handed, `client.send(new GetCommand({ ... }))`, and reads the command for everything else: which table, which index, whether the call reads or writes, and which attributes it states. A project that signs and posts the request itself declares its own helper in config, and the same reading runs from there.

```ts
import { dynamoFramework } from "@suss/framework-aws-dynamodb";

const pack = dynamoFramework();
```

The command class is what it matches on, so the client can be the document client or the raw one, and the pack only fires when the class comes from `@aws-sdk/lib-dynamodb` or `@aws-sdk/client-dynamodb`. A class of the same name from somewhere else is left alone.

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

Two hops reach the name from that `send`. The command was built into a local, so the pack asks what the local was written as, and the table name is a field, so it asks what the constructor set. What comes back is a template literal, and the container becomes `{stage}-orders-v1`: the fixed text with the deploy-time part as a hole. A template declaring `TableName: !Sub '${StageName}-orders-v1'` records the same shape, and the two pair on the fixed text.

A name the pack cannot settle comes out null, and null pairs with nothing rather than with whatever spells the same way.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| `TableName` | the container |
| `IndexName` | the access path, since a query through an index keys on that index's fields |
| `Key` | the selector, the attributes that pick one item |
| `KeyConditionExpression` | the selector for a query, the attributes it filters on |
| `Item` | the fields a write touches |
| `ProjectionExpression` | the fields a read asks for, with `#alias` names resolved through `ExpressionAttributeNames` |
| `RequestItems` | one effect per table, for a batch or a transaction |

A read that states no projection reads whatever the item has, which is recorded as `*`, the same wildcard a Prisma call with no `select` uses. A DynamoDB table's contract declares its key attributes and nothing else, so the checker never calls an attribute unknown here. What it can say is which declared key nothing reads.

## Why two of the links are code

The pack is a declaration in `@suss/recognize`, so most of what it knows is data: the command table, where the table name is, where the index is, where a batch lists the tables it touched. Two links are functions the pack wrote itself, and pack health prints them on every run.

Both are the same reason. `ProjectionExpression` and `KeyConditionExpression` are a little language of DynamoDB's own, with `ExpressionAttributeNames` beside them as the table an aliased name is looked up in. Reading one is a parse, and no arrangement of picks over arguments and properties expresses a parse. The pack is handed the request object and gives back which attributes the call touched, which keeps the parse out of the adapter and lets the same declaration run on another language's adapter once one implements the ops.

A parser that covered `FilterExpression` and the update expressions as well would replace both of these with one, and it is worth having the day those matter. Neither is read today.

## A project that signs the request itself

An edge service often skips the SDK and signs the HTTP request with
something small, so there is no command class to match on. Nothing at
the call site says DynamoDB; the helper's body does:

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

The pack asks for the project's own helpers to be read before anything
is extracted, over every file containing `DynamoDB_20120810.`, the
prefix DynamoDB's wire protocol puts in front of every operation. The
parameter that reaches that header is the operation and the one posted
as the body is the request, so `sendRequest` above reads as operation at
argument 2 and request at argument 3. The call sites are matched with
the arguments they were written with, and the table, the index, the
fields and the selector come out the way they do for a command class.

What each operation does to the table (`Query` reads, `PutItem` writes)
is DynamoDB's own, so it lives in the pack. An operation DynamoDB does
not have is one the pack reads nothing from.

One option is left, `requiresImport`: it lists modules whose presence,
directly or through a file the project imports, makes a file worth
reading. Reach for it when the call sites are in files importing neither
the SDK nor anything else that would have them walked. The signing
library the helper itself imports is the usual entry.

## Out of scope for now

- **A filter is not read.** `FilterExpression` narrows what a query returns after DynamoDB has read it, and the attributes it mentions are attributes the call touches. Only the key condition and the projection are read today.
- **AWS SDK v2** (`new AWS.DynamoDB.DocumentClient().get(...)`) has a different call shape.
- **A request helper is matched by name.** The pack knows which file it read the helper out of, and a call site reaches it by a relative path spelled differently at every depth, so there is nothing to match an import against. A same-named function from somewhere else would be read as the helper.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the declaration into the recognizer hooks the adapters call and asks the running adapter everything about a call site. The storage pass in `@suss/checker` pairs what this emits against whatever declares the table, which is `@suss/contract-cloudformation` for a template that declares one.
