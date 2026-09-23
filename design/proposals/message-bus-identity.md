# Message-bus boundary identity (design proposal)

A queue is a boundary. Publishers send to it, subscribers receive from it, and only the template records who is on it. An EventBridge subject is a boundary too, with publishers on one side and rules receiving on the other. A rule is on both sides at once. It receives a subject and sends into each queue it targets, and a rule doing both of those is a relay.

A handler's declared subject does not make the handler a participant in any of that. The subject is a contract on the function's input. The check that already compares a caller against a handler can compare that contract against whatever the wiring delivers.

## Why this exists

A shared subject fans out. When several Lambdas subscribe to one subject and each has a handler for it, the pair list contains every combination of handler and subscription. Only the pairs whose two sides refer to the same Lambda describe a delivery that can actually happen. The fan-out fixture in this repo is the smallest example: two Lambdas give four lines, and two of the four cannot happen. In a service where a dozen functions share a handful of subjects, most of the pair list is these combinations.

An earlier change modelled the deployable unit each summary runs in, stamped it from the aws-lambda pack and the CloudFormation contract reader, and required both sides of a pair to have the same one. That collapsed the fan-out, but it was wrong for every binding kind other than message-bus. It also worked by adding a condition on top of a key, when the fix belonged in what the key identifies. It shipped with the field stamped and the condition removed. This proposal is the change that puts the field to use.

## What the two sides are saying

Run the fan-out fixture end to end and one subject gives four pairs:

```
bus:aws_sqs order.placed  OrderIndexerFunction.handler  <-> OrderIndexerFunction.Orders
bus:aws_sqs order.placed  OrderIndexerFunction.handler  <-> OrderNotifierFunction.Orders
bus:aws_sqs order.placed  OrderNotifierFunction.handler <-> OrderIndexerFunction.Orders
bus:aws_sqs order.placed  OrderNotifierFunction.handler <-> OrderNotifierFunction.Orders
```

Neither side of any of those lines is a publisher. The two sides also do not describe one thing. They are different kinds of statement about the same function.

`OrderIndexerFunction.handler` comes from the code. `makeWidgetHandler({ subject: "order.placed" })` declares that this function accepts messages shaped like `order.placed`. It says nothing about whether a subscription exists, because code cannot see what is wired to it.

`OrderIndexerFunction.Orders` comes from the template. It records that function `OrderIndexerFunction` is attached to queue `OrderIndexerQueue`, and that a rule routes `order.placed` into that queue.

A comparison between a contract and a wiring statement should be keyed on the function, because both statements are about the function. Keying it on the subject produced the two cross lines, which join one function's code to another function's wiring. Matching on the deployable unit worked because it used the function, the key the two statements share. But doing that as a condition on top of a subject key hides the fact that the subject was the wrong key from the start. It also leaves the code side looking as though it claims a place on a boundary, when all it can state is what it accepts.

## The model

**A queue is a boundary.** Publishers send to it, subscribers receive from it. Its key is the queue's CFN logical id, `bus:aws_sqs <QueueLogicalId>`. An event source mapping ties one queue to one function, so the queue alone identifies a subscriber and nothing else is needed.

**An EventBridge subject is a boundary.** Its key stays `(bus, detailType)`, because one bus multiplexes many subjects and a rule subscribes to a subset.

**A rule is a participant on both.** It receives `${bus}#${detailType}` and sends into each of its target queues.

**Infrastructure is a participant, and a publisher does not see through it.** A publisher pairs with the queue it sends to, and does not reach past it to the functions behind it. A reader no longer has to infer fan-out by counting lines on a shared subject. It becomes a fact stated on the queue: this queue has three subscribers. Every pair stays two-sided.

**A handler's declared subject is a contract on its input.** We compare it against what the wiring delivers, instead of pairing it as one side of a boundary.

## What the queue's own summary should be

Today a queue gets a `library` summary on the provider side of its own key. It pairs with its declared consumer and produces `OrdersQueue <-> OrderConsumer.FromOrders`. Under this model that line is the queue paired against itself. Once a code handler also keys on the queue, the same bucket yields a second pair for one delivery.

So the queue's summary stops being a participant and becomes the boundary's declaration: the queue exists, and here is what is known about it (FIFO or not, the subjects routed into it, how many subscribers it has, and what each subscriber narrows by). Pairs on that boundary are publisher to subscriber and nothing else. We read orphan and unused off the declaration by counting how many participants it has on each side. Those checks already ask that question, so nothing needs to pair against the boundary itself.

