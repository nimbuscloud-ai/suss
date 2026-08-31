# @suss/framework-aws-sqs

Pattern pack for AWS SQS. It reads the producer side, where a service sends a message, and the consumer side, where a handler parses one off the batch, and emits interaction effects that pair with each other.

## What this package is

`@suss/framework-aws-sqs` returns a `PatternPack` built from a `@suss/recognize` declaration plus two function recognizers:

- **Sends**: `client.send(new SendMessageCommand({ QueueUrl, MessageBody }))`, and the batch form `SendMessageBatchCommand`, where each entry in `Entries` is one message and the queue is stated once beside the list. Each message becomes an `interaction(class: "message-send")` effect on wire `aws_sqs`, with `MessageBody` as the body. The command class has to come from `@aws-sdk/client-sqs`, so a class of the same name from somewhere else is left alone.
- **Receives**: `JSON.parse(record.body)` inside a `for (const record of event.Records)` loop, which becomes an `interaction(class: "message-receive")` effect.

Only the AWS SDK v3 call shape is covered. SDK v2, `new AWS.SQS().sendMessage(...).promise()`, is a follow-up.

### What a consumer contributes

The receive effect leaves its channel empty. An SQS handler's signature never says which queue it drains, since the CloudFormation event source mapping declares that, and the pairing layer joins the effect to the enclosing summary's consumer binding by code scope instead.

The body field set comes out only when the parse result is destructured:

```ts
const { id, totalAmount } = JSON.parse(record.body);
```

What gets recorded are the properties the binding reads, not the local aliases, since the producer chose those. Any other shape (a cast, an assignment to a plain variable) does not record a field set, and the body-shape pairing is skipped rather than guessed at.

### Channel identity

The producer side reads the env var name out of `QueueUrl`, so `process.env.ORDERS_QUEUE_URL` records `ORDERS_QUEUE_URL`. Pairing against a CloudFormation provider summary resolves that name to a logical resource through the producing Lambda's `Environment` declaration, and that resource is the queue.

A file is admitted by an import gate on `@aws-sdk/client-sqs` for producer files, `aws-lambda` for consumer files (the `SQSEvent` type comes from there), and every module a configured dispatcher is declared in.

## Telling it about your own dispatcher

A service that sends through a dispatcher of its own does not write a `SendMessageCommand`, so the declaration never fires on it. Such a project says which dispatcher does the sending, in a dependency stub under `suss/stubs/`.

```yaml
# suss/stubs/acme-async.yaml
package: "@acme/async"
statements:
  - kind: performs-call
    system: aws.sqs
    spec:
      receiver: CommandDispatcher
      method: dispatch
      subjectArg: 0
      bodyArg: 1
```

That reads `dispatcher.dispatch("order.placed", order, { queueUrl })` as a send on channel `order.placed`, the same subject the consumer expects, so the two pair. The pack emits nothing when the subject is not a literal string in the source, because a guessed channel would pair a producer with the wrong consumer.

The stub's `package` is the module that declares the receiver's type, and it widens the pack's import gate to that module. In the `spec`:

- `receiver`: the type name of the receiver, as that module exports it.
- `method`: the method that performs the send.
- `subjectArg`: which argument position the subject is in.
- `bodyArg`: which argument the message body is. Leave it out when the method does not take a single body argument, as a batch method taking a list of entries does, and then no body is reported.

The `producers` pack option said the same thing until 0.21.0 removed it. A config file setting it now stops the run and points here.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the send declarations into the recognizer hooks the adapters call, `@suss/behavioral-ir` for the message-bus binding, `@suss/adapter-typescript` for the configured-call reader, and `@suss/extractor` for the `PatternPack` type. `ts-morph` is a peer dependency.

Consumer-side handlers get their queue boundary binding from the pass that walks CloudFormation and SAM `Events: { Type: SQS }` event source mappings, which lives in `@suss/contract-cloudformation`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-sqs.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
