# @suss/framework-aws-sqs

Pattern pack for AWS SQS. It reads the producer side, where a service sends a message, and the consumer side, where a handler parses one out of the batch. It records an interaction effect on each side, and the two pair with each other.

## What this package is

`@suss/framework-aws-sqs` exports a `PatternPack` built from a `@suss/recognize` declaration and two function recognizers:

- **Sends**: `client.send(new SendMessageCommand({ QueueUrl, MessageBody }))`, and the batch form `SendMessageBatchCommand`, where each entry in `Entries` is one message and the queue is given once next to the list. Each message becomes an `interaction(class: "message-send")` effect on wire `aws_sqs`, with `MessageBody` as the body. The command class has to come from `@aws-sdk/client-sqs`, so a class with the same name from another module is ignored.
- **Receives**: `JSON.parse(record.body)` inside a `for (const record of event.Records)` loop, which becomes an `interaction(class: "message-receive")` effect.

The pack covers only the AWS SDK v3 call pattern. SDK v2, `new AWS.SQS().sendMessage(...).promise()`, is not read yet.

### What a consumer contributes

The receive effect leaves its channel empty. An SQS handler's signature never says which queue it drains, because the CloudFormation event source mapping declares that. The pairing layer joins the effect to the consumer binding of the summary around it, by code scope.

suss records the body's fields only when the parse result is destructured:

```ts
const { id, totalAmount } = JSON.parse(record.body);
```

It records the properties the binding reads, since the producer chose those names, and ignores the local aliases. For any other pattern, such as a cast or an assignment to a plain variable, it does not record any fields, and suss skips comparing the body instead of guessing.

### Channel identity

On the producer side, the pack reads the env var name out of `QueueUrl`, so `process.env.ORDERS_QUEUE_URL` records `ORDERS_QUEUE_URL`. When pairing against a CloudFormation provider summary, suss resolves that name to a logical resource through the producing Lambda's `Environment` declaration, and that resource is the queue.

A file is only read if it imports one of these: `@aws-sdk/client-sqs` for producer files, `aws-lambda` for consumer files (the `SQSEvent` type comes from there), or any module a configured dispatcher is declared in.

## Telling it about your own dispatcher

A service that sends through a dispatcher of its own never writes `SendMessageCommand`, so the declaration never fires on it. The project declares which dispatcher does the sending in a dependency stub under `suss/stubs/`.

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

With that stub, `dispatcher.dispatch("order.placed", order, { queueUrl })` is read as a send on channel `order.placed`, the same subject the consumer expects, so the two pair. When the subject is not a literal string in the source, the pack does not record the send, because a guessed channel would pair a producer with the wrong consumer.

The stub's `package` is the module that declares the receiver's type, and the pack also reads files that import that module. In the `spec`:

- `receiver`: the type name of the receiver, as that module exports it.
- `method`: the method that performs the send.
- `subjectArg`: which argument position the subject is in.
- `bodyArg`: which argument is the message body. Leave it out when the method does not take a single body argument, such as a batch method that takes a list of entries. No body is reported then.

The `producers` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## Where it fits in suss

The pack depends on `@suss/recognize`, which compiles the send declarations into the recognizer hooks the adapters call. It also uses `@suss/behavioral-ir` for the message-bus binding, `@suss/adapter-typescript` for the configured-call reader, and `@suss/extractor` for the `PatternPack` type. `ts-morph` is a peer dependency.

A consumer-side handler gets its queue boundary binding from the pass in `@suss/contract-cloudformation` that walks CloudFormation and SAM `Events: { Type: SQS }` event source mappings.

## Coverage

![coverage](../../../.github/badges/coverage-aws-sqs.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
