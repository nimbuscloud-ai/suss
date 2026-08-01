# Message-bus boundary identity (design proposal)

A queue is a boundary. Publishers send to it, subscribers receive from it, and the template is the only authority on who is on it. An EventBridge subject is a boundary too, with publishers on one side and rules receiving on the other. A rule sits on both: it receives a subject and sends into each queue it targets, which is what a relay is.

A handler's declared subject is not participation in any of that. It is a contract on the function's input, and it gets checked against the wiring rather than paired across a boundary.

## Why this exists

A shared subject fans out. Five Lambdas subscribe to one subject and five handlers answer it, so the pair list carries twenty-five combinations. Sixteen of the twenty other lines on a four-subject service have the same shape.

An earlier change modelled the deployable unit each summary runs in, stamped it from the aws-lambda pack and the CloudFormation contract reader, and required the two sides of a pair to name the same one. That collapsed the fan-out, but it was wrong for every binding kind other than message-bus, and it worked by adding a condition on top of a key rather than by fixing what the key names. It shipped with the field stamped and the condition removed. This proposal is the change that uses the field.

## What the two sides are saying

Run the fan-out fixture end to end and one subject gives four pairs:

```
bus:sqs order.placed  OrderIndexerFunction.handler  <-> OrderIndexerFunction.Orders
bus:sqs order.placed  OrderIndexerFunction.handler  <-> OrderNotifierFunction.Orders
bus:sqs order.placed  OrderNotifierFunction.handler <-> OrderIndexerFunction.Orders
bus:sqs order.placed  OrderNotifierFunction.handler <-> OrderNotifierFunction.Orders
```

Neither side of any of those four lines is a publisher, and the two sides are not two descriptions of one thing either. They are different kinds of statement.

`OrderIndexerFunction.handler` comes from the code. `createEventHandler({ expected: "order.placed" })` says this function accepts messages shaped like `order.placed`. It says nothing about a subscription existing, because code has no way to know what is wired to it.

`OrderIndexerFunction.Orders` comes from the template. It says function `OrderIndexerFunction` is attached to queue `OrderIndexerQueue`, and a rule routes `order.placed` into that queue.

Joining a contract to a wiring statement is a conformance check, and its key is the function, because the function is what both statements are about. Keying it on the subject is what produced the cross lines: `OrderIndexerFunction`'s code got joined to `OrderNotifierFunction`'s wiring, which is not a statement about anything.

The pack turned an expectation into a claim of participation by emitting a message-bus boundary binding from the code side. That is where the confusion started, and it is what comes out.

## The model

**A queue is a boundary.** Publishers send to it, subscribers receive from it. Its key is the queue's CFN logical id, `bus:sqs <QueueLogicalId>`. An event source mapping ties one queue to one function, so a subscriber is identified by the queue with nothing else needed.

**An EventBridge subject is a boundary.** Its key stays `(bus, detailType)`, because one bus multiplexes many subjects and a rule subscribes to a subset.

**A rule is a participant on both.** It receives `${bus}#${detailType}` and sends into each of its target queues.

**Infrastructure is a participant, not something to see through.** A publisher pairs with the queue it sends to, and does not reach past it to the functions behind it. Fan-out stops being something a reader infers by counting lines on a shared subject and becomes a fact stated on the queue: this queue has three subscribers. Every pair stays two-sided.

**A handler's declared subject is a contract on its input.** It is checked against the wiring on the function, not paired.

## What the queue's own summary should be

Today a queue gets a `library` summary that sits on the provider side of its own key, so it pairs with its declared consumer and produces `OrdersQueue <-> OrderConsumer.FromOrders`. Under this model that line is the queue paired against itself, and once a code handler also keys on the queue the same bucket yields a second pair for one delivery.

So the queue's summary stops being a participant and becomes the boundary's declaration: the queue exists, here is what is known about it (FIFO or not, the subjects routed into it, how many subscribers it has). Pairs on that boundary are publisher to subscriber and nothing else. Orphan and unused are read off the declaration by asking how many participants it has on each side, which is what those checks are already asking, rather than by pairing something against the boundary itself.

