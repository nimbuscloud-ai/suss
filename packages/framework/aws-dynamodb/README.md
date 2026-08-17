# @suss/framework-aws-dynamodb

Says which DynamoDB tables a TypeScript service reads and writes, and what it touches on each one.

## What this package is

A pattern pack. It recognizes `client.send(command)` and reads the command for everything else: which table, which index, whether the call reads or writes, and which attributes it states.

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
| `Item` | the fields a write touches |
| `ProjectionExpression` | the fields a read asks for, with `#alias` names resolved through `ExpressionAttributeNames` |

A read that states no projection reads whatever the item has, which is recorded as `*`, the same wildcard a Prisma call with no `select` uses. A DynamoDB table's contract declares its key attributes and nothing else, so the checker never calls an attribute unknown here. What it can say is which declared key nothing reads.

## Out of scope for now

- **A key condition is read as text.** `KeyConditionExpression` states the attributes a query filters on, and parsing it would let the checker compare them against the index's key fields. The selector today comes from `Key`, which the item-level commands state.
- **Batch and transaction commands put their tables inside the request map.** `BatchWriteCommand` takes `{ RequestItems: { [table]: [...] } }`, so the table is a key rather than a `TableName`, and this does not read a container from one yet.
- **AWS SDK v2** (`new AWS.DynamoDB.DocumentClient().get(...)`) has a different call shape.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the import check and for asking what a name was written as. The storage pass in `@suss/checker` pairs what this emits against whatever declares the table, which is `@suss/contract-cloudformation` for a template that declares one.