## The missing fact

One line of the CloudFormation contract reader makes up for a fact no summary states. `buildLambdaConsumerSummary` rewrites a consumer's channel to `${bus}#${detailType}` when exactly one EventBridge subject routes into its queue. That rewrite puts two distinct queues on one key, and it does two jobs:

1. **Publisher pairing.** An EventBridge publisher already pairs with the rule's own provider summary on `default#order.placed`, so this job is covered without the rewrite.
2. **Orphan and unused suppression.** A consumer moved to `OrderIndexerQueue` has nothing publishing to it and looks like an orphan, and `default#order.placed` loses the participant that kept it off `messageBusUnused`.

Both false reports come from the same gap: nothing records the edge from a rule to the queue it feeds. Modelling the relay removes both. One summary per rule, a consumer of `${bus}#${detailType}` with a `message-send` effect into each target queue, puts a participant on each boundary, and nothing is left that needs the rewrite.

## The check already exists

A caller and a handler already get a check that compares what arrives at the handler against what the handler does with it. The wiring gives the input set. The handler's summary already records what it does with each shape, since it contains the inputs, transitions and terminals. Once the wiring and the contract stop being the same statement, neither side needs anything new.

The change is to remove an exemption, and no new pass is needed. `packages/checker/src/index.ts` skips `checkPair` for message-bus pairs today, because a message-bus pair was two things that did not describe opposite sides of anything. Once a pair is a publisher and a subscriber over a queue, and the handler's contract is compared against the input set the wiring delivers, that exemption gets in the way.

Take a handler that declares it accepts `order.placed` while wired to a queue that delivers `order.cancelled`. Today that is invisible. Both sides key on the subject the code wrote, so the mismatch fails to pair and looks like an orphan. Separating the wiring from the contract makes it visible, through the same comparison every other boundary gets.

## Filters decide the input set

The input set a handler receives is the subject narrowed by its filter. Many event types land on one bus, and handlers subscribe to a subset through filter patterns. We do not read filters at all today. An input set computed from the subject alone says a handler receives shapes it never sees, and everything built on that is noise. So reading filters is a prerequisite for the check being useful at all.

**Where the patterns live.**

On the SQS path, `AWS::Lambda::EventSourceMapping` has `Properties.FilterCriteria.Filters`, a list of `{ Pattern: "<json string>" }`. SAM writes the same thing under a function's `Events: { Type: SQS, Properties: { FilterCriteria: ... } }` and expands it into the mapping. Each pattern is a JSON string in EventBridge pattern syntax. It is matched against the SQS record envelope and not the message body, so a subject inside the body is addressed as `{"body": {"subject": ["order.placed"]}}`. Several filters in the list are alternatives.

On the EventBridge path, `AWS::Events::Rule` has `Properties.EventPattern`, matched against the whole event envelope, and SAM writes it under `Events: { Type: EventBridgeRule, Properties: { Pattern: ... } }`. `reduceEventPattern` reads this one already, but keeps only literal `detail-type` arrays. A rule that routes one detail-type and narrows further on `detail` currently looks as though it routes the whole detail-type, which errs on the wide side.

A rule target can also have an `InputTransformer` or an `InputPath`, which reshape the payload before the target sees it. The handler then receives something different from what crossed the bus, so a shape comparison that ignores them compares the wrong thing.

**What it takes to represent them.**

A filter belongs to a subscription, and the boundary does not have one. The queue's declaration records what crosses it, each subscriber states the predicate it narrows by, and the input set for a subscriber is the intersection of the two. That way one queue with three differently filtered subscribers can be expressed, and that case is the reason for the work.

The representation has to go past what `reduceEventPattern` produces today. A pattern is a set of constraints, each one a path into the message and a matcher on it. A matcher is either an exact value set or a content filter (`prefix`, `suffix`, `anything-but`, `numeric`, `cidr`, `exists`, `equals-ignore-case`, wildcard, `$or`). An exact value set narrows to an enumerable set of shapes, which can be compared against a publisher's known body shape. A content filter constrains without enumerating, so it can rule a shape out but cannot list what remains.

The SQS envelope wrapping matters too. A pattern that addresses `body` matches against the parsed message body. Mapping it onto the shapes a publisher sends means unwrapping one level that the EventBridge path does not have.

**When a filter cannot be read, say so and stop.** A pattern we cannot reduce must suppress the comparison for that subscriber instead of widening its input set. Widening is the unsafe direction. The report below fires on an input whose every outcome is an error, and a shape the handler never receives would fire it wrongly. `unsupportedSemantics` already exists at info level for a rule we cannot reduce, so the vocabulary is there.

