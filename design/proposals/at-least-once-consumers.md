# Proposal: a consumer on an at-least-once channel that cannot take a repeat

Status: draft, seeking alignment. Nothing here is built.

## What the pass reads today

A standard SQS queue delivers a message at least once, and so does an
SNS subscription and an EventBridge rule. Here is a handler on one:

```ts
export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const { orderId, amount } = JSON.parse(record.body);
    await stripe.charges.create({ amount, metadata: { orderId } });
    await db.charge.create({ data: { orderId, amount } });
    await db.order.update({ where: { id: orderId }, data: { charged: true } });
  }
};
```

Run it twice on one message and the customer pays twice, and the ledger
gains a second row. `checkMessageBus` says nothing, and
`messageBusPairing.test.ts` pins the silence in "says nothing about a
message arriving more than once".

The two database calls are what suss sees. The payment call goes to a
client no pack classifies, so it arrives as an `invocation` with a
callee name and nothing else. Everything below is about the two calls
suss can read.

The pass compares the channel a producer sends to against the channel a
consumer receives from, and the fields a producer writes into the body
against the fields the consumer destructures. Delivery count takes no
part in it. What the pass already has, and what the check below reuses,
is the join from a declared consumer to the code deployed as it:
`readCodeScope` reads `metadata.codeScope.path` off the CloudFormation
consumer, and `collectReceives` walks every summary that `runsIn` that
scope.

## Delivery belongs to the provider

Delivery is something only the side that declares the channel can
state. A handler cannot read it off its own parameter. That is the
boundary-identity split: semantics say what both sides can spell, and
contract metadata says what only the provider knows. So it goes in
`MessageBusMetadataSchema`, beside `enabled`:

```ts
/**
 * How many times the channel delivers one message. Absent means the
 * declaration did not settle it, and every check that reads this stays
 * quiet rather than assuming a default.
 */
delivery: z.enum(["at-least-once", "at-most-once", "exactly-once"]).optional(),
```

What each reader can fill it from, using properties it already parses:

- The CloudFormation reader builds a queue provider per
  `AWS::SQS::Queue` and already reads `FifoQueue` into `fifoQueue`.
  `FifoQueue: true` with `ContentBasedDeduplication: true` is
  `exactly-once`. `FifoQueue` false or absent is `at-least-once`.
  `FifoQueue: true` with no `ContentBasedDeduplication` records
  nothing, because the deduplication id then comes from the sender at
  run time and the template never sees it. `ContentBasedDeduplication`
  is the one property this adds to what the reader parses.
- The same reader builds a topic provider per `AWS::SNS::Topic` and
  reads `FifoTopic`. The rule is the same: `FifoTopic` plus
  `ContentBasedDeduplication` is `exactly-once`, and a standard topic
  is `at-least-once`, because SNS retries a failed delivery.
- An EventBridge rule consumer is `at-least-once`. A consumer whose
  `patternResolution` is `schedule` records nothing: a cron rule is not
  a queue, and the pass drops those before pairing anyway.
- The Terraform reader reads `fifo_queue` and `fifo_topic` today and
  fills `delivery` from those plus `content_based_deduplication`.
- The Serverless reader hands its `resources:` block to the
  CloudFormation reader, so a queue declared there gets `delivery` with
  no change of its own.
- The wrangler reader emits a `cloudflare-queues` boundary per queue
  binding. Cloudflare Queues deliver at least once, and the binding
  says nothing that could change that, so every one of them is
  `at-least-once`.

A reader that cannot tell leaves the field out. Absent is not
`at-least-once`: a check that treated it that way would fire on every
channel nobody has taught suss to read.

The checker resolves delivery for a consumer by taking the consumer's
own value first, then the value on the providers its channel pairs
with, which is the index `checkMessageBus` already builds. A channel
whose sources disagree is left alone.

`check:metadata-wiring` fails a namespace field with only one side, so
the readers and the check land in the same change.

## What the consumer side can say about a repeat

Effects on a summary are the discriminated union in `schemas.ts`. The
ones a consumer's body produces are `interaction` effects with a class
(`storage-access`, `service-call`, `message-send`, `unit-invoke`,
`config-read`, `schedule`), plus `invocation` for a call no pack
classified. A storage access states `kind` (read or write), the
`fields` it touches, the `selector` it picked rows by, and the
`operation` the library was asked for.

A read repeats safely. A write is the hard case, and the issue's
version of the question is whether the message keys it. That
cannot be decided from a summary today. `selector` is a list of column
names: Prisma's `extractSelector` returns the keys of `where`, and the
Python and Ruby adapters build theirs the same way. The value behind
each key is recorded nowhere. So the update above arrives as
`selector: ["id"]` while the message says its fields are `orderId` and
`amount`. Comparing the two lists says the message does not key that
write, which is false, and a warning a reader can falsify at a glance
is worse than no warning. Comparing them by value needs the value the
key was set to, and no effect records it.

Take the property from the pack instead. That is what
`metadata.http.failureDelivery` does: the pack says whether its client
throws on a non-2xx, and `providerCoverage` never has to know what
axios is. The storage-access interaction gains one field in suss's own
vocabulary:

```ts
/** Whether running this call again changes the store again. A pack
 *  sets it; absent means the pack did not say. */
onRepeat: z.enum(["settles", "accumulates"]).optional(),
```

