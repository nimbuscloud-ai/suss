# Proposal: the boundary the code does not name

Status: draft, seeking alignment. Revised after three reviews (design,
alignment with the boundary model, and a correctness review of the
interim fix). Step 1 of the work list has landed as PR #115; nothing
else is implemented.

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
3. **Misreading the spelling.** The message-bus checker read the empty
   channel #113 introduced as a channel named `""`. Every send
   recorded without a queue produced this until PR #115:

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

- `packages/adapter/typescript/src/adapter.ts:687,1667`, a binding
  whose method or path the pack could not read, and the synthesized
  side of wrapper expansion
- `packages/adapter/typescript/src/contract.ts:321`
- `packages/adapter/typescript/src/discovery/decoratedMethod.ts:30`,
  the type a decorator never named (#94; the earlier draft pointed at
  the nestjs-graphql pack, which holds no writer)
- `packages/framework/aws-sqs/src/index.ts:154,400`, the send and
  receive recognizers
- `packages/framework/aws-eventbridge/src/index.ts:231`
- `packages/framework/nextjs/src/index.ts:105`, a pages-api handler
  that answers every method

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
guard: the empty string does not mean one thing. Today it carries four
meanings, and only the first is "named at runtime":

1. **The code assigns the name at runtime.** The SQS send whose
   `QueueUrl` is a variable.
2. **The unit answers every value.** The Next.js pages-api handler
   writes an empty method because one export serves all seven, with a
   comment saying so, and `corroborateCommand.ts:57` reads it back the
   same way. A wildcard is a claim about breadth, and calling it
   unnamed is false.
3. **The identity is stated elsewhere.** The SQS receive recognizer
   always writes an empty channel because the queue a handler drains
   is stated by the event-source mapping in the template; the checker
   joins the two by code scope, never by channel.
4. **The pack matched and could not read.** `adapter.ts:687` fills
   `""` when the route extraction answers null, which the taxonomy
   below calls not-understood rather than unnamed.

And the schema already spells "no name" two more ways.
`graphql-operation.operationName` is an optional field left unset for
an unnamed operation. `DeployableUnit.instanceName` is
`z.string().min(1)` with a comment that argues against the empty
string directly: "An empty name would agree with every other empty
name, so a unit that names nothing has to leave the field off
instead." The newest spelling's comment is a case against the oldest.

## What the model needs

Three states, of which today's model expresses two and overloads one:

- a boundary the source names, which pairs
- a boundary the source crosses but does not name, which is recorded
  and counted and never pairs in the checker
- no boundary at all

The middle state is currently "empty string, plus a convention that
every reader must re-implement". It should be something the type
system enforces on writers and hands to readers. And the migration has
to route the four current meanings to the right places: meaning 1
becomes null, meaning 2 becomes a wildcard spelling that is not null,
meaning 3 becomes null with its join rule documented, and meaning 4
becomes null plus the gap that already exists for it.

On whether we need a name at all: pairing does, existence does not. A
name is what pairing is, so an unnamed boundary can never pair, and
that is not a defect to engineer around. What must never follow from a
missing name is the crossing going unrecorded. Identity and existence
separate once the middle state is expressible.

## The design: null, and empty becomes invalid

Identity fields that a source can fail to name become nullable, and
the empty string stops validating:

