# Proposal: the effect grammar

Status: draft, seeking alignment. No implementation yet.

suss's type half (TypeShape) is a designed calculus with satisfaction
semantics and a matcher. Its effect half is six interaction classes that
accreted one pack at a time. This proposal designs the effect vocabulary
as a grammar with the same care: every effect a code unit performs is a
point in one space, new channel kinds are additions to that space rather
than new special cases, and three downstream features (capability
projection, effect diffs, intent effect outcomes) read the same
vocabulary instead of inventing their own.

In program-language terms: suss infers a type-and-effect judgment over
code that never had an effect system, and resolves the effects to
concrete infrastructure. The effect grammar is the effect half of that
judgment, written down.

## What exists today

Six interaction classes on `Effect` (packages/ir/src/schemas.ts), each
with bespoke fields:

| class | carried today | channel identity |
|---|---|---|
| `storage-access` | kind (read/write), fields, selector, operation | binding semantics (storage-relational) |
| `service-call` | method, payload, responseShape | binding (rest) |
| `message-send` | body, routingKey | binding semantics channel |
| `message-receive` | body | enclosing handler's binding |
| `config-read` | name, defaulted | binding (runtime-config) |
| `schedule` | via, callbackRef, hasDelay | none (not a contract) |

Plus unclassified invocation effects: callee name and argument shapes,
no channel, no verb. `console.log`, `fs.writeFileSync`, and every other
call the packs don't classify land here. They render in inspect but
cannot pair, cannot be projected as a capability, and cannot be named by
an intent.

Three observations drive the redesign:

- The classes already share an implicit structure (a kind of resource, a
  direction, a target, a payload) but each spells it differently:
  `storage-access.kind`, message classes split send/receive into two
  class names, `config-read` bakes the direction into the class name.
- Channel identity lives in the enclosing `Effect.binding` for some
  classes and nowhere for others. Whether an effect can pair depends on
  which class it is, not on whether its target is known.
- There is no io family at all, so "writes to stdout" and "writes this
  file" are invisible as capabilities even though the CLI surface and
  most build tooling consist of little else.

## The grammar

An interaction effect is a 5-tuple:

```
effect = (family, verb, target, payload, conditions)
```

- **family** — the kind of resource the effect touches. Initial set:
  `storage`, `http`, `message`, `config`, `io`, `time`. Families are
  infrastructure kinds, never framework names (the death test below).
- **verb** — what is done to it, from a small per-family set:
  `read` / `write` / `delete` for storage and io, `call` for http,
  `send` / `receive` for message, `read` for config, `schedule` for
  time. Verbs are directions of dataflow, not API method names.
- **target** — the resolved channel identity: a table name, a URL or
  host, a queue or bus#detailType channel, an env-var name, a stream
  (`stdout`, `stderr`) or path, a scheduling API. Targets may be
  `unresolved` with a reason; an unresolved target is surfaced, never
  dropped, matching the summary philosophy.
- **payload** — the TypeShape crossing the channel, when extractable.
  The existing per-class extras (fields/selector for storage,
  responseShape for http, defaulted for config, callbackRef/hasDelay for
  time) become family-specific payload metadata rather than top-level
  class fields.
- **conditions** — the predicates gating the transition the effect sits
  on. Already modeled; the grammar makes explicit that a capability
  claim is conditional ("sends to OrdersQueue when total > 0").

The six current classes map losslessly:

| today | grammar |
|---|---|
| storage-access (kind: read) | (storage, read, table, fields) |
| storage-access (kind: write) | (storage, write, table, fields) |
| service-call | (http, call, url/host, payload + responseShape) |
| message-send | (message, send, channel, body) |
| message-receive | (message, receive, channel, body) |
| config-read | (config, read, var name, defaulted) |
| schedule | (time, schedule, via, callbackRef + hasDelay) |

New with the grammar, closing the known hole:

| new | grammar |
|---|---|
| process.stdout.write / console.* | (io, write, stdout/stderr, arg shape) |
| fs read APIs | (io, read, path-or-unresolved, shape) |
| fs write APIs | (io, write, path-or-unresolved, shape) |

## Literature this leans on, and what each contributes

