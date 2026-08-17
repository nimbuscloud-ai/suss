# @suss/framework-aws-dynamodb

Says which DynamoDB tables a TypeScript service reads and writes, and what it touches on each one.

## What this package is

A pattern pack. It recognizes `client.send(command)` and reads the command for everything else: which table, which index, whether the call reads or writes, and which attributes it states. A project that signs and posts the request itself declares its own helper in config, and the same reading runs from there.

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

## A project that signs the request itself

An edge service often skips the SDK and signs the HTTP request with
something small, so there is no command class to match on. The body it
posts is the same object the command takes, so the pack reads it the
same way once the project says which of its functions does the posting:

```ts
// the project's own helper
export function sendRequest(env: Env, signer: Signer, operation: string, body: object): Promise<Response>;

// the call site
await sendRequest(env, signer, "Query", {
  TableName: env.ORDERS_TABLE,
  IndexName: "byCustomer",
  KeyConditionExpression: "customerId = :c",
  ProjectionExpression: "orderId, total",
});
```

```ts
const pack = dynamoFramework({
  requestFunctions: [
    {
      name: "sendRequest",
      operationArg: 2,
      requestArg: 3,
      operations: { Query: "read", GetItem: "read", PutItem: "write" },
    },
  ],
  requiresImport: ["aws4fetch"],
});
```

The same object as JSON goes to `-f aws-dynamodb=packs/dynamodb.json`.

`operations` is where the read-or-write decision comes from, since the
operation is a string here rather than a class the pack knows. An
operation left out of it is one the pack reads nothing from.

Add `module` to an entry when every call site imports the helper by the
same specifier, and a function of that name from anywhere else is left
alone. Relative imports spell the same module differently at different
depths, so leave `module` out there. `requiresImport` is what admits
those files instead: it lists modules whose presence, directly or
through a file the project imports, makes a file worth reading, and the
signing library the helper imports is one.

## Out of scope for now

- **A filter is not read.** `FilterExpression` narrows what a query returns after DynamoDB has read it, and the attributes it mentions are attributes the call touches. Only the key condition and the projection are read today.
- **AWS SDK v2** (`new AWS.DynamoDB.DocumentClient().get(...)`) has a different call shape.
- **A request function whose call sites import it by different relative paths** is matched by name alone, so a same-named function inside those same files would be read too.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the import check and for asking what a name was written as. The storage pass in `@suss/checker` pairs what this emits against whatever declares the table, which is `@suss/contract-cloudformation` for a template that declares one.