```ts
export const MessageBusSemanticsSchema = z.object({
  name: z.literal("message-bus"),
  messageBus: z.enum(["sqs", "eventbridge", "bullmq", "kafka", "nats"]),
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
halves overclaim. `readQueueUrlChannel` resolves exactly two shapes, a
string literal and `process.env.X`; it does not follow an identifier
to a const initialized from a literal one line above the call. A
static reader can do better, and the project already has it:
`ResolutionStore.resolveWrittenValue` answers "what is this expression
written as" across files, and the GraphQL document discovery already
uses it for the structurally identical question of a document held in
a named constant.

So the definition is: **null means that after resolution, the chain
leaves what this source states.** The mechanics:

- The recognizer context gains the resolution store, the way it
  already carries `isImportedFrom`. The store is threaded through
  discovery today and never reaches recognizers; that is plumbing, not
  new machinery.
- The per-pack mini-resolvers (`readQueueUrlChannel`, `readBusToken`)
  shrink to a final pattern match on the resolved expression. The seam
  where three packs made three different wrong choices (invent, drop,
  coerce) stops existing, because the store's answer flows into the
  binding unchanged.
- A pack records the most-grounded symbolic form it can reach: a
  resolved name first; failing that, a symbolic token some grounding
  pass can bind later (an env-var name is such a token today, grounded
  at check time against `envVarTargets`); null only when no symbolic
  form exists. Without this rule, every reference today's grounding
  does not cover (a config key, a parameter) would be demoted into a
  state defined as permanently unpairable, while `process.env.X`
  pairs. The difference between those references is which grounding
  machinery exists, not what kind of thing they are.
- Cost is measured before the threading lands as default behavior.
  The store widens toward imports when an answer is missing, and a
  null answer is what pays for the widening; queue identities on the
  repos this proposal cares about will often answer null. The work
  list gates the change on `--datalog-profile` numbers over a corpus.

The symbolic-token state deserves its own representation eventually:
the channel string carrying either a queue name or an env token is the
same one-field-two-meanings shape this proposal exists to kill, and
the checker's fallback ("trust direct name match") compares tokens
against logical ids as if they shared a namespace. That typing belongs
to the message-bus identity proposal, which restructures channel
identity into facets anyway; that document does not yet treat env-var
channels or the chain-collapse at all, so this proposal nominates it
as the owner and leaves the convention in place until then. The
long-range direction is externalized references whose bindings arrive
from contract readers, from a hand-supplied scenario file, or from a
pack that reads a live system, with provenance on each binding; a
reference the checker cannot ground then reports "pairs if env
ORDERS_QUEUE_URL is bound", which tells a reader which question to
ask.

This sequencing also reconciles an encoding conflict the review found:
`effect-grammar.md` requires an unresolved target to be recorded as
`unresolved` with a reason, and its migration note makes message
channels into grammar targets. Null on today's binding fields is the
degenerate spelling of that same state; when channels become targets,
these nulls lift into the grammar's encoding, reasons and all. The two
documents now cite each other so neither drifts.

### What falls out on the reading side

`effectiveChannel` in the message-bus checker starts returning
`string | null` because the semantics field does, and its existing
null branch covers the case; PR #115's guard is then deleted rather
than maintained. The compiler carries the convention to every
consumer, present and future.

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
- **A binding-level `identified: boolean`.** Loses which facet is
  unknown. EventBridge shows facets go missing independently.

## What null does not mean

Three of the empty string's four meanings are not "named at runtime",
and each gets its own disposition:

- **A wildcard.** The Next.js pages-api handler and API Gateway's
  `ANY` method answer every method. The method field gets a wildcard
  spelling, `"*"`, that is neither a name nor null, and pairing learns
  it in this pass: at indexing time a `"*"` provider is entered under
  each concrete HTTP method, a closed set, so every existing key
  string stays as it is and no consumer-side code changes. The
  CloudFormation reader, which skips `ANY` routes entirely today,
  stops skipping them. Without the spelling, throwing builders would
  crash extraction on any pages-api project, and the mechanical
  rewrite to null would make inspect say "named at runtime" about a
  handler whose method is not named by anyone.
- **Identity stated elsewhere.** A receive effect's channel is null
  because the queue a handler drains is deployment wiring; the
  checker's join by code scope is the pairing rule, and null is the
  field being truthful that this source does not state it. These
  effects are excluded from the named-at-runtime count below; a
  summary line that swept them in would report one unnamed crossing
  per SQS handler in every project.
- **Matched but unreadable.** When a pack matches a call and cannot
  read the identity expression at all, the summary carries null and
  the `unreadBinding` gap the adapter already emits. A reader tells
  the two apart by the gap: null with the gap is not-understood, null
  without it is a source that does not state the name. The fuzzer's
  quarry stays what it was: crossings that produce neither.

The EventBridge recognizer needs one alignment with this: an empty
string literal in `DetailType` currently survives into the channel as
an empty subject with a named bus. An empty literal names nothing, so
it takes the same null treatment as a missing half.

## What a reader sees

- **inspect** renders the state in words on the send side:
  `sqs (named at runtime)` where a channel would appear. Receive rows
  are unchanged; their identity was never rendered from the channel.
  "Named at runtime" is #113's vocabulary, used on every surface. The
  word "anonymous" is avoided: in this tree it already means a source
  construct without a name, like an unnamed GraphQL operation, which
  is a different thing.
- **check** prints one line when the count is nonzero: `4 crossings
  name their boundary at runtime`. The counter walks message-send
  effects, not summaries, because effect-level crossings never enter
  summary pairing; and it skips the crossings a wrapper's own summary
  shares with the summaries derived from it, which would otherwise be
  counted once unnamed and once named. Unnamed crossings never enter a
  pairable-boundary denominator, so a pack learning to record them
  never reads as coverage lost.
- **No per-unit finding in this pass.** The first draft proposed an
  info finding per unit and bus technology. Review showed it would
  duplicate the aggregate line while being suppressible only by a
  broad kind rule, since a suppression cannot name a null-key
  boundary. The finding earns its place when symbolic references
  land and it can say "pairs if env ORDERS_QUEUE_URL is bound", which
  is actionable; until then the aggregate line and inspect carry the
  state. Its eventual shape follows what other analysis tools
  converged on. They keep three things separate: a stable name a user
  can silence (ESLint rule names, staticcheck's prefixed codes), the
  severity, and whether the tool found a violation or is reporting
  that it could not decide. SARIF, the report format most analyzers
  emit, gives that last state its own value: a result whose kind is
  "open" means the rule ran and lacked the information to conclude,
  distinct from "fail". And clang attaches a note that says what
  would settle the diagnostic. So the new kind reports as info, maps
  to "open" rather than "fail" if suss ever emits SARIF, and its
  description names the missing binding the way a clang note does.
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
  receive recognizer's identity-elsewhere case rides the same type)
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

An EventBridge entry can name its detail type while the bus is decided
at runtime. #113 collapses either missing half to a fully unnamed
channel, because a put keyed by half an identity pairs across buses.
This pass keeps that rule and the one-string channel. The message-bus
identity proposal restructures the channel into its facets; when it
lands, each facet takes the null treatment independently and the
collapse rule dissolves into it.

## The property that catches the whole class

The metamorphic property: generate the same program twice, once with
the identity named by a literal and once with the name routed through
a binding the fact layer cannot ground, a value from a fetched config
or a parameter no call site in scope supplies. Hold two things: the
summaries agree once identity fields are erased, and the erased fields
are null rather than the crossing being gone.

The routing matters. The first draft said "a variable assigned from
config", and fact-resolution.md's acceptance criteria require exactly
that shape to resolve to a name; the two documents would have asserted
opposite outcomes on one input. The transform has to use a binding
that stays ungroundable after resolution, or the property starts
failing the moment resolution improves, which is the wrong direction
for a guard.

The cost, from reading the harness rather than assuming it: the
shape families today are consumer-side (REST handler, component,
announce, env, resolver, queue consumer, package export), so queue
producer and EventBridge entry families are new construction, not a
transform on existing ones. Identity-erased comparison needs
per-family ignore paths in `summarySetDifferences` plus an invariant
that the crossing survived, and `everyBoundaryCanPair` carries an
exemption only for resolver typeName today. The harness also
deliberately declines these comparisons in two places, returning a
null baseline with a comment calling the unnamed variant a different
program; this proposal reverses that stance, on the position that the
same send named less is the same behavior, and says so here rather
than leaving the reversal implicit in a diff.

## Compatibility

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

Committed coverage baselines regenerate in the same change.

## What this does not do

- **An operation we cannot classify.** `client.send(command)` where
  the command is built out of the recognizer's reach leaves the send
  class itself unknown, not only the channel. That is an unnamed
  effect rather than an unnamed boundary and needs its own design.
- **No confidence machinery.** Null is not low confidence. It is a
  claim, made at whatever confidence the summary already carries, that
  this source does not state the name.
- **Intent matching.** An intent saying "sends to some queue" being
  satisfied by an unnamed send is the vague-spec direction, separate
  work. The middle state is what makes that direction expressible at
  all, which is an argument for the model rather than part of this
  pass.

## The work, in order

Each step lands separately with the tree green:

1. Landed: PR #115. The message-bus checker treats an empty producer
   channel as unnamed and skips resolution for it. Deleted by step 4.
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
   segmented rendering, wildcard pairing (a `"*"` provider indexed
   under each concrete method), the unused-queue annotation, the
   send-only crossing counter with wrapper dedup, null-safe rendering
   in inspect, check, and corroborate, and the service-call effect's
   copied method field.
6. Resolution threading into the recognizer context, on for everyone.
   `--datalog-profile` numbers over a corpus are part of the merge
   check, since identity queries that answer null pay the store's
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
- Wildcard pairing lands with this pass (Matt, 2026-08-05). A `"*"`
  provider pairs with consumers of every method, indexed as described
  above.
- Unused-queue findings annotate rather than suppress (Matt,
  2026-08-05): the description carries the count of unnamed sends in
  scope, and the finding keeps firing.
- Empty strings never signal a state. This was the proposal's thesis
  and is now a standing rule: a field that means something when blank
  gets a spelling the type system carries.
- The unmatched list stays one list; each entry carries why it went
  unmatched, and surfaces render the segments separately (Matt,
  2026-08-05).
- The ungrounded-boundary warning is a new kind, not a widening of
  `unsupportedSemantics` (Matt, 2026-08-05). It lands with symbolic
  references, shaped per the prior-art note above; the EventPattern
  case folds into it then, with a deprecation window since suppression
  rules validate against kind names.
- Resolution threading ships on for everyone (Matt, 2026-08-05).
  Speed is measured before merge and a shortfall is fixed in the
  store, never put behind a setting.

## Open questions

1. The new warning kind's name, chosen when it lands with symbolic
   references.