`settles` means a second run leaves the store as the first run left it.
`accumulates` means it does not. The library method names stay in the
packs and in their `vocabulary.json`, where `check:vocabulary` polices
them:

- Prisma's `create` and `createMany` insert a row per call, and a
  `data` value written as `increment`, `decrement` or `push` changes
  the stored value by the old one. `update`, `upsert` and `delete`
  against a `where` settle.
- SQLAlchemy's `add`, `add_all`, `bulk_save_objects` and
  `bulk_insert_mappings` accumulate. `update`, `merge` and `delete`
  settle.
- ActiveRecord's `create`, `create!`, `insert` and `insert_all`
  accumulate. `update`, `upsert`, `save` and `destroy` settle.

The Python and Ruby packs declare these as another list beside
`writes`, so the adapters keep reading a typed pack field and gain no
library names of their own.

## The finding

`messageBusRepeatUnsafe`, warning, emitted by `checkMessageBus`. It
fires when all three of these are true:

- The consumer's channel resolves to `delivery: "at-least-once"`.
- A summary in the consumer's code scope has a storage-access write
  marked `onRepeat: "accumulates"`.
- No storage-access read comes earlier in the same transition.

The description says which call, which container and which channel:

> `recordCharge` writes to `Charges` on aws_sqs channel `OrdersQueue`
> with `prisma.charge.create`, and a second run of the same message
> adds a second row. `OrdersQueue` is a standard SQS queue, so it
> delivers a message at least once. Nothing earlier in this path reads
> a stored record that would let the handler recognize a message it has
> already processed.

Severity is warning because whether a repeat matters is a question
about the domain. A duplicate audit row is untidy and a duplicate
charge is a refund.

The third condition is what the issue calls a read of a deduplication
store, stated in terms the run can decide. Nothing tells a
processed-messages table apart from any other table, so the rule is the
weaker one: a handler that read something before it wrote is a handler
that may have checked, and suss has no grounds to call it wrong. It is
narrow on purpose. The read has to be in the same transition as the
write, because a read in one helper and a write in another are two
summaries and nothing orders effects across them.

Suppression needs nothing new. The finding includes the consumer
transition, so `suss check` prints a `.sussignore` rule keyed on the
kind, the boundary and that transition id, which silences this handler
and no other. A team that accepts duplicates on one channel writes the
reason in the rule.

## Acceptance

Fixture cases, all under `fixtures/at-least-once-consumer`, with one
SAM template declaring the channels and one handler per case:

- `chargeOnce.ts`, the handler above, on a standard `AWS::SQS::Queue`.
  One finding, against the `db.charge.create` call.
- `recordPayment.ts`, which does the same work with
  `db.order.upsert({ where: { id: orderId }, ... })` and nothing else.
  Silent. This is the case a selector comparison would have reported.
- `settleFifo.ts`, the same body as `chargeOnce.ts` on a queue declared
  `FifoQueue: true` with `ContentBasedDeduplication: true`. Silent,
  because the channel resolves to `exactly-once`.
- `chargeAfterCheck.ts`, which calls `db.processedMessage.findUnique`
  and returns early before reaching the same `create`. Silent, by the
  earlier-read rule above.

The fixture README repeats that the payment call is invisible and the
finding points at the row the handler appends beside it, because a
reader looking at `chargeOnce.ts` will assume the charge is what suss
saw.

## Cost

One optional field on a metadata namespace and one on the
storage-access interaction. One property read added to each of two
contract readers. In the checker, one walk over effects that
`checkBodyShapes` already collects for each consumer, over summaries
the pass has already filtered by scope. No new pass, and nothing runs
for a channel with no `delivery`.

## Order

1. `delivery` on the metadata namespace, filled by the CloudFormation,
   Terraform and wrangler readers, read by the check. The check fires
   on nothing yet, because no pack sets `onRepeat`.
2. `onRepeat` on the storage-access interaction, set by the Prisma,
   SQLAlchemy and ActiveRecord packs in one change. This is where the
   fixtures above start reporting, and it is the step that ships for
   TypeScript, Python and Ruby together.

Both adapters already emit storage-access with a kind and a selector,
so nothing about the language blocks step 2. What Python and Ruby lack
is the `message-receive` effect, which comes only from
`@suss/framework-aws-sqs` and `@suss/framework-aws-eventbridge`, both
built on the TypeScript adapter. This check never asks which fields the
consumer read, so that gap does not reach it. It needs the code scope,
which the CloudFormation reader states whatever the runtime is, and the
write, which all three adapters produce.

## Out of scope

- Ordering, batching and dead-letter routing. Each is its own claim
  about the protocol and none of them turns a working-looking handler
  into a money bug the way redelivery does.
- A `service-call` with a method HTTP does not define as idempotent,
  which would catch an email or payment client the run recognizes.
  `service-call` is emitted only by `adapter-typescript`, so shipping
  it now would give the finding to one language of the three.
- Recognizing a processed-messages table as one. That is a pack
  question: the pack that knows the library also knows what a
  deduplication check looks like, and until one says so the
  earlier-read rule does that job.
- A write whose new value is computed from a value the handler read
  earlier. That needs to know where the written value came from, which
  is the same thing the selector discussion above found missing.