## What to report

There are three cases, and each one is easy to place.

A handler subscribed to a subset, with other events on the bus never reaching it, gives nothing to report. Those shapes are not in its input set. This case is why filters have to come first: without them, every one of those shapes looks as though it is in the input set.

A handler that receives a shape and does nothing specific with it is fine, because that is a default path. suss already records an unrecognized return shape as a gap that lowers confidence, and does not report it as a fault in the handler. This is the same situation.

A handler that receives a shape where every path terminates in a throw is the one that looks wrong. The summary already contains enough to see it, since it records terminals and outcomes.

So the only candidate is an input that is reachable where every outcome is an error. Add it as reporting, and decide the severity after measuring how often it fires on a production repo. One finding type has already turned out to reflect a limit on what we can read instead of a fault in the code. Guessing wrong in that direction costs more than waiting.

## Does this code determine its own wiring

The code side should not claim a place on a message bus, because the code cannot see what is wired to it. The test is who determines the wiring, whatever the protocol, and it sorts the REST path the same way.

An Express route determines its own wiring. `app.get("/users/:id", handler)` is the registration, so a code-side REST binding there states a fact. A Lambda behind API Gateway cannot see its own path; only the template records it. A code-side REST binding made up from the handler would be the same guess this proposal removes from the queue path.

The aws-lambda pack already gets this right for routes and wrong for subjects, in one file. `httpRouteUnits` and `graphqlResolverUnits` take the route and the AppSync field from the template entry. `accountingUnit` takes the subject from the code's factory config and binds a boundary to it. The subject binding is the only place in the tree that creates a code-side message-bus channel, so the mix-up exists in one place and the fix is contained.

Apply the same test to any pack that binds a boundary from a call the code makes. A publisher passes it, because the code decides when to send. A subscriber does not.

## What each side can know alone

The declared side records everything: the queue, the function, the rules, and the filters.

The code side, alone, can state only what it accepts, and it should state nothing more.

The aws-lambda pack sees more than the code alone. It discovers units by reading the SAM template in the first place, and the function's SQS event records which queue, so the pack can attribute a handler to its queue. The blocker is `ServerlessNonHttpEvent` in `@suss/manifest-aws`, which parses the event and keeps only `{ eventId, eventType }`, dropping both the queue and the filter criteria. Keeping those two is a small, contained change, and the rest depends on it.

## What the counts do

On the fan-out fixture the pair list goes from seven to two. Both remaining pairs are two-sided publisher-to-subscriber lines on a queue.

Today's seven are four cross-multiplied lines on the shared subject, plus one queue-against-its-consumer line for each of the three queues no rule feeds. Under the model, the two rule-fed queues each have the rule publishing and one function subscribing, so one pair each. The other three queues have a subscriber and nothing publishing, so they get no pair and a consumer-orphan finding, the same finding they report today. The two handlers leave the pair list, and their contracts get compared against what their wiring delivers.

Publishers arrive today as `message-send` effects on a transition, not as summaries. The implementation has to settle whether the pair list reads effects directly or a publisher gets a summary of its own. The participant counts are the same either way.

## Scope

- `@suss/manifest-aws`: keep the queue logical id and the filter criteria on an SQS `ServerlessNonHttpEvent`.
- aws-lambda pack: stop emitting a message-bus boundary binding for a declared subject, and emit the accepted-subject contract instead. This changes an asserted behavior and its test.
- `@suss/contract-cloudformation`: drop the routed-subject channel rewrite, emit the rule relay summary, turn the queue summary into a boundary declaration, and reduce filter patterns into subscriber predicates.
- `@suss/checker`: orphan and unused get read off the boundary declaration; the code-receiver category goes away with the code-side binding; the `checkPair` exemption for message-bus pairs comes off; the every-outcome-is-an-error report is added.

## Verification

Fixtures alone are enough. `fixtures/aws-lambda` already has two Lambdas on one subject behind two queues fed by one rule, and that is the case this proposal depends on. Add a rule targeting a Lambda directly, a queue that several routed subjects go into, two subscribers on one queue narrowing to different subsets, a filter that cannot be reduced, and a handler whose declared subject does not match what its queue delivers.

A measurement against a wide multi-Lambda SAM service would confirm that the counts move the way this predicts and that findings do not move with them. It would also show how often the every-outcome-is-an-error report fires. That measurement is not reproducible from this repository, and the repo owner will run it when the implementation is up for review.
