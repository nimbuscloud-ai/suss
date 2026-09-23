# @suss/framework-aws-eventbridge

Pattern pack for AWS EventBridge. It reads the producer side, where a service publishes an event, and records one `interaction(class: "message-send")` effect per `PutEvents` entry.

## What this package is

`@suss/framework-aws-eventbridge` exports a `PatternPack` built from a `@suss/recognize` declaration:

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

Each entry in `Entries` is one send on wire `eventbridge`. `Detail` is the body. `Source` is recorded as the routing key for anyone reading the summary, since it scopes an event on the bus, but pairing does not use it today. The command has to be constructed from `@aws-sdk/client-eventbridge`, so a `PutEventsCommand` from another module is ignored. The pack covers only the AWS SDK v3 call pattern. SDK v2, `new AWS.EventBridge().putEvents(...).promise()`, is not read yet.

### Channel identity

Many event types share one event bus, and a rule subscribes to some of them by `DetailType`. So the channel is made of both parts:

```
channel = `${bus}#${detailType}`
```

The bus name is nearly always set at deploy time, so the code writes `process.env.ORDER_EVENT_BUS_NAME`. The declaration keeps that reference, which gives `{ORDER_EVENT_BUS_NAME}#OrderPlaced`. The message-bus checker resolves the reference to the CloudFormation `EventBus` logical id through the producing Lambda's `Environment` block. If the code never gives a bus, the event goes to the account's default bus. If the `DetailType` is decided at run time, the channel is null, because a channel with only half its parts would pair across buses.

When the `DetailType` is built from a value typed as a few strings, the pack records a send to each of them. `` `record.${event.operation.toLowerCase()}` `` with `operation: "INSERT" | "UPDATE" | "DELETE"` records three sends, on `record.insert`, `record.update` and `record.delete`. A string enum is read the same way. Past 16 channels for one entry, the send is recorded once, with a hole where the value goes.

### The consumer side

This pack has no consumer-side recognizer yet. A target Lambda gets its message-bus boundary binding from the pass in `@suss/contract-cloudformation` that walks CloudFormation and SAM `AWS::Events::Rule` resources and `Events: { Type: EventBridgeRule | Schedule }` blocks. An EventBridge target handler reads `event.detail`, and a message-receive recognizer for that has not been written yet. Until it is, suss cannot compare message bodies for EventBridge. The orphan, unused, unresolvable and schedule checks all still work from the CloudFormation summaries.

## Telling it about your own publisher

A service that publishes through a publisher of its own never writes `PutEventsCommand`, so the declaration never fires on it. The project declares which publisher does the publishing in a dependency stub under `suss/stubs/`.

```yaml
# suss/stubs/acme-async.yaml
package: "@acme/async"
statements:
  - kind: performs-call
    system: aws.events
    spec:
      receiver: EventPublisher
      method: emit
      subjectArg: 0
      bodyArg: 1
```

With that stub, `publisher.emit("user.deleted", data, opts)` is read as a send on channel `user.deleted`, with no bus part. A publisher takes its bus from constructor config that the call site never shows, and the checker treats a missing bus as matching any bus, so the subject alone pairs with the rule that routes it. When the subject is not a literal string in the source, the pack does not record the send.

The stub's `package` is the module that declares the receiver's type, and the pack also reads files that import that module. In the `spec`:

- `receiver`: the type name of the receiver, as that module exports it.
- `method`: the method that performs the send.
- `subjectArg`: which argument position the subject is in.
- `bodyArg`: which argument is the message body. Leave it out when the method does not take a single body argument, such as a batch method that takes a list of entries. No body is reported then.

The `producers` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## Where it fits in suss

The pack depends on `@suss/recognize`, which compiles the send declaration into the recognizer hooks the adapters call. It also uses `@suss/behavioral-ir` for the message-bus binding, `@suss/adapter-typescript` for the configured-call reader, and `@suss/extractor` for the `PatternPack` type. `ts-morph` is a peer dependency.

## Coverage

![coverage](../../../.github/badges/coverage-aws-eventbridge.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
