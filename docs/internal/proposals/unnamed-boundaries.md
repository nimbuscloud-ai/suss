# Proposal: the boundary the code does not name

Status: draft, seeking alignment. Nothing below is implemented except
where a step says otherwise. The false finding in the first section
reproduces against the checker on main today.

## The same mistake, three ways in one week

A pack that recognizes a boundary crossing has to record the crossing
even when the code assigns the boundary's name at runtime. The model
has no direct way to state that. "The code did not name it" is spelled
as an empty string in an identity field, and every writer and every
reader of a binding has to know that spelling by hand. Inside one week
it was gotten wrong three different ways:

1. **Inventing a name.** A NestJS field resolver on a class whose
   `@Resolver()` decorator names no type claimed it answered
   `Query.<field>`, a field no schema has (#94).
2. **Dropping the record.** The SQS recognizer dropped a send whole
   when `QueueUrl` was not a literal or `process.env.X`. Queue URLs in
   production repos come from config and environment, almost never
   from literals, which is how a production service recorded zero
   sends while many of its files construct send commands. EventBridge
   did the same for a put whose bus or detail type is named at runtime
   (both #113).
3. **Misreading the spelling.** The message-bus checker reads the
   empty channel #113 introduced as a channel named `""`. Every send
   recorded without a queue now produces this, verified today:

   > Producer.handler sends to sqs channel "" but nothing in the
   > analysed scope declares this channel, and no handler answers it.

   #113 shipped with a test that an empty channel forms no
   `boundaryKey`. The message-bus checker does not go through
   `boundaryKey`; it keeps its own channel index, and nobody told it.

Three packs and a checker each made a local decision about the same
convention and made it differently, and every failing run exited
zero. The week's fourth bug sits in the same family at another layer:
a cached run answered with summaries whose names were stripped
(0.3.1). What could not carry a name was reported as if nothing were
missing. Independent failures on one convention are the strongest
evidence available that the convention is not carrying its weight.

## Where the convention lives today

Writers of the empty-string spelling:

- `packages/adapter/typescript/src/adapter.ts:687,1667`, a route still
  inside wrapper expansion and a route whose handler its caller
  supplies
- `packages/adapter/typescript/src/contract.ts:321`
- `packages/framework/aws-sqs/src/index.ts:154,400`, the send and
  receive recognizers
- `packages/framework/aws-eventbridge/src/index.ts:231`
- `packages/framework/nestjs-graphql`, the type a decorator never
  named (#94)

Readers that each re-state "empty means unnamed" by hand:

- `packages/ir-core/src/boundaryKey.ts:53,61,82`
- `packages/cli/src/inspect.ts:918,936,1232,1250`
- `packages/cli/src/check.ts:552`
- `packages/cli/src/corroborateCommand.ts:58`
- `packages/checker/src/message-bus/messageBusPairing.ts`: nowhere,
  which is failure 3 above

And the schema already spells the same state two other ways.
`graphql-operation.operationName` is an optional field left unset for
an anonymous operation. `DeployableUnit.instanceName` is
`z.string().min(1)` with a comment that argues against the empty
string directly: "An empty name would agree with every other empty
name, so a unit that names nothing has to leave the field off
instead." One state, three spellings, and the newest spelling's
comment is a case against the oldest.

## What the model needs

Three states, of which today's model expresses two and overloads one:

- a boundary the source names, which pairs
- a boundary the source crosses but does not name, which is recorded
  and counted and never pairs
- no boundary

The middle state is currently "empty string, plus a convention that
every reader must re-implement". It should be something the type
system enforces on writers and hands to readers.

On whether we need a name at all: pairing does, existence does not. A
name is what pairing is, so an unnamed boundary can never pair, and
that is not a defect to engineer around. What must never follow from a
missing name is the crossing going unrecorded. Identity and existence
separate cleanly once the middle state is expressible.

## The design: null, and empty becomes invalid

Identity fields that a source can fail to name become nullable, and
the empty string stops validating:

```ts
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "eventbridge", "bullmq", "kafka", "nats"]),
  /** null when the code assigns the channel at runtime. */
  channel: z.string().min(1).nullable(),
});
```

The binding builders take `string | null` and throw on `""`, so misuse
fails at extraction time rather than at read time. `boundaryKey`
returns null when any identity field is null, which is the behavior it
has today with the spelling made explicit.

In the serialized summary the claim is written down rather than
inferred from an empty field:

```json
"semantics": { "name": "message-bus", "messageBus": "sqs", "channel": null }
```

The effect on the code that had the bugs is deletion. The SQS
recognizer's send path today:

```ts
const channel = readQueueUrlChannel(input) ?? "";
```

becomes:

```ts
const channel = readQueueUrlChannel(input);
```

`readQueueUrlChannel` already answers `string | null`. The seam where
three packs made three different wrong choices (invent, drop, coerce)
stops existing, because the helper's answer flows into the binding
unchanged. A pack author cannot reintroduce the bug without writing
`?? ""` on purpose, and the schema would reject the result.

On the reading side the checker gets the same correction from the
types. `effectiveChannel` in the message-bus checker starts returning
`string | null` because the semantics field does, and its existing
`ch === null` branch covers the case. Failure 3 disappears without a
new guard, which is the point: the convention becomes something the
compiler carries to every consumer, present and future.

Alternatives considered:

- **Keep `""` and add helper accessors.** Nothing stops the next pack
  from writing the raw field, and readers can still compare raw
  strings. The convention stays a convention.
- **Absence (optional field).** In the artifact, an absent field is
  indistinguishable from an older writer that never knew the field
  existed. Null is the claim stated by a writer who looked.
- **A per-field union with a reason**, like the schedule effect's
  `callbackRef: { type: "opaque", reason }`. The reason texture
  already lives on the interaction effect (callee text, args) and in
  the summary's gaps; wrapping every identity read in a union is
  machinery ahead of need.
- **A binding-level `identified: boolean`.** Loses which facet is
  unknown. EventBridge shows facets go missing independently.

## What a reader sees

- **inspect** renders the state in words instead of hiding the row:
  `sqs (named at runtime)` where a channel would appear. "Named at
  runtime" is the vocabulary #113 established; it is used everywhere
  rather than a synonym per surface.
- **check** prints one line when the count is nonzero: `4 crossings
  name their boundary at runtime`. Anonymous crossings never enter a
  pairable-boundary denominator, so a pack learning to record them
  never reads as coverage lost.
- **findings**: an anonymous producer yields one info finding per unit
  and bus technology, in the mold of the existing
  EventPattern-unresolvable info finding (surfaced rather than
  dropped): "OrderService.handler sends to an sqs queue the code names
  at runtime. The send is recorded; its delivery cannot be checked
  from source." It is never an orphan warning, because "nothing
  declares this channel" is not something we know.
- **unused-queue findings** stay, and stop overclaiming: when N sends
  in scope name their queue at runtime, the description says so, since
  any of them could target the queue.
- **pairing** splits the bucket: `unmatched.noBinding` today mixes
  units that have no boundary with units whose boundary has no name.
  An `unmatched.anonymous` bucket separates them, so a reader asking
  "what could not be checked, and why" gets two answers instead of
  one.

## Which fields change

Nullable now, each because a source exists that can match the crossing
and not the name:

- `message-bus.channel` (SQS and EventBridge recognizers, #113)
- `rest.method`, `rest.path` (wrapper expansion, caller-supplied
  handlers, #86)
- `graphql-resolver.typeName` (undeclared resolver type, #94)

Unchanged, because no source today can fail to name them:
`graphql-resolver.fieldName`, `storage-relational.table` and `scope`,
`runtime-config.instanceName`. The rule going forward: a field becomes
nullable when a pack turns up that can recognize the crossing without
the name, not before. `graphql-operation.operationName` stays optional;
it has produced no wrong output, and migrating its spelling is a
serialization change with no payoff today.

## Partial identity

An EventBridge entry can name its detail type while the bus is decided
at runtime. #113 collapses either missing half to a fully unnamed
channel, because a put keyed by half an identity pairs across buses.
This pass keeps that rule and the one-string channel. The message-bus
identity proposal restructures the channel into its facets (queue
identity; bus and detail type); when it lands, each facet takes the
null treatment independently and the collapse rule dissolves into it.

## Named-at-runtime is not the same as not-understood

A null identity field is a claim made by a pack that matched the call
and read the site: the name is assigned at runtime, and no static
reader can do better. A pattern the pack does not understand produces
nothing at all. Everything present in a summary is deliberate;
absence is the gap. So the reader-facing question "could suss not name
this, or did it not understand it" is answered by construction, and
the second class stays what the fuzzer hunts.

The property that patrols the border, and would have caught every
instance above regardless of the model: for each shape family that
names an identity (queue producer, EventBridge entry, REST route,
resolver type), generate the same program with the name routed through
a binding the recognizer cannot read, a variable assigned from config.
Hold two things: the summaries equal the literal-named summaries once
identity fields are erased, and the erased fields are null rather than
the crossing being gone. This slots into the equivalence oracle, which
already compares the same behavior written the plainest way; the
transform is the same behavior, named less. The invariant that treats
a keyless boundary as a defect refines to: a boundary that names every
identity field must key, and an anonymous boundary must never pair.

## Compatibility

Published 0.3.x summaries carry `""` in these fields (every SQS
receive effect does). `parseSummary` normalizes `""` to null on the
three affected variants at read time and keeps doing so; the cost is a
comparison. Writers never emit `""` again. Committed coverage
baselines regenerate in the same change.

## What this does not do

- **An operation we cannot classify.** `client.send(command)` where
  the command is built out of the recognizer's reach leaves the send
  class itself unknown, not only the channel. That is an anonymous
  effect, not an anonymous boundary, and it needs its own design.
- **No confidence machinery.** Null is not low confidence. It is a
  high-confidence claim that the source assigns the name at runtime.
- **Intent matching.** An intent saying "sends to some queue" being
  satisfied by an anonymous send is the vague-spec direction, separate
  work.

## The work, in order

Each step lands separately with the tree green:

1. Stop the false orphan under the current spelling: the message-bus
   checker treats an empty producer channel as unnamed. One guard and
   a regression test, deleted again by step 3. This enforces behavior
   #113 already decided, so it ships ahead of alignment on the rest.
2. ir-core: nullable identity fields, builders take `string | null`
   and throw on `""`, `boundaryKey` reads null, schema rejects `""`.
3. The writers follow the types: aws-sqs, aws-eventbridge,
   nestjs-graphql, wrapper expansion, the contract reader. The
   `?? ""` sites disappear.
4. checker and cli: the `unmatched.anonymous` bucket, the info
   finding, the unused-queue description, inspect and check rendering,
   corroborate's method guard.
5. behavioral-ir: parse-time normalization of `""`.
6. Fuzzer: the named-less transform and the refined invariant.
7. Pack-authoring docs, one paragraph: a recognizer that matches
   records the crossing; an identity field the code does not name is
   null; returning null means only "not my call".
8. Measure on the dogfood repos and state the numbers: sends recorded
   before and after, findings that appeared or disappeared.

## Open questions

1. The anonymous-producer info finding: a new kind, or widen
   `unsupportedSemantics`? And does the EventPattern-unresolvable
   finding fold into it later? Leaning new kind; "unsupported" is
   wrong for a semantics we support whose identity is unknowable.
2. Unused-queue findings when anonymous sends share the bus
   technology: annotate with the count (recommended) or suppress.
   Suppression lets one dynamic send silence every unused-queue
   warning in the project.
3. `pairSummaries` is exported, so splitting the unmatched bucket is a
   public API change either way it is shaped. New array, or a label on
   the existing one?
