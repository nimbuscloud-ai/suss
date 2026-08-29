# @suss/framework-aws-eventbridge

Pattern pack for AWS EventBridge. It reads the producer side, where a service publishes an event, and emits one `interaction(class: "message-send")` effect per `PutEvents` entry.

## What this package is

`@suss/framework-aws-eventbridge` returns a `PatternPack` built from a `@suss/recognize` declaration:

```ts
await client.send(new PutEventsCommand({
  Entries: [{
    EventBusName: process.env.ORDER_EVENT_BUS_NAME,
    Source: "orders.service",
    DetailType: "OrderPlaced",
    Detail: JSON.stringify(order),
  }],
}));
```

Each entry in `Entries` is one send on wire `eventbridge`. `Detail` is the body, and `Source` rides along as the routing key for a reader, since it scopes an event on the bus without keying the pairing today. The command has to be constructed from `@aws-sdk/client-eventbridge`, so a `PutEventsCommand` from somewhere else is left alone. Only the AWS SDK v3 call shape is covered; SDK v2, `new AWS.EventBridge().putEvents(...).promise()`, is a follow-up.

### Channel identity

One event bus multiplexes many event types, and a rule subscribes to a subset of them keyed by `DetailType`, so the channel is both parts:

```
channel = `${bus}#${detailType}`
```

The bus is nearly always deploy-named, so the code writes `process.env.ORDER_EVENT_BUS_NAME` and the declaration keeps the reference, giving `{ORDER_EVENT_BUS_NAME}#OrderPlaced`. The message-bus checker resolves that reference to the CloudFormation `EventBus` logical id through the producing Lambda's `Environment` block. A bus written nowhere at all is the account's default bus. A `DetailType` decided at run time leaves the channel null, because a channel spelled by half of itself would pair across buses.

### The consumer side

There is no consumer-side recognizer here yet. A target Lambda gets its message-bus boundary binding from the pass that walks CloudFormation and SAM `AWS::Events::Rule` resources and `Events: { Type: EventBridgeRule | Schedule }` blocks, which lives in `@suss/contract-cloudformation`. An EventBridge target handler reads `event.detail`, and a message-receive recognizer for that shape is a follow-up. Until then body-shape pairing is unavailable for EventBridge, while the orphan, unused, unresolvable, and schedule accounting all work off the CloudFormation summaries.

## Options

A service that publishes through its own publisher does not write a `PutEventsCommand`, so the declaration never fires on it. Such a project says which publisher does the publishing.

```json
{
  "producers": [
    {
      "module": "@acme/async",
      "receiver": "EventPublisher",
      "method": "emit",
      "subjectArg": 0,
      "bodyArg": 1
    }
  ]
}
```

That reads `publisher.emit("user.deleted", data, opts)` as a send on channel `user.deleted`, with no bus segment. A publisher takes its bus from constructor config the call site never states, and the checker treats an unstated bus as agreeing with any, so the subject on its own pairs against the rule that routes it. The pack emits nothing when the subject is not a literal string in the source.

- `producers`: publishers this project emits through. Each one adds a recognizer and widens the import gate to that publisher's module.
  - `module`: the module that declares the receiver's type.
  - `receiver`: the type name of the receiver, as that module exports it.
  - `method`: the method that performs the send.
  - `subjectArg`: which argument position the subject is in.
  - `bodyArg`: which argument the message body is. Leave it out when the method does not take a single body argument, as a batch method taking a list of entries does, and then no body is reported.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the send declaration into the recognizer hooks the adapters call, `@suss/behavioral-ir` for the message-bus binding, `@suss/adapter-typescript` for the configured-call reader, and `@suss/extractor` for the `PatternPack` type. `ts-morph` is a peer dependency.

## Coverage

![coverage](../../../.github/badges/coverage-aws-eventbridge.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
