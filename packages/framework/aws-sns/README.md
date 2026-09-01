# @suss/framework-aws-sns

Pattern pack for AWS SNS. It reads the publisher side, where a service puts a message on a topic, and emits interaction effects that pair with the Lambda a subscription triggers.

## What this package is

`@suss/framework-aws-sns` returns a `PatternPack` built from two `@suss/recognize` declarations and no hand-written walk:

- **`PublishCommand`**: `client.send(new PublishCommand({ TopicArn, Message }))` becomes one `interaction(class: "message-send")` effect on wire `aws.sns`, with `Message` as the body and `Subject` as the routing key.
- **`PublishBatchCommand`**: the topic is stated once beside `PublishBatchRequestEntries`, and each entry is one message, so one call yields one effect per entry.

The command class has to come from `@aws-sdk/client-sns`, so a class of the same name from somewhere else is left alone. Only the AWS SDK v3 call shape is covered; SDK v2, `new AWS.SNS().publish(...).promise()`, is a follow-up.

### Why the publisher side was the gap

suss could already see a Lambda a topic triggers. `@suss/contract-cloudformation` turns an `AWS::SNS::Subscription` with `Protocol: lambda`, and a SAM `Events: { Type: SNS }` block, into a consumer summary on the topic's channel, and `@suss/framework-aws-lambda` maps an `SNS` event source onto the `aws.sns` wire. Nothing read the other half, so a publish came out as a bare `sns.send` invocation with no boundary and no target. This pack is that other half.

### Channel identity

A topic ARN contains the account and the region, so code writes `process.env.ORDER_EVENTS_TOPIC_ARN` rather than the ARN itself. The reader keeps the env var name, so the publish records channel `{ORDER_EVENTS_TOPIC_ARN}`. Pairing resolves that name to a CloudFormation logical resource through the publishing Lambda's `Environment` declaration, and that resource is the topic the subscription is on. It is the same chain collapse `@suss/framework-aws-sqs` relies on for `QueueUrl`.

`TargetArn` is the same destination under another name, so a publish that writes either one says which topic it reached. A `PhoneNumber` publish reaches a handset that nothing subscribes to, so it records the send with no channel rather than claiming one.

An ARN written out in full is recorded as the whole string. The CloudFormation reader reduces an ARN to the resource segment, so a publish to a literal ARN does not pair with a topic in the same template and comes out as `messageBusProducerOrphan`. That is the same treatment `@suss/framework-aws-sqs` gives a literal `QueueUrl`, and reducing both to the resource name is a change to make in one place rather than two.

### What a subscriber contributes

Nothing here yet. The consumer's channel comes from the template, and its body arrives as `record.Sns.Message`, which no recognizer reads, so a publisher's `Message` shape is not compared against what the subscriber destructures. `@suss/framework-aws-sqs` does that comparison with a hand-written walk over `JSON.parse(record.body)`; the same shape for SNS belongs in a declaration rather than in a second walk.

### Publishing through your own wrapper

A service that publishes through a wrapper of its own writes no `PublishCommand`, so nothing here fires on it. SQS and EventBridge take a dependency stub for that case, under `system: aws.sqs` and `system: aws.events`. SNS does not yet: the recognizer behind those two is written twice already, and a third copy is the point to extract it instead.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the declarations into the recognizer hooks the adapters call. Nothing else, and no `ts-morph`: the declarations reach the syntax tree through the adapter's own vocabulary.

Consumer-side handlers get their topic boundary binding from the pass that walks CloudFormation and SAM SNS subscriptions, which lives in `@suss/contract-cloudformation`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-sns.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
