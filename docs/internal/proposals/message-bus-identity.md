# Message-bus boundary identity (design proposal)

A queue is a boundary. Publishers send to it, subscribers receive from it, and the template is the only authority on who is on it. An EventBridge subject is a boundary too, with publishers on one side and rules receiving on the other. A rule sits on both: it receives a subject and sends into each queue it targets, which is what a relay is.

A handler's declared subject is not participation in any of that. It is a contract on the function's input, and it gets compared against what the wiring delivers by the check that already compares a caller against a handler.

## Why this exists

A shared subject fans out. When several Lambdas subscribe to one subject and each has a handler answering it, the pair list carries every combination of handler and subscription, and only the ones naming the same Lambda describe a delivery that can happen. The fan-out fixture in this repo is the smallest version of it: two Lambdas give four lines, and two of the four cannot happen. A service where a dozen functions share a handful of subjects spends most of its pair list this way.

An earlier change modelled the deployable unit each summary runs in, stamped it from the aws-lambda pack and the CloudFormation contract reader, and required the two sides of a pair to name the same one. That collapsed the fan-out, but it was wrong for every binding kind other than message-bus, and it worked by adding a condition on top of a key rather than by fixing what the key names. It shipped with the field stamped and the condition removed. This proposal is the change that uses the field.

## What the two sides are saying

Run the fan-out fixture end to end and one subject gives four pairs:

```
bus:sqs order.placed  OrderIndexerFunction.handler  <-> OrderIndexerFunction.Orders
bus:sqs order.placed  OrderIndexerFunction.handler  <-> OrderNotifierFunction.Orders
bus:sqs order.placed  OrderNotifierFunction.handler <-> OrderIndexerFunction.Orders
bus:sqs order.placed  OrderNotifierFunction.handler <-> OrderNotifierFunction.Orders
```

Neither side of any of those lines is a publisher, and the two sides are not two descriptions of one thing either. They are different kinds of statement about the same function.

`OrderIndexerFunction.handler` comes from the code. `createEventHandler({ expected: "order.placed" })` says this function accepts messages shaped like `order.placed`. It says nothing about a subscription existing, because code has no way to know what is wired to it.

`OrderIndexerFunction.Orders` comes from the template. It says function `OrderIndexerFunction` is attached to queue `OrderIndexerQueue`, and a rule routes `order.placed` into that queue.

Comparing a contract against a wiring statement is keyed on the function, because the function is what both statements are about. Keying it on the subject is what produced the two cross lines, which join one function's code to another function's wiring. Matching on the deployable unit worked because it reached for the function, which is the key the two statements share. Doing that as a condition on top of a subject key hides the fact that the subject was never the right key, and it leaves the code side looking like it claims participation in a boundary when all it can state is what it accepts.

## The model

**A queue is a boundary.** Publishers send to it, subscribers receive from it. Its key is the queue's CFN logical id, `bus:sqs <QueueLogicalId>`. An event source mapping ties one queue to one function, so a subscriber is identified by the queue with nothing else needed.

**An EventBridge subject is a boundary.** Its key stays `(bus, detailType)`, because one bus multiplexes many subjects and a rule subscribes to a subset.

**A rule is a participant on both.** It receives `${bus}#${detailType}` and sends into each of its target queues.

**Infrastructure is a participant, not something to see through.** A publisher pairs with the queue it sends to, and does not reach past it to the functions behind it. Fan-out stops being something a reader infers by counting lines on a shared subject and becomes a fact stated on the queue: this queue has three subscribers. Every pair stays two-sided.

**A handler's declared subject is a contract on its input.** It is compared against what the wiring delivers, not paired as a boundary side.

## What the queue's own summary should be

Today a queue gets a `library` summary that sits on the provider side of its own key, so it pairs with its declared consumer and produces `OrdersQueue <-> OrderConsumer.FromOrders`. Under this model that line is the queue paired against itself, and once a code handler also keys on the queue the same bucket yields a second pair for one delivery.

So the queue's summary stops being a participant and becomes the boundary's declaration: the queue exists, here is what is known about it (FIFO or not, the subjects routed into it, how many subscribers it has, and what each subscriber narrows by). Pairs on that boundary are publisher to subscriber and nothing else. Orphan and unused are read off the declaration by asking how many participants it has on each side, which is what those checks are already asking, rather than by pairing something against the boundary itself.

## The missing fact

