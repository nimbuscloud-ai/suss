# Proposal: the boundary the code does not name

Status: decided and implemented. Step 1 landed as PR #115. The rest
is on PR #117: the schema and behavior modules, the wildcard, the
versioning, resolution threading (benchmarked against main, every
difference inside the run spread), and the producer shape family that
states the property that a send survives however it is named. We
revised it twice: once after three reviews, and once after
implementation changed two mechanisms, which are noted inline below.

## The same mistake, three ways in one week

A pack that recognizes a boundary crossing has to record the crossing
even when the code assigns the boundary's name at runtime. The model
has no direct way to say that. We spell "the code did not name it" as
an empty string in an identity field, and every writer and every
reader of a binding has to know that spelling by hand. Inside one week
we got it wrong three different ways:

1. **Inventing a name.** A NestJS field resolver, on a class whose
   `@Resolver()` decorator gives no type, claimed it resolved
   `Query.<field>`, a field that no schema has (#94).
2. **Dropping the record.** The SQS recognizer dropped a send entirely
   when `QueueUrl` was not a literal or `process.env.X`. Queue URLs in
   production repos come from config and environment, almost never
   from literals, which is how a production service recorded zero
   sends while many of its files construct send commands. EventBridge
   did the same for a put whose bus or detail type the code sets at
   runtime (both #113).
3. **Misreading the spelling.** The message-bus checker took the empty
   channel #113 introduced to be a channel actually named `""`. Every
   send recorded without a queue produced this until PR #115:

   > Producer.handler sends to sqs channel "" but nothing in the
   > analysed scope declares this channel, and no handler answers it.

   #113 shipped with a test that an empty channel produces no
   `boundaryKey`. The message-bus checker does not go through
   `boundaryKey`; it keeps its own channel index, and nobody told it.

Three packs and a checker each made a local decision about the same
convention and made it differently, and every failing run exited
zero. The week's fourth bug is in the same family at another layer:
a cached run returned summaries whose names had been stripped
(0.3.1). Anything that could not have a name was reported as if
nothing were missing. Independent failures on one convention are the
strongest evidence available that the convention is not doing its job.

## Where the convention lives today

Writers of the empty-string spelling:

- `packages/adapter/typescript/src/adapter.ts:687,1667`, a binding
  whose method or path the pack could not read, and the synthesized
  side of wrapper expansion
- `packages/adapter/typescript/src/contract.ts:321`
- `packages/adapter/typescript/src/discovery/decoratedMethod.ts:30`,
  the type a decorator never gave (#94; the earlier draft pointed at
  the nestjs-graphql pack, which has no writer)
- `packages/framework/aws-sqs/src/index.ts:154,400`, the send and
  receive recognizers
- `packages/framework/aws-eventbridge/src/index.ts:231`
- `packages/framework/nextjs/src/index.ts:105`, a pages-api handler
  that serves every method

Readers that each re-state "empty means unnamed" by hand:

- `packages/ir-core/src/boundaryKey.ts:53,61,82`
- `packages/adapter/typescript/src/adapter.ts:842,1148,1286,1429`
- `packages/cli/src/inspect.ts:918,936,1232,1250`
- `packages/cli/src/check.ts:552`
- `packages/cli/src/corroborateCommand.ts:58`
- `tools/differential/src/shape/invariants.ts:141`
- `packages/checker/src/message-bus/messageBusPairing.ts`: nowhere
  until PR #115, which is failure 3 above

The review of this inventory found something worse than a missing
guard: the empty string does not mean one thing. Today it has four
meanings, and only the first one is "named at runtime":

1. **The code assigns the name at runtime.** The SQS send whose
   `QueueUrl` is a variable.
2. **The unit serves every value.** The Next.js pages-api handler
   writes an empty method because one export serves all seven, with a
   comment saying so, and `corroborateCommand.ts:57` reads it back the
   same way. A wildcard is a claim about breadth, and calling it
   unnamed is false.
3. **The identity is stated elsewhere.** The SQS receive recognizer
   always writes an empty channel, because the event-source mapping in
   the template is what says which queue a handler drains. The checker
   joins the two by code scope, never by channel.
4. **The pack matched and could not read.** `adapter.ts:687` fills
   `""` when the route extraction returns null, which the taxonomy
   below calls not-understood rather than unnamed.

And the schema already spells "no name" two more ways.
`graphql-operation.operationName` is an optional field left unset for
an unnamed operation. `DeployableUnit.instanceName` is
`z.string().min(1)` with a comment that argues against the empty
string directly: "An empty name would agree with every other empty
name, so a unit that names nothing has to leave the field off
instead." That comment on the newest spelling argues against the
oldest one.

## What the model needs

Three states, of which today's model expresses two and overloads one:

- a boundary whose name the source gives, which pairs
- a boundary the source crosses but does not name, which is recorded
  and counted and never pairs in the checker
- no boundary at all

The middle state is currently "empty string, plus a convention that
every reader must re-implement". It should be something the type
system enforces on writers and gives to readers. And the migration has
to route the four current meanings to the right places: meaning 1
becomes null, meaning 2 becomes a wildcard spelling that is not null,
meaning 3 becomes null with its join rule documented, and meaning 4
becomes null plus the gap that already exists for it.

On whether we need a name at all: pairing does, existence does not. A
name is what pairing is done on, so an unnamed boundary can never
pair, and that is not a defect to engineer around. What must never
follow from a missing name is the crossing going unrecorded. Identity
and existence come apart once we can express the middle state.

## The design: null, and empty becomes invalid

Identity fields whose name a source can fail to give become nullable,
and the empty string stops validating:

```ts
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "sns", "s3", "eventbridge", "bullmq", "kafka", "nats"]),
  /** null when this source does not name the channel. */
  channel: z.string().min(1).nullable(),
});
```

The binding builders take `string | null` and throw on `""`, so misuse
fails at extraction time. `boundaryKey` returns null when any identity
field is null, which is the behavior it has today with the spelling
made explicit. In the serialized summary the claim is written down
rather than inferred from an empty field:

```json
"semantics": { "name": "message-bus", "messageBus": "sqs", "channel": null }
```

### Null is claimed after resolution, not instead of it

The first draft defined null as "the name is assigned at runtime, and
no static reader can do better". The alignment review showed both
halves overclaim. `readQueueUrlChannel` resolves exactly two forms, a
string literal and `process.env.X`; it does not follow an identifier
to a const initialized from a literal one line above the call. A
static reader can do better, and the project already has one:
`ResolutionStore.resolveWrittenValue` answers "what is this expression
written as" across files, and the GraphQL document discovery already
uses it for the structurally identical question of a document kept in
a named constant.

So the definition is: **null means that after resolution, the chain
goes beyond what this source says.** The mechanics:

- The recognizer context gains the resolution store, the way it
  already has `isImportedFrom`. The store is threaded through
  discovery today and never reaches recognizers; that is plumbing, not
  new machinery.
- The per-pack mini-resolvers (`readQueueUrlChannel`, `readBusToken`)
  shrink to a final pattern match on the resolved expression. The seam
  where three packs made three different wrong choices (invent, drop,
  coerce) stops existing, because the store's answer flows into the
  binding unchanged.
- A pack records the most grounded symbolic form it can reach. A
  resolved name comes first. Failing that, a symbolic token that some
  grounding pass can bind later (an env-var name is such a token
  today, grounded at check time against `envVarTargets`). Null only
  when no symbolic form exists. Without this rule, every reference
  today's grounding does not cover, a config key or a parameter, would
  be pushed down into a state defined as permanently unpairable, while
  `process.env.X` pairs. What separates those references is which
  grounding machinery exists, not what kind of thing they are.
- We measure the cost before the threading becomes the default
  behavior. The store widens toward imports when an answer is missing,
  and a null answer is what pays for the widening; queue identities on
  the repos this proposal cares about will often come back null. The
  work list gates the change on `--datalog-profile` numbers over a
  corpus.

The symbolic-token state deserves its own representation eventually.
One channel string that means either a queue name or an env token is
the same one-field-two-meanings problem this proposal exists to kill,
and the checker's fallback ("trust direct name match") compares tokens
against logical ids as if the two shared a namespace. That typing
belongs to the message-bus identity proposal, which restructures
channel identity into facets anyway. That document does not yet deal
with env-var channels or the chain collapse at all, so this proposal
nominates it as the owner and leaves the convention in place until
then. The long-range direction is references that live outside the
code, whose bindings come from contract readers, from a hand-supplied
scenario file, or from a pack that reads a live system, with
provenance on each binding. A reference the checker cannot ground then
reports "pairs if env ORDERS_QUEUE_URL is bound", which tells a reader
which question to ask.

One structural outcome landed with the implementation, at Matt's
prompting. Each protocol is one module in ir-core: its schema and its
behavior (identity key, pairing bucket, agreement rule) travel
together, composed by a registry with a compile-time completeness
check. Nothing outside a protocol's module decides how its boundaries
key or agree. The modules stay in ir-core rather than in packs: a
published summary has to mean the same thing to a reader who never
installed the pack that wrote it.

This sequencing also reconciles an encoding conflict the review found.
`effect-grammar.md` requires an unresolved target to be recorded as
`unresolved` with a reason, and its migration note makes message
channels into grammar targets. Null on today's binding fields is the
degenerate spelling of that same state, and when channels become
targets, these nulls move up into the grammar's encoding, reasons and
all. The two documents now cite each other so neither drifts.

### What falls out on the reading side

`effectiveChannel` in the message-bus checker starts returning
`string | null` because the semantics field does, and its existing
null branch covers the case; PR #115's guard is then deleted rather
than maintained. The compiler takes the convention to every consumer,
present and future.

Alternatives considered:

- **Keep `""` and add helper accessors.** Nothing stops the next pack
  from writing the raw field, and readers can still compare raw
  strings. The convention stays a convention.
- **Absence (optional field).** In the artifact, an absent field is
  indistinguishable from an older writer that never knew the field
  existed. Null is the claim stated by a writer who looked.
- **A per-field union with a reason.** This is effect-grammar's
  encoding, and it wins eventually, per the sequencing above. Landing
  it on every identity field now would wrap every consumer in a union
  ahead of the grammar migration that motivates it.
- **A binding-level `identified: boolean`.** It loses which facet is
  unknown. EventBridge shows that facets go missing independently.

## What null does not mean

Three of the empty string's four meanings are not "named at runtime",
and each gets its own disposition:

- **A wildcard.** The Next.js pages-api handler and API Gateway's
  `ANY` method serve every method. The method field gets a wildcard
  spelling, `"*"`, that is neither a name nor null. Pairing buckets
  REST routes by path and lets `methodsAgree` settle the method
  in-bucket, so a wildcard matches whichever method each consumer
  writes, with no method vocabulary listed anywhere. The
  CloudFormation reader binds `ANY` as `"*"` instead of skipping it.
  Without the spelling, throwing builders would crash extraction on
  any pages-api project. The mechanical rewrite to null would be
  worse: inspect would say "named at runtime" about a handler whose
  method nobody sets at runtime.
- **Identity stated elsewhere.** A receive effect's channel is null
  because which queue a handler drains is deployment wiring. The
  checker's join by code scope is the pairing rule, and null is the
  field being truthful that this source does not state it. These
  effects are excluded from the named-at-runtime count below; a
  summary line that swept them in would report one unnamed crossing
  per SQS handler in every project.
- **Matched but unreadable.** When a pack matches a call and cannot
  read the identity expression at all, the summary has null plus the
  `unreadBinding` gap the adapter already emits. A reader tells the
  two apart by the gap: null with the gap is not-understood, null
  without it is a source that does not state the name. The fuzzer is
  still hunting the same thing: crossings that produce neither.

The EventBridge recognizer needs one alignment with this: an empty
string literal in `DetailType` currently survives into the channel as
an empty subject with a named bus. An empty literal gives no name, so
it gets the same null treatment as a missing half.

## What a reader sees

- **inspect** shows a send through its invocation record (the callee
  and arguments), which is unchanged. The unmatched list gives each
  unit whose boundary has no name to pair on. inspect does not render
  a typed channel line on the send itself today; if one lands later it
  belongs with the symbolic-reference work, where there is a question
  to show. We avoid the word "anonymous": in this tree it already
  means a source construct without a name, like an unnamed GraphQL
  operation, which is a different thing.
- **check** prints one line when the count is nonzero: `4 sends name
  their queue or bus at runtime. Each is recorded; none can be checked
  from source.` The counter walks message-send
  effects, not summaries, because effect-level crossings never enter
  summary pairing; and it skips the crossings a wrapper's own summary
  shares with the summaries derived from it, which would otherwise be
  counted once unnamed and once named. Unnamed crossings never enter a
  pairable-boundary denominator, so a pack that learns to record them
  never looks like lost coverage.
- **No per-unit finding in this pass.** The first draft proposed an
  info finding per unit and bus technology. Review showed it would
  duplicate the aggregate line while being suppressible only by a
  broad kind rule, since a suppression cannot refer to a boundary with
  a null key. The finding is worth adding when symbolic references
  land and it can say "pairs if env ORDERS_QUEUE_URL is bound", which
  is actionable; until then the aggregate line and inspect are what
  report the state. Its eventual form follows what other analysis
  tools converged on. They keep three things separate: a stable name a
  user can silence (ESLint rule names, staticcheck's prefixed codes),
  the severity, and whether the tool found a violation or is reporting
  that it could not decide. SARIF, the report format most analyzers
  emit, gives that last state its own value: a result whose kind is
  "open" means the rule ran and lacked the information to conclude,
  distinct from "fail". And clang attaches a note that says what
  would settle the diagnostic. So the new kind reports as info, maps
  to "open" rather than "fail" if suss ever emits SARIF, and its
  description says which binding is missing, the way a clang note
  does.
- **unused-queue findings** stay, and stop overclaiming: when N sends
  in scope name their queue at runtime, the description says so, since
  any of them could target the queue.
- **pairing** keeps one unmatched list, and each entry says why it
  went unmatched: the unit has no boundary, or its boundary has no
  name. Surfaces render the two segments separately, so a reader
  asking "what could not be checked, and why" gets two answers, and
  existing consumers of the list keep one list to walk.

## Which fields change

Nullable now, each because a source exists that can match the crossing
and not the name:

- `message-bus.channel` (SQS and EventBridge recognizers, #113; the
  receive recognizer's identity-elsewhere case uses the same type)
- `rest.method`, `rest.path` (unreadable bindings, caller-supplied
  handlers, #86), with `"*"` as the wildcard spelling for method
- `graphql-resolver.typeName` (undeclared resolver type, #94, written
  by the adapter's decorated-method discovery)

Unchanged, because no source today can fail to name them:
`graphql-resolver.fieldName`, `storage-relational.table` and `scope`,
`runtime-config.instanceName`. The rule going forward: a field becomes
nullable when a pack turns up that can recognize the crossing without
the name, not before. `graphql-operation.operationName` stays
optional; it has produced no wrong output, and migrating its spelling
is a serialization change with no payoff today.

Null also flows into two places the inventory review found beyond the
binding itself: the adapter copies `semantics.method` into a
service-call effect's `interaction.method`, and `corroborateCommand`
and one inspect path render method and path bare, which would print
the word "null". Both are in the work list.

## Partial identity

An EventBridge entry can give its detail type while the code decides
the bus at runtime. #113 collapses either missing half to a fully
unnamed channel, because a put keyed by half an identity pairs across
buses. This pass keeps that rule and the one-string channel. The
message-bus identity proposal restructures the channel into its
facets; when it lands, each facet gets the null treatment
independently and the collapse rule dissolves into it.

## The property that catches the whole class

The metamorphic property: generate the same program twice, once with
the identity given by a literal and once with the name routed through
a binding the fact layer cannot ground, a value from a fetched config
or a parameter that no call site in scope supplies. Two things have to
be true: the summaries agree once identity fields are erased, and the
erased fields are null rather than the crossing being gone.

The routing matters. The first draft said "a variable assigned from
config", and `fact-resolution.md` requires exactly that form to
resolve to a name in its acceptance criteria, so the two documents
would have claimed opposite outcomes on one input. The transform has
to use a binding that stays ungroundable after resolution, or the
property starts failing the moment resolution improves, which is the
wrong direction for a guard.

The cost, from reading the harness rather than assuming: today's
shape families are all consumer-side (REST handler, component,
announce, env, resolver, queue consumer, package export), so the queue
producer and EventBridge entry families have to be built new rather
than transformed from an existing one. Comparing with identity erased
needs per-family ignore paths in `summarySetDifferences`, plus an
invariant that the crossing survived, and `everyBoundaryCanPair` has
an exemption only for resolver typeName today. The harness also
declines these comparisons on purpose in two places, returning a null
baseline with a comment calling the unnamed variant a different
program. This proposal reverses that position, on the argument that
the same send with less naming is the same behavior, and it says so
here rather than leaving the reversal implicit in a diff.

## Compatibility

Summaries now have a `schemaVersion` (2). An artifact without one is
version 1, and the parsers normalize it before validation, so 0.3.x
output still reads with no rewrite. The published JSON schema
regenerates on build and is committed, which is the file's version
history.

Two read paths exist, and the first draft covered only one:

- **Parsed reads.** All entry points into `BehavioralSummarySchema`
  (`parseSummary` and the safe variants; both CLI read paths use
  `safeParseSummaries`) normalize `""` to null on the affected
  variants before validation, and the schema itself rejects `""`. The
  first draft said the schema both normalizes and rejects, which one
  schema cannot do; normalization lives in the entry points, rejection
  in the schema, and builders throw at the source. Published 0.3.x
  summaries keep parsing indefinitely; the cost is a comparison.
- **The extraction cache.** `readManifest` does `JSON.parse` with no
  validation and a warm hit returns summaries verbatim, which is the
  path the 0.3.1 bug came from. A 0.3.x cache directory would feed
  `""`-spelled summaries into code that only handles null. The cache's
  `SCHEMA_VERSION` is part of the entry key; bumping it makes old
  entries unreachable, one line.

The committed coverage baselines regenerate in the same change.

## What this does not do

- **An operation we cannot classify.** `client.send(command)` where
  the command is built out of the recognizer's reach leaves the send
  class itself unknown, not only the channel. That is an unnamed
  effect rather than an unnamed boundary and needs its own design.
- **No confidence machinery.** Null is not low confidence. It is a
  claim, made at whatever confidence the summary already has, that
  this source does not state the name.
- **Intent matching.** An intent saying "sends to some queue" being
  satisfied by an unnamed send is the vague-spec direction, separate
  work. The middle state is what makes that direction expressible at
  all, which is an argument for the model rather than part of this
  pass.

## The work, in order

Each step lands separately with the tree green:

1. Landed: PR #115. The message-bus checker treats an empty producer
   channel as unnamed and skips resolution for it. Step 4 deletes it.
2. ir-core: nullable identity fields, the `"*"` wildcard spelling for
   method, builders that take `string | null` and throw on `""`,
   `boundaryKey` reading null.
3. behavioral-ir and the adapter: entry-point normalization of `""`,
   the cache `SCHEMA_VERSION` bump.
4. The writers and readers follow the types: aws-sqs, aws-eventbridge
   (including the empty-literal halves), the adapter's
   decorated-method discovery, wrapper expansion and contract reader,
   the Next.js wildcard, the CloudFormation reader's `ANY` routes, and
   the checker, where PR #115's guard comes out.
5. cli and checker surfaces: the unmatched-reason property and its
   segmented rendering, wildcard pairing (REST buckets are keyed on
   the path and `methodsAgree` settles the method in-bucket, per the
   Decided section), the unused-queue annotation, the send-only
   crossing counter with wrapper dedup, null-safe rendering in
   inspect, check, and corroborate, and the service-call effect's
   copied method field.
6. Resolution threading into the recognizer context, on for everyone.
   `--datalog-profile` numbers over a corpus are part of the merge
   check, since identity queries that come back null pay the store's
   widening cost; a shortfall is fixed in the store rather than put
   behind a setting.
7. Fuzzer: the producer-side shape families, the named-less transform,
   and the invariant exemptions per family.
8. Docs: the pack-authoring rule in one paragraph (a recognizer that
   matches records the crossing; an identity field the source does not
   state is null, after asking the store; returning null means only
   "not my call"), and the effect-grammar cross-citation.
9. Measure on the dogfood repos and state the numbers: sends recorded
   before and after, findings that appeared or disappeared, and the
   extraction-time cost of resolution threading.

## Decided

- The wildcard token is `"*"` (Matt, 2026-08-05). Not `ANY`, which is
  one vendor's spelling of the same claim; the CloudFormation reader
  maps `ANY` to `"*"`.
- Wildcard pairing lands with this pass (Matt, 2026-08-05). The
  mechanism changed during implementation, at Matt's prompting: no
  per-method indexing and no method list anywhere. REST buckets are
  keyed on the path alone, and a `methodsAgree` rule settles the
  method in-bucket, the way buses already agree. `GET` agrees with
  `"*"`; `PROPFIND` does too.
- Unused-queue findings annotate rather than suppress (Matt,
  2026-08-05): the description includes the count of unnamed sends in
  scope, and the finding keeps firing.
- Empty strings never signal a state. This was the proposal's thesis
  and is now a standing rule: a field that means something when blank
  gets a spelling the type system enforces.
- The unmatched list stays one list; each entry says why it went
  unmatched, and surfaces render the segments separately (Matt,
  2026-08-05).
- The ungrounded-boundary warning is a new kind, not a widening of
  `unsupportedSemantics` (Matt, 2026-08-05). It lands with symbolic
  references, shaped the way the prior-art note above describes; the
  EventPattern case folds into it then, with a deprecation window
  since suppression rules validate against kind names.
- Resolution threading ships on for everyone (Matt, 2026-08-05). We
  measure speed before merge and fix a shortfall in the store, never
  put it behind a setting.

## Open questions

1. The new warning kind's name, chosen when it lands with symbolic
   references.
2. Whether `rest` is the right variant name at all, or `http` route
   semantics more generally (Matt, 2026-08-05). An ALB listener rule
   and a webhook route are HTTP routing with no REST framing. Renaming
   a variant is a serialization change, and `schemaVersion` now exists
   so we can make one. Longer term, alongside the flow-resolution
   north star.