- **Type-and-effect systems** (Lucassen and Gifford 1988; Talpin and
  Jouvelot; Koka's effect rows). Contributes the judgment shape: a
  unit's effect set is a row of labeled operations, rows compose across
  calls, and a row with fewer labels satisfies a declaration with more.
  We import the satisfaction direction directly: a declared effect set
  is a floor read one way (these effects are committed) and a ceiling
  read the other (an intent may forbid), and both readings come from
  row subsumption rather than ad hoc rules.
- **Object-capability literature** (Dennis and Van Horn; Miller).
  Contributes the discipline about what suss is not: capabilities
  answer what code MAY touch, suss effects answer what code DOES touch,
  under which conditions, with which payload. The grammar stays
  descriptive. Enforcement ("must not touch X") is expressed at the
  intent layer as a forbidden effect, checked like any declaration, so
  the IR never carries permission semantics.
- **Cloud IAM action vocabularies** (AWS `service:Verb` on a resource
  ARN, and the GCP/Azure equivalents). Contributes a pre-validated
  enumeration of the channel families production code actually touches,
  and a target-naming convention that already matches the deploy
  manifests we parse. Two consequences worth designing for: family/verb
  pairs should be mappable onto IAM action classes (send on a message
  channel maps into sqs:SendMessage territory), and a unit's projected
  capability set becomes directly comparable to the IAM policy its
  template grants. Statically checkable least-privilege drift (code
  sends to a queue the role can't reach; role grants a table no path
  writes) falls out of the same comparison machinery the checker
  already has.
- **WASI capability descriptors and Deno permission flags.** Contribute
  the io family's shape: read/write split per stream or path prefix,
  and precedent that stdout/stderr/fs/net is a complete-enough starter
  partition.

## What the grammar unlocks, in build order

1. **The vocabulary itself** (IR change, additive). One
   interaction shape with family/verb/target replacing the six-way
   discriminated union; old classes parse forward via a compatibility
   mapping for one release of the summary format.
2. **Capability projection** (derived, no new extraction). Fold a
   unit's transition effects into a per-unit capability set:
   `(family, verb, target)` with the union of payloads and the
   disjunction of conditions. Queryable ("which units write
   OrdersQueue") and rendered as a short block in inspect.
3. **Effect deltas in `inspect --diff`.** The reviewer story for
   agent-written code: "this change added (http, call,
   api.example.com) and (config, read, PAYMENT_KEY)". Highest
   value per unit of work in the whole arc; it reads projection
   output, so it ships immediately after 2.
4. **Intent effect outcomes** (the intent v0.2 workflow kind already
   sketched in intent-specs.md). An outcome may be an effect tuple;
   PRD scenarios link to it ("the order is queued"). Same vocabulary,
   no parallel naming scheme.
5. **IAM comparison** (new checker input, later). Parse the role
   policies the manifests already carry and compare granted actions
   against projected capabilities, both directions.
6. **Transitive closure** (the expensive one, last). A unit's
   effective capability includes its callees' effects. This is the
   access-tracing arc; blocked on nothing above and blocking nothing
   above.

## Guardrails

- **The death test.** Families and verbs must survive any framework's
  death. If a framework dying would force a family or verb change,
  framework vocabulary leaked into the grammar. Packs translate
  surface syntax into the grammar; they never extend it.
- **Description, not permission.** The IR states what code does.
  "May" and "must not" live in intent documents that reference the
  same tuples.
- **Unresolved is a value.** A target the analyzer can't resolve is
  recorded with a reason and surfaced in accounting, following the
  summary philosophy. A capability set with unresolved entries says so;
  it never silently narrows.
- **No new authoring surface.** Nothing here asks users to annotate
  code. The grammar is extracted; only intent documents are written by
  hand, and only if the team wants effect declarations.

## Migration

- Additive schema first: new interaction shape beside the old classes,
  packs emit the new shape, `parseSummaries` upgrades old-class
  documents on read.
- The checker's pairing keys (message channel, config name, storage
  table) are unchanged: they become target values, so pairing logic
  rewrites mechanically.
- Remove the old classes from the published JSON schema one release
  after every in-repo producer emits the new shape.

## Open questions for alignment

1. Family granularity: is `http` a family or a verb-carrier under a
   broader `network` family (grpc and websocket land eventually)?
   Proposal: `network` family with protocol on the target, so new
   protocols are data.
2. Does `schedule` belong in the grammar at all, given it pairs with
   nothing? Proposal: yes, as (time, schedule); capability projection
   including "schedules work" is useful to reviewers even without
   pairing.
3. Invocation effects: fold into the grammar as (call, callee) or keep
   as the unclassified substrate below it? Proposal: keep separate;
   they are the raw material recognizers classify, not capabilities.
4. How far to normalize targets (URL vs host vs host+path-prefix)?
   Proposal: family-specific target shapes, exact for message/config,
   host + optional path prefix for network, path prefix for io.