One line of the CloudFormation contract reader is standing in for a fact no summary carries. `buildLambdaConsumerSummary` rewrites a consumer's channel to `${bus}#${detailType}` when exactly one EventBridge subject routes into its queue. That rewrite is what puts two distinct queues on one key, and it is doing two jobs:

1. **Publisher pairing.** An EventBridge publisher already pairs with the rule's own provider summary on `default#order.placed`, so this job is covered without the rewrite.
2. **Orphan and unused suppression.** A consumer moved to `OrderIndexerQueue` has nothing publishing to it and reads as an orphan, and `default#order.placed` loses the participant that kept it off `messageBusUnused`.

Both false reports come from the same gap: the edge from a rule to the queue it feeds is not represented. Model the relay and both go away. One summary per rule, a consumer of `${bus}#${detailType}` carrying a `message-send` effect into each target queue, puts a participant on each boundary and leaves nothing propping anything up.

## The check already exists

Comparing what arrives at a handler against what the handler does with it is the check a caller and a handler already get. The wiring gives the input set. The handler's summary already says what it does with each shape, because inputs, transitions and terminals are what it holds. Nothing new is needed on either side once the wiring and the contract stop being the same statement.

What has to change is an exemption, not a pass. `packages/checker/src/index.ts` skips `checkPair` for message-bus pairs today, because a message-bus pair was two things that did not describe opposite sides of anything. Once a pair is a publisher and a subscriber over a queue, and the handler's contract is compared against the input set the wiring delivers, the exemption is what is in the way.

A handler declaring it accepts `order.placed` while wired to a queue carrying `order.cancelled` is invisible today, because both sides key on the subject the code named, so the mismatch fails to pair and reads as an orphan. Separating the wiring from the contract is what makes it visible, through the same comparison every other boundary gets.

## Filters decide the input set

The input set a handler receives is the subject narrowed by its filter, not the subject alone. Many event types land on one bus and handlers subscribe to a subset through filter patterns. We do not read filters at all today. Compute an input set from the subject only and you conclude a handler receives shapes it never sees, and everything built on that is noise. So this is a prerequisite for the check being worth running, not a refinement of it.

**Where the patterns live.**

On the SQS path, `AWS::Lambda::EventSourceMapping` carries `Properties.FilterCriteria.Filters`, a list of `{ Pattern: "<json string>" }`. SAM writes the same thing under a function's `Events: { Type: SQS, Properties: { FilterCriteria: ... } }` and expands it into the mapping. Each pattern is a JSON string in EventBridge pattern syntax, matched against the SQS record envelope rather than the message body, so a subject inside the body is addressed as `{"body": {"subject": ["order.placed"]}}`. Several filters in the list are alternatives.

On the EventBridge path, `AWS::Events::Rule` carries `Properties.EventPattern`, matched against the whole event envelope, and SAM writes it under `Events: { Type: EventBridgeRule, Properties: { Pattern: ... } }`. `reduceEventPattern` reads this one already, but keeps only literal `detail-type` arrays. A rule that routes one detail-type and narrows further on `detail` currently reads as though it routes the whole detail-type, which is the over-wide direction.

A rule target can also carry `InputTransformer` or `InputPath`, which reshape the payload before the target sees it. What the handler receives is then not what crossed the bus, so a shape comparison that ignores them compares the wrong thing.

**What carrying them takes.**

A filter belongs to a subscription, not to a boundary. The queue's declaration says what crosses it; each subscriber carries the predicate it narrows by; the input set for a subscriber is the intersection. That keeps one queue with three differently filtered subscribers expressible, which is the case that motivates the work.

The representation has to go past what `reduceEventPattern` produces today. A pattern is a set of constraints, each a path into the message and a matcher on it, where a matcher is either an exact value set or a content filter (`prefix`, `suffix`, `anything-but`, `numeric`, `cidr`, `exists`, `equals-ignore-case`, wildcard, `$or`). An exact value set narrows to an enumerable set of shapes and can be compared against a publisher's known body shape. A content filter constrains without enumerating, so it can rule a shape out but cannot list what remains.

The SQS envelope wrapping matters too. A pattern addressing `body` is matching against the parsed message body, so mapping it onto the shapes a publisher sends means unwrapping one level that the EventBridge path does not have.

**When a filter cannot be read, say so and stop.** An unreducible pattern must suppress the comparison for that subscriber rather than widen its input set. Widening is the unsafe direction: the report below fires on an input whose every outcome is an error, and a shape the handler never receives would fire it wrongly. `unsupportedSemantics` already exists at info level for the unreducible-rule case, so the vocabulary is there.

