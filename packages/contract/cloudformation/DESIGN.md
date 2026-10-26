# How the CloudFormation reader records what a template wires up

`@suss/contract-cloudformation` turns the deliveries a template declares into the same facts a send in code produces, so the message-bus check can count them. The [README](./README.md) explains what the package is for.

## Deliveries the template makes

Some messages move between resources with no code involved. The reader gives each such delivery a summary with a `message-send` effect on the channel the messages arrive at, bound the way the aws-sqs and aws-sns packs bind a send in code, and marks it with `metadata.messageBus.wiring`.

| Wiring | Declared by | Takes messages off | Delivers to |
|---|---|---|---|
| `redrive` | a queue's `RedrivePolicy.deadLetterTargetArn` | nothing | the dead-letter queue |
| `deadLetter` | the `DeadLetterConfig` of a rule target, a schedule, a pipe's stream source, or a SAM EventBridgeRule or schedule event; a subscription's `RedrivePolicy`; a function's `DeadLetterQueue` or `DeadLetterConfig`; an `OnFailure` destination on a mapping or a SAM stream event | nothing | the queue or topic |
| `destination` | a function's `EventInvokeConfig`, in SAM or as an `AWS::Lambda::EventInvokeConfig` | nothing | the queue or topic, or the bus with detail-type `Lambda Function Invocation Result - Success` or `- Failure` and source `lambda` |
| `ruleTarget` | a rule target that is not a function | the rule's channel | a queue or topic, another bus with the same detail-type, or nothing suss reads, such as a state machine |
| `subscription` | an SNS subscription with protocol `sqs` | the topic | the queue |
| `notification` | an S3 QueueConfiguration or TopicConfiguration | the bucket | the queue or topic |
| `pipe` | an `AWS::Pipes::Pipe` | its source, when that is a queue | its queue or topic target, or a bus with the `DetailType` and `Source` the pipe sets |
| `schedule` | an `AWS::Scheduler::Schedule` | nothing | its queue or topic target, or a bus with the detail-type it sets |
| `alarm` | an alarm's `AlarmActions`, `OKActions` or `InsufficientDataActions` | nothing | each topic |

A wire that takes nothing off a channel has kind `library` and no binding. One that does is a `consumer` bound to that channel, so the channel has a receiver. A delivery to a resource the template does not declare is left out, because an ARN written out could point anywhere.

The reader does not read Step Functions state machines or API Gateway service integrations, so a queue or a topic that only one of those sends to still has no producer in the run.

## A rule's pattern

Every summary built from an EventBridge rule records the pattern's literal `source` and `detail-type` lists in `metadata.messageBus.eventPattern`. A rule that lists two detail-types has a summary for each, and each one's pattern lists only its own detail-type. A field written as anything but a list of strings, such as a prefix filter or a `!Ref` to a parameter, goes in `unsettled`. A source starting with `aws.` sets `emittedByAws`, because only AWS services send those. The checker reads these to decide which sends reach the rule.

## Lines

Each summary's `location` is the line its resource is written on, read from the template file. A summary built from a template in memory has line 1.
