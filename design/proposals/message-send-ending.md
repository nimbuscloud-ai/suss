# A pack says a call sends a message

Status: draft, seeking alignment. Nothing implemented.

`@suss/recognize` has two endings. `storageAccess` settles what a call
reached by asking the call. `sqlAccess` settles it by reading the
statement the call was handed, so one call yields one effect per table.

Both are about a store. A pack whose call sends a message fits neither,
so aws-sqs and aws-eventbridge are hand-rolled walks of about five
hundred lines each. They are the largest pair of invocation recognizers
left, and nothing else about them needs the toolkit to grow.

## What the two packs read

Both read the same shape. The AWS SDK v3 puts the operation in a command
class and the arguments in one object:

```ts
await client.send(new SendMessageCommand({
  QueueUrl: process.env.ORDERS_QUEUE_URL,
  MessageBody: JSON.stringify(order),
}));

await client.send(new PutEventsCommand({
  Entries: [
    { EventBusName: "orders", DetailType: "OrderPlaced", Detail: JSON.stringify(order) },
  ],
}));
```

So the pieces are: which command class, which property of its input names
the channel, which property carries the body, and whether one call sends
one message or many.

## The ending

```ts
export interface MessageSendEnding {
  readonly yields: "messageSend";
  /** The wire, in the words the IR's message-bus semantics use. */
  readonly wire: MessageBusSemantics["messageBus"];
  /** Where the command's input states the channel. */
  readonly channel: ChannelRule;
  /** Where the body is, when the pack can say. */
  readonly body?: InputRule;
  /**
   * The property whose elements are each their own message. Unset means
   * the call sends one. `sqlAccess` fans out the same way, by reading
   * what the call was handed rather than asking the call.
   */
  readonly eachIn?: InputRule;
  /** What a reader gives back for a channel nothing in the source settles. */
  readonly unsettledName: "nothing" | "reference";
}
```

`ChannelRule` is where the two libraries differ and where the design has
to be decided. SQS states one queue:

```ts
channel: { from: "property", name: "QueueUrl" }
```

EventBridge states a bus and a subject on it, and a missing bus means the
one called `default`:

```ts
channel: {
  from: "parts",
  parts: [
    { name: "EventBusName", whenAbsent: "default" },
    { name: "DetailType" },
  ],
}
```

## What this settles and what it does not

**Settles.** aws-sqs and aws-eventbridge become declarations. The
message-bus boundary stops being adapter code, which matters for the
other adapters: a Python or Ruby pack that sends on a queue cannot say so today.

**Does not settle.** SQS's channel is usually `process.env.ORDERS_QUEUE_URL`,
so what pairs with a provider is the env var's name rather than a URL
the source states. That reading exists in the hand-rolled pack
and belongs to the symbolic-reference direction rather than here. Until
it is decided, `unsettledName: "reference"` keeps the behaviour the pack
has.

The batch forms differ in a way worth checking before building.
EventBridge always fans out, since `Entries` is required. SQS has a
single command and a batch command, so one pack states two declarations
rather than one with an optional `eachIn`. If that turns out to read
worse than a single declaration, `eachIn` is the wrong shape.

## Why this one first

The remaining hand-rolled packs split three ways, and only this third
needs nothing new beyond the ending:

| | Lines | What it needs |
|---|---|---|
| Invocation recognizers (aws-sqs, aws-eventbridge, node scheduling) | about 1300 | this ending |
| Access recognizers (node envVars and processSurface, cloudflare envBindings) | about 1050 | a match that starts somewhere other than a call receiver |
| Discovery (aws-lambda, cloudflare, react) | about 940 | [`declared-boundary-binding.md`](./declared-boundary-binding.md) |

`MatchStart` is `FromReceiver` and nothing else, so `process.env.X`
cannot be stated at all. That is its own proposal.