## What is worth reporting

Three cases, and they sort themselves.

A handler subscribed to a subset, with other events on the bus never reaching it, gives nothing to report. Those shapes are not in its input set. This is the case that makes filters a prerequisite rather than a refinement: without them every one of those shapes looks like it is in the input set.

A handler that receives a shape and does nothing specific with it is fine. That is a default path. An unrecognized return shape is already recorded as a gap that lowers confidence rather than reported as a fault in the handler, and this is the same situation.

A handler that receives a shape where every path terminates in a throw is the one that looks wrong, and the summary already carries enough to see it, because terminals and outcomes are what it holds.

So the only candidate is: the input is reachable, and every outcome for it is an error. Put it in as reporting. Decide the severity after measuring how often it fires on a production repo. A finding type has already turned out to be a limit on our reading rather than a fault in the code, and guessing wrong in that direction costs more than waiting.

## Does this code determine its own wiring

The reason the code side should not claim message-bus participation is that the code cannot know what is wired to it. That test is about who determines the wiring, not about the protocol, and it sorts the REST path the same way.

An Express route determines its own wiring. `app.get("/users/:id", handler)` is the registration, so a code-side REST binding there states a fact. A Lambda behind API Gateway does not know its own path; the template does. A code-side REST binding minted from the handler would be the same guess this proposal removes from the queue path.

The aws-lambda pack already gets this right for routes and wrong for subjects, in one file. `httpRouteUnits` and `graphqlResolverUnits` take the route and the AppSync field from the template entry. `accountingUnit` takes the subject from the code's factory config and binds a boundary to it. The subject binding is the only place in the tree that mints a code-side message-bus channel, so the conflation has one live instance and the fix is contained.

Worth applying the same test to any pack that binds a boundary from a call the code makes. A publisher passes it: sending is something code decides. A subscriber does not.

## What each side can know alone

The declared side knows everything: the queue, the function, the rules, and the filters.

The code side, alone, knows only what it accepts. That is all it should be saying.

The aws-lambda pack is not the code side alone. It discovers units by reading the SAM template in the first place, and the function's SQS event names the queue, so it can attribute a handler to its queue. What blocks it is that `ServerlessNonHttpEvent` in `@suss/manifest-aws` parses the event and keeps only `{ eventId, eventType }`, dropping both the queue and the filter criteria. Carrying those is the small contained piece that unblocks the rest.

## What the counts do

On the fan-out fixture the pair list goes from seven to two, and both survivors are two-sided publisher-to-subscriber lines on a queue.

Today's seven are four cross-multiplied lines on the shared subject plus one queue-against-its-consumer line for each of the three queues no rule feeds. Under the model, the two rule-fed queues each have the rule publishing and one function subscribing, so one pair each. The other three queues have a subscriber and nothing publishing, so no pair and a consumer-orphan finding, which is what they already report. The two handlers leave the pair list and have their contracts compared against what their wiring delivers.

Publishers arrive today as `message-send` effects on a transition rather than as summaries, so the implementation has to settle whether the pair list reads effects directly or a publisher gets a summary of its own. The participant counts are the same either way.

## Scope

- `@suss/manifest-aws`: carry the queue logical id and the filter criteria on an SQS `ServerlessNonHttpEvent`.
- aws-lambda pack: stop emitting a message-bus boundary binding for a declared subject, and emit the accepted-subject contract instead. This changes an asserted behavior and its test.
- `@suss/contract-cloudformation`: drop the routed-subject channel rewrite, emit the rule relay summary, turn the queue summary into a boundary declaration, and reduce filter patterns into subscriber predicates.
- `@suss/checker`: orphan and unused read off the boundary declaration; the code-receiver category goes away with the code-side binding; the `checkPair` exemption for message-bus pairs comes off; the every-outcome-is-an-error report is added.

## Verification

Fixture-only. `fixtures/aws-lambda` already carries two Lambdas on one subject behind two queues fed by one rule, which is the case this turns on. Add a rule targeting a Lambda directly, a queue carrying several routed subjects, two subscribers on one queue narrowing to different subsets, a filter that cannot be reduced, and a handler whose declared subject does not match what its queue carries.

A measurement against a wide multi-Lambda SAM service is what would confirm the counts move the way this predicts, that findings do not move with them, and how often the every-outcome-is-an-error report fires. That measurement is not reproducible from this repository, and the repo owner will run it when the implementation is up for review.
