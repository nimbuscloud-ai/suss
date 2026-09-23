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
has no direct way to express that. We write "the code did not name it"
as an empty string in an identity field, and every writer and reader
of a binding has to remember that convention. Within one week we got
it wrong three different ways:

1. **Inventing a name.** A NestJS field resolver, on a class whose
   `@Resolver()` decorator gives no type, claimed it resolved
   `Query.<field>`, a field that no schema has (#94).
2. **Dropping the record.** The SQS recognizer dropped a send entirely
   when `QueueUrl` was not a literal or `process.env.X`. Queue URLs in
   production repos come from config and environment, almost never
   from literals. That is how a production service recorded zero sends
   while many of its files construct send commands. EventBridge did the
   same for a put whose bus or detail type the code sets at runtime
   (both #113).
3. **Misreading the spelling.** The message-bus checker took the empty
   channel #113 introduced to be a channel actually named `""`. Every
   send recorded without a queue produced this until PR #115:

   > Producer.handler sends to sqs channel "" but nothing in the
   > analysed scope declares this channel, and no handler answers it.

   #113 shipped with a test that an empty channel produces no
   `boundaryKey`. The message-bus checker does not go through
   `boundaryKey`. It keeps its own channel index, and nobody changed it
   to match.

Three packs and a checker each made their own decision about the same
convention, each made it differently, and every failing run exited
zero. The week's fourth bug belongs to the same family at another
layer: a cached run returned summaries whose names had been stripped
(0.3.1). Anything that could not have a name was reported as if
nothing were missing. When independent code fails on one convention
this often, that is the strongest evidence available that the
convention is not working.

## Where the convention lives today

Code that writes the empty-string spelling:

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

Code that reads it, each place restating "empty means unnamed" by hand:

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
   always writes an empty channel, because only the event-source
   mapping in the template records which queue a handler drains. The
   checker joins the two by code scope, never by channel.
4. **The pack matched and could not read.** `adapter.ts:687` fills
   `""` when the route extraction returns null, which the taxonomy
   below calls not-understood rather than unnamed.

And the schema already spells "no name" two more ways.
`graphql-operation.operationName` is an optional field left unset for
an unnamed operation. `DeployableUnit.instanceName` is
`z.string().min(1)` with a comment that argues against the empty
string directly: "An empty name would agree with every other empty
name, so a unit that names nothing has to leave the field off
instead." So the comment on the newest spelling argues against the
oldest one.

## What the model needs

There are three states. Today's model expresses two of them and
overloads one:

- a boundary whose name the source gives, which pairs
- a boundary the source crosses but does not name, which is recorded
  and counted and never pairs in the checker
- no boundary at all

The middle state is currently "empty string, plus a convention that
every reader must re-implement". It should be a spelling the type
system enforces on writers and exposes to readers. And the migration
has to send each of the four current meanings to the right place:
meaning 1 becomes null, meaning 2 becomes a wildcard spelling that is
not null, meaning 3 becomes null with its join rule documented, and
meaning 4 becomes null plus the gap that already exists for it.

Do we need a name at all? Pairing needs one, and existence does not.
Pairing is done on a name, so an unnamed boundary can never pair, and
that is expected. What a missing name must never cause is a crossing
that goes unrecorded. Once the middle state can be expressed, identity
and existence are separate.

## The design: null, and empty becomes invalid

When a source can fail to give the name for an identity field, the
field becomes nullable, and the empty string no longer validates:

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
field is null. That is the behavior it has today, with the spelling
made explicit. In the serialized summary the claim is written down
instead of inferred from an empty field:

```json
"semantics": { "name": "message-bus", "messageBus": "sqs", "channel": null }
```

### Null comes after resolution

The first draft defined null as "the name is assigned at runtime, and
no static reader can do better". The alignment review showed that both
halves claim too much. `readQueueUrlChannel` resolves exactly two
forms, a string literal and `process.env.X`. It does not follow an
identifier to a const initialized from a literal one line above the
call. A static reader can do better, and the project already has one.
`ResolutionStore.resolveWrittenValue` works out "what is this
expression written as" across files, and GraphQL document discovery
already uses it for the same kind of question about a document kept in
a named constant.

So the definition is: **null means that after resolution, the chain
goes beyond what this source says.** How it works:

- The recognizer context gains the resolution store, the way it
  already has `isImportedFrom`. The store is passed through discovery
  today and never reaches recognizers. Passing it on is plumbing, and
  needs no new machinery.
- The per-pack mini-resolvers (`readQueueUrlChannel`, `readBusToken`)
  shrink to a final pattern match on the resolved expression. The
  place where three packs made three different wrong choices (invent,
  drop, coerce) goes away, because the store's result goes into the
  binding unchanged.
- A pack records the most grounded symbolic form it can reach. A
  resolved name comes first. Failing that, it records a symbolic token
  that some grounding pass can bind later (an env-var name is such a
  token today, grounded at check time against `envVarTargets`). It
  records null only when no symbolic form exists. Without this rule,
  every reference that today's grounding does not cover, such as a
  config key or a parameter, would be pushed into a state defined as
  permanently unpairable, while `process.env.X` pairs. Those references
  are all the same kind of thing. The only difference between them is
  which grounding machinery exists today.
- We measure the cost before passing the store becomes the default. The
  store widens toward imports when a lookup finds nothing, so a null
  result is the one that pays for the widening, and queue identities on
  the repos this proposal cares about will often come back null. The
  work list keeps the change waiting until there are `--datalog-profile`
  numbers over a corpus.

The symbolic-token state should get its own representation eventually.
A channel string that means either a queue name or an env token has
the same one-field, two-meanings problem this proposal sets out to
remove. The checker's fallback ("trust direct name match") also
compares tokens against logical ids as if the two shared a namespace.
That typing belongs to the message-bus identity proposal, which splits
channel identity into facets anyway. That document does not deal with
env-var channels or the chain collapse yet, so this proposal picks it
as the owner and leaves the convention in place until then. In the
long run, references live outside the code. Their bindings come from
contract readers, from a hand-written scenario file, or from a pack
that reads a live system, with provenance on each binding. A reference
the checker cannot ground then reports "pairs if env ORDERS_QUEUE_URL
is bound", which tells a reader which question to ask.

The implementation also changed the structure, at Matt's prompting.
Each protocol is one module in ir-core, containing its schema and its
behavior (identity key, pairing bucket, agreement rule). A registry
composes the modules and checks at compile time that none is missing.
Nothing outside a protocol's module decides how its boundaries key or
agree. The modules stay in ir-core instead of in packs, because a
published summary has to mean the same thing to a reader who never
installed the pack that wrote it.

This order of work also resolves an encoding conflict the review
found. `effect-grammar.md` requires an unresolved target to be recorded
as `unresolved` with a reason, and its migration note makes message
channels into grammar targets. Null on today's binding fields is the
degenerate spelling of that same state. When channels become targets,
these nulls move up into the grammar's encoding, along with their
reasons. The two documents now cite each other so neither drifts.

### What falls out on the reading side

`effectiveChannel` in the message-bus checker starts returning
`string | null` because the semantics field does, and its existing
null branch covers the case. PR #115's guard is then deleted instead of
maintained. The compiler enforces the convention on every consumer,
present and future.

Alternatives considered:

- **Keep `""` and add helper accessors.** Nothing stops the next pack
  from writing the raw field, and readers can still compare raw
  strings. The convention stays a convention.
- **Absence (optional field).** In the artifact, an absent field looks
  the same as one from an older writer that did not have the field.
  Null is a claim from a writer that checked.
- **A per-field union with a reason.** This is effect-grammar's
  encoding, and it wins eventually, per the sequencing above. Landing
  it on every identity field now would wrap every consumer in a union
  ahead of the grammar migration that motivates it.
- **A binding-level `identified: boolean`.** It loses which facet is
  unknown. EventBridge shows that facets go missing independently.

## What null does not mean

Three of the empty string's four meanings are something other than
"named at runtime", and each gets its own handling:

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
  checker's join by code scope is the pairing rule, and null records
  accurately that this source does not state the queue. These effects
  are left out of the named-at-runtime count below. A summary line
  that included them would report one unnamed crossing per SQS handler
  in every project.
- **Matched but unreadable.** When a pack matches a call and cannot
  read the identity expression at all, the summary has null plus the
  `unreadBinding` gap the adapter already emits. A reader tells the
  two apart by the gap: null with the gap is not-understood, and null
  without it is a source that does not state the name. The fuzzer
  still looks for crossings that produce neither.

The EventBridge recognizer needs one change to match. An empty string
literal in `DetailType` currently survives into the channel as an
empty subject with a named bus. An empty literal gives no name, so it
gets the same null treatment as a missing half.

## What a reader sees

- **inspect** shows a send through its invocation record (the callee
  and arguments), which is unchanged. The unmatched list shows each
  unit whose boundary has no name to pair on. inspect does not render
  a typed channel line on the send itself today. If one lands later,
  it belongs with the symbolic-reference work, where there is a
  question to show. We avoid the word "anonymous", because in this
  tree it already means a source construct without a name, like an
  unnamed GraphQL operation, and that is a different thing.
- **check** prints one line when the count is nonzero: `4 sends name
  their queue or bus at runtime. Each is recorded; none can be checked
  from source.` The counter walks message-send effects instead of
  summaries, because effect-level crossings never enter summary
  pairing. It also skips the crossings a wrapper's own summary shares
  with the summaries derived from it, which would otherwise be counted
  once unnamed and once named. Unnamed crossings never count toward a
  pairable-boundary denominator, so a pack that starts recording them
  never looks as though it lost coverage.
- **No per-unit finding in this pass.** The first draft proposed an
  info finding per unit and bus technology. Review showed it would
  repeat the aggregate line, and could only be suppressed by a broad
  kind rule, since a suppression cannot refer to a boundary with a
  null key. The finding becomes useful when symbolic references land
  and it can say "pairs if env ORDERS_QUEUE_URL is bound", which
  someone can act on. Until then the aggregate line and inspect report
  the state. Its eventual form follows what other analysis tools
  settled on. They keep three things separate: a stable name a user
  can silence (ESLint rule names, staticcheck's prefixed codes), the
  severity, and whether the tool found a violation or is reporting
  that it could not decide. SARIF, the report format most analyzers
  emit, gives that last state its own value: a result whose kind is
  "open" means the rule ran and lacked the information to conclude,
  which is different from "fail". And clang attaches a note that says
  what would settle the diagnostic. So the new kind reports as info,
  maps to "open" and not "fail" if suss ever emits SARIF, and its
  description says which binding is missing, the way a clang note
  does.
- **unused-queue findings** stay, and stop claiming too much. When N
  sends in scope name their queue at runtime, the description says so,
  since any of them could target the queue.
- **pairing** keeps one unmatched list, and each entry says why it
  went unmatched: the unit has no boundary, or its boundary has no
  name. Surfaces render the two segments separately. A reader asking
  "what could not be checked, and why" gets two answers, and existing
  consumers of the list still have one list to walk.

## Which fields change

These become nullable now, each because some source can match the
crossing without the name:

- `message-bus.channel` (SQS and EventBridge recognizers, #113; the
  receive recognizer's identity-elsewhere case uses the same type)
- `rest.method`, `rest.path` (unreadable bindings, caller-supplied
  handlers, #86), with `"*"` as the wildcard spelling for method
- `graphql-resolver.typeName` (undeclared resolver type, #94, written
  by the adapter's decorated-method discovery)

These stay unchanged, because no source today can fail to give their
name: `graphql-resolver.fieldName`, `storage-relational.table` and
`scope`, `runtime-config.instanceName`. From here on, a field becomes
nullable only when a pack turns up that can recognize the crossing
without the name. `graphql-operation.operationName` stays optional. It
has produced no wrong output, and migrating its spelling is a
serialization change that gains nothing today.

The inventory review found two more places null flows into, beyond the
binding itself. The adapter copies `semantics.method` into a
service-call effect's `interaction.method`. And `corroborateCommand`
and one inspect path render method and path bare, which would print
the word "null". Both are in the work list.

## Partial identity

An EventBridge entry can give its detail type while the code decides
the bus at runtime. When either half is missing, #113 treats the whole
channel as unnamed, because a put keyed by half an identity pairs
across buses. This pass keeps that rule and the one-string channel.
The message-bus identity proposal splits the channel into its facets.
When it lands, each facet gets the null treatment on its own, and the
collapse rule goes away.

## The property that catches the whole class

The property is metamorphic. Generate the same program twice, once
with the identity given by a literal and once with the name routed
through a binding the fact layer cannot ground, such as a value from a
fetched config or a parameter that no call site in scope supplies. Two
things have to be true: the summaries agree once identity fields are
erased, and the erased fields are null while the crossing is still
there.

How the name is routed matters. The first draft said "a variable
assigned from config", and `fact-resolution.md` requires exactly that
form to resolve to a name in its acceptance criteria. The two
documents would have claimed opposite outcomes on one input. The
transform has to use a binding that stays ungroundable after
resolution. Otherwise the property starts failing as soon as
resolution improves, and a guard should not fail when things get
better.

We read the harness to find the cost. Today's shape families are all
consumer-side (REST handler, component, announce, env, resolver, queue
consumer, package export), so the queue producer and EventBridge entry
families have to be built new. Neither can come from transforming an
existing family. Comparing with identity erased needs per-family
ignore paths in `summarySetDifferences`, plus an invariant that the
crossing survived. `everyBoundaryCanPair` has an exemption only for
resolver typeName today. The harness also skips these comparisons on
purpose in two places, returning a null baseline with a comment
calling the unnamed variant a different program. This proposal
reverses that position, because the same send with less naming is the
same behavior. It says so here, so the reversal is not left implicit
in a diff.

## Compatibility

Summaries now have a `schemaVersion` (2). An artifact without one is
version 1, and the parsers normalize it before validation, so 0.3.x
output can still be read with no rewrite. The published JSON schema
regenerates on build and is committed, so git keeps the file's version
history.

Two read paths exist, and the first draft covered only one:

- **Parsed reads.** All entry points into `BehavioralSummarySchema`
  (`parseSummary` and the safe variants; both CLI read paths use
  `safeParseSummaries`) normalize `""` to null on the affected
  variants before validation, and the schema itself rejects `""`. The
  first draft said the schema both normalizes and rejects, and one
  schema cannot do both. Normalization lives in the entry points,
  rejection in the schema, and builders throw at the source. Published
  0.3.x summaries keep parsing indefinitely, at the cost of a
  comparison.
- **The extraction cache.** `readManifest` does `JSON.parse` with no
  validation, and a warm hit returns summaries verbatim. The 0.3.1 bug
  came through that path. A 0.3.x cache directory would feed
  `""`-spelled summaries into code that only handles null. The cache's
  `SCHEMA_VERSION` is part of the entry key, so bumping it, a one-line
  change, makes old entries unreachable.

The committed coverage baselines regenerate in the same change.

## What this does not do

- **An operation we cannot classify.** When `client.send(command)`
  gets a command built outside the recognizer's reach, the send class
  itself is unknown, along with the channel. That is an unnamed effect,
  which differs from an unnamed boundary, and it needs its own design.
- **No confidence machinery.** Null does not mean low confidence. It is
  a claim that this source does not state the name, made at whatever
  confidence the summary already has.
- **Intent matching.** Whether an intent saying "sends to some queue"
  is satisfied by an unnamed send belongs to the vague-spec direction,
  which is separate work. The middle state is what makes that
  direction expressible at all. That argues for the model, and it is
  not part of this pass.

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
   widening cost. A shortfall is fixed in the store rather than put
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

- The wildcard token is `"*"` (Matt, 2026-08-05). It is not `ANY`,
  which is one vendor's spelling of the same claim; the CloudFormation
  reader maps `ANY` to `"*"`.
- Wildcard pairing lands with this pass (Matt, 2026-08-05). The
  mechanism changed during implementation, at Matt's prompting: there
  is no per-method indexing and no method list anywhere. REST buckets
  are keyed on the path alone, and a `methodsAgree` rule settles the
  method in-bucket, the way buses already agree. `GET` agrees with
  `"*"`, and so does `PROPFIND`.
- Unused-queue findings annotate rather than suppress (Matt,
  2026-08-05). The description includes the count of unnamed sends in
  scope, and the finding keeps firing.
- Empty strings never signal a state. This was the proposal's main
  argument and is now a standing rule: a field that means something
  when blank gets a spelling the type system enforces.
- The unmatched list stays one list. Each entry says why it went
  unmatched, and surfaces render the segments separately (Matt,
  2026-08-05).
- The ungrounded-boundary warning is a new kind, not a widening of
  `unsupportedSemantics` (Matt, 2026-08-05). It lands with symbolic
  references, in the form the prior-art note above describes. The
  EventPattern case folds into it then, with a deprecation window,
  since suppression rules validate against kind names.
- Resolution threading ships on for everyone (Matt, 2026-08-05). We
  measure speed before merge and fix a shortfall in the store, and
  never put it behind a setting.

## Open questions

1. The new warning kind's name, chosen when it lands with symbolic
   references.
2. Whether `rest` is the right variant name at all, or `http` route
   semantics more generally (Matt, 2026-08-05). An ALB listener rule
   and a webhook route are HTTP routing with no REST framing. Renaming
   a variant is a serialization change, and `schemaVersion` now exists
   so we can make one. This is longer term, alongside the
   flow-resolution north star.