## The missing fact

One line of the CloudFormation contract reader is standing in for a fact no summary carries. `buildLambdaConsumerSummary` rewrites a consumer's channel to `${bus}#${detailType}` when exactly one EventBridge subject routes into its queue. That rewrite is what puts two distinct queues on one key, and it is doing two jobs:

1. **Publisher pairing.** An EventBridge publisher already pairs with the rule's own provider summary on `default#order.placed`, so this job is covered without the rewrite.
2. **Orphan and unused suppression.** A consumer moved to `OrderIndexerQueue` has nothing publishing to it and reads as an orphan, and `default#order.placed` loses the participant that kept it off `messageBusUnused`.

Both false reports come from the same gap: the edge from a rule to the queue it feeds is not represented. Model the relay and both go away. One summary per rule, a consumer of `${bus}#${detailType}` carrying a `message-send` effect into each target queue, puts a participant on each boundary and leaves nothing propping anything up.

## The conformance check, and a finding we do not produce today

Separately from pairing: for each function the template wires to a queue, compare the subjects the queue carries against the subjects the function's code says it accepts. The join key is the function, which is `identity.deployableUnit.instanceName`, the field the earlier change landed.

A handler declaring it accepts `order.placed`, wired to a queue that carries `order.cancelled`, is invisible today. Both sides key on the subject the code named, so the mismatch fails to pair and surfaces as an orphan, which reads as missing infrastructure rather than as the wiring error it is. That deserves its own finding kind. It is the sort of thing this tool exists to catch, and the model above is what makes it expressible.

## What each side can know alone

The declared side knows everything: the queue, the function, and the rules.

The code side, alone, knows only what it accepts. That is all it should be saying.

The aws-lambda pack is not the code side alone. It discovers units by reading the SAM template in the first place, and the function's SQS event names the queue, so it can attribute a handler to its queue. What blocks it is that `ServerlessNonHttpEvent` in `@suss/manifest-aws` parses the event and keeps only `{ eventId, eventType }`, dropping the queue. Carrying the queue logical id there is the small contained piece that unblocks the rest.

## What the counts do

On the fan-out fixture the pair list goes from seven to two, and both survivors are two-sided publisher-to-subscriber lines on a queue.

Today's seven are four cross-multiplied lines on the shared subject plus one queue-against-its-consumer line for each of the three queues no rule feeds. Under the model, the two rule-fed queues each have the rule publishing and one function subscribing, so one pair each. The other three queues have a subscriber and nothing publishing, so no pair and a consumer-orphan finding, which is what they already report. The two handlers leave the pair list and become conformance checks against their wiring.

Publishers arrive today as `message-send` effects on a transition rather than as summaries, so the implementation has to settle whether the pair list reads effects directly or a publisher gets a summary of its own. The participant counts are the same either way.

## Scope

- `@suss/manifest-aws`: carry the queue logical id on an SQS `ServerlessNonHttpEvent`.
- aws-lambda pack: stop emitting a message-bus boundary binding for a declared subject, and emit the accepted-subject contract instead. This changes an asserted behavior and its test.
- `@suss/contract-cloudformation`: drop the routed-subject channel rewrite, emit the rule relay summary, and turn the queue summary into a boundary declaration.
- `@suss/checker`: orphan and unused read off the boundary declaration; the code-receiver category goes away with the code-side binding; the conformance check and its finding kind are new.

## Verification

Fixture-only. `fixtures/aws-lambda` already carries two Lambdas on one subject behind two queues fed by one rule, which is the case this turns on. Add a rule targeting a Lambda directly, a queue carrying several routed subjects, and a handler whose declared subject does not match what its queue carries, so both branches of the old rewrite and the new finding each have a fixture.

A measurement against a wide multi-Lambda SAM service is what would confirm the counts move the way this predicts and that findings do not move with them. That measurement is not reproducible from this repository, and the repo owner will run it when the implementation is up for review.
