# A pack declares that a call sends a message

Status: draft, seeking alignment. Nothing implemented.

`@suss/recognize` has two endings. `storageAccess` works out what a call
reached from the call itself. `sqlAccess` works it out by reading the
statement the call was handed, so one call yields one effect per table.

Both endings describe access to a store. A call that sends a message
fits neither, so aws-sqs and aws-eventbridge are hand-rolled walks of
about five hundred lines each. They are the two largest invocation
recognizers left, and apart from an ending they need nothing new from
the toolkit.

## What the two packs read

Both read the same pattern. The AWS SDK v3 puts the operation in a
command class and the arguments in one object:

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

So a pack has to declare four things: the command class, the property
of its input that gives the channel, the property that contains the
body, and whether one call sends one message or many.

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
   * Where the messages are. The command input is one message, or a
   * property of it contains many, and which of the two is a property of
   * the command rather than a setting on it.
   */
  readonly messages: OneMessage | ManyIn;
  /** What a reader gives back for a channel nothing in the source settles. */
  readonly unsettledName: "nothing" | "reference";
}
```

The two libraries differ in `ChannelRule`, and that part of the design
still has to be decided. SQS states one queue:

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
message-bus boundary stops being adapter code. That matters for the
other adapters, because a Python or Ruby pack that sends on a queue has
no way to declare it today.

**Does not settle.** SQS's channel is usually `process.env.ORDERS_QUEUE_URL`,
so what pairs with a provider is the env var's name, since the source
states no URL. The hand-rolled pack already reads it that way. That
question belongs to the symbolic-reference direction, and this proposal
leaves it there. Until it is decided, `unsettledName: "reference"` keeps
the pack's current behaviour.

**Decided.** When a library puts an intermediate collection between the
call and the messages, its declaration states that. When it does not,
the declaration states that the input is the message:

```ts
// SendMessageCommand: the input is the message.
messages: { each: "theInput" }

// SendMessageBatchCommand and PutEventsCommand: a property contains them.
messages: { each: "in", property: "Entries" }
```

So SQS writes two declarations and EventBridge writes one, because SQS's
two commands have two different shapes. Making the fan-out an optional
field on one declaration would hide that difference behind a setting.

## Why this one first

The remaining hand-rolled packs fall into three groups, and only this
group needs nothing beyond the ending:

| | Lines | What it needs |
|---|---|---|
| Invocation recognizers (aws-sqs, aws-eventbridge, node scheduling) | about 1300 | this ending |
| Access recognizers (node envVars and processSurface, cloudflare envBindings) | about 1050 | a match that starts somewhere other than a call receiver |
| Discovery (aws-lambda, cloudflare, react) | about 940 | [`declared-boundary-binding.md`](./declared-boundary-binding.md) |

`MatchStart` has only `FromReceiver`, so a pack cannot declare
`process.env.X` at all. That needs its own proposal.
