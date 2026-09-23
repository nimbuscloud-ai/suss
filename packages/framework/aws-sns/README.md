# @suss/framework-aws-sns

Pattern pack for AWS SNS. It reads the publisher side, where a service puts a message on a topic, and records interaction effects that pair with the Lambda a subscription triggers.

## What this package is

`@suss/framework-aws-sns` exports a `PatternPack` built from two `@suss/recognize` declarations, with no walk written by hand:

- **`PublishCommand`**: `client.send(new PublishCommand({ TopicArn, Message }))` becomes one `interaction(class: "message-send")` effect on wire `aws.sns`, with `Message` as the body and `Subject` as the routing key.
- **`PublishBatchCommand`**: the topic is given once, next to `PublishBatchRequestEntries`, and each entry is one message, so one call produces one effect per entry.

The command class has to come from `@aws-sdk/client-sns`, so a class with the same name from another module is ignored. The pack covers only the AWS SDK v3 call pattern. SDK v2, `new AWS.SNS().publish(...).promise()`, is not read yet.

### Why the publisher side was the gap

suss could already see the Lambda a topic triggers. `@suss/contract-cloudformation` turns an `AWS::SNS::Subscription` with `Protocol: lambda`, and a SAM `Events: { Type: SNS }` block, into a consumer summary on the topic's channel. `@suss/framework-aws-lambda` maps an `SNS` event source onto the `aws.sns` wire. Nothing read the publishing side, so a publish came out as a bare `sns.send` call with no boundary and no target. This pack reads that side.

### Channel identity

A topic ARN contains the account and the region, so code usually writes `process.env.ORDER_EVENTS_TOPIC_ARN` instead of the ARN. The pack keeps the env var name, so the publish records the channel `{ORDER_EVENTS_TOPIC_ARN}`. Pairing resolves that name to a CloudFormation logical resource through the publishing Lambda's `Environment` declaration, and that resource is the topic the subscription is on. `@suss/framework-aws-sqs` relies on the same chain for `QueueUrl`.

`TargetArn` is the same destination under another name, so a publish that sets either one records which topic it reached. A `PhoneNumber` publish goes to a handset that nothing subscribes to, so it records the send with no channel.

An ARN written out in full is recorded as the whole string. The CloudFormation reader cuts an ARN down to the resource segment, so a publish to a literal ARN does not pair with a topic in the same template, and comes out as `messageBusProducerOrphan`. `@suss/framework-aws-sqs` treats a literal `QueueUrl` the same way, and cutting both down to the resource name should happen in one shared place.

### What a subscriber contributes

Nothing yet. The consumer's channel comes from the template, and its body arrives as `record.Sns.Message`, which no recognizer reads. So suss does not compare a publisher's `Message` against what the subscriber destructures. `@suss/framework-aws-sqs` makes that comparison with a walk over `JSON.parse(record.body)` written by hand. For SNS the same check belongs in a declaration, so there is no second walk.

### Publishing through your own wrapper

A service that publishes through a wrapper of its own never writes `PublishCommand`, so this pack matches nothing in it. SQS and EventBridge accept a dependency stub for that case, under `system: aws.sqs` and `system: aws.events`. SNS does not yet. The recognizer behind those two already exists in two copies, and the next step is to extract it into a shared one before adding a third.

## Where it fits in suss

The pack depends only on `@suss/recognize`, which compiles the declarations into the recognizer hooks the adapters call. It does not use `ts-morph`, because the declarations reach the syntax tree through the adapter's own vocabulary.

A consumer-side handler gets its topic boundary binding from the pass in `@suss/contract-cloudformation` that walks CloudFormation and SAM SNS subscriptions.

## Coverage

![coverage](../../../.github/badges/coverage-aws-sns.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
