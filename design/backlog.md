# Forward-looking backlog

These are items we marked "think about later". None of them is
scheduled. The theory docs
([`concept-design.md`](../docs/theory/prior-art.md),
[`quality.md`](./docs-internal/quality.md)) describe them as
longer-term directions the shipped design should leave room for, and
they link here when they do.

Deferred items that belong to one phase are listed in
[`status.md`](status.md#phase-8-real-world-readiness) under that
phase. This file is for items that don't belong to any one phase.

## Near-term engineering

### Pack maintenance across upstream version changes

As React, Express, OpenAPI and the rest change, the patterns in packs
go out of date. We have no plan for any of it yet. We don't notice
when a pack targets an old API, we can't migrate patterns when an
upstream library renames or removes something, and we can't tell the
user "this pack was written against ts-rest 3.x and your project uses
4.x." We may need versioned packs, version ranges declared in pack
metadata, or runtime checks against the versions of the libraries a
project imports.

### Pack authoring tooling

To write a pack today you have to read the pack interface, study
similar packs, and understand the target framework. Making a new pack
easier to write, whether a person or an LLM writes it, depends on
documenting and specifying the pattern vocabulary clearly. With good
specs, a model could scaffold a pack. With bad specs, it can't.

### Factory discovery for dynamic endpoint registration

The current discovery patterns (`registrationCall`, `namedExport` and
so on) assume registration is mostly static. Production codebases
often call `registerEndpoints(config)`, where `config` is built in
code. We need a pattern that says "this factory call creates N routes,
according to its argument."

### A route somebody else's code serves {#library-served-routes}

NextAuth's route file is `export { GET, POST } from "@/auth"`, and
those two exports come from destructuring what the library returned.
The route exists and serves requests, but no function in the project
implements it, so suss reports nothing for it.

Someone reading the summaries sees a gap where a route should be, and
can't tell whether discovery missed it or there is nothing there. We
have no way to say "this boundary exists, and a library we cannot read
serves it". That would be different both from saying nothing and from
describing the behaviour.

The same thing happens wherever a library returns a handler, for
example tRPC's adapter export, or an OpenAPI router mounted from
generated code.

### A response type a library defines {#library-response-types}

A Next.js handler that ends in `new ImageResponse(...)` from `next/og`,
or `new StreamingTextResponse(stream)` from `ai`, doesn't match any
terminal the framework pack describes. suss reports that it could not
read the return, which is the right minimum, but the summary still
says nothing about what the handler produces.

Both are subclasses of Response, so we can work out what comes back.
The open question is who declares it. It could be a pack per library,
or a rule that any constructed subclass of Response is a response. Or
a library could ship its own summaries, which is where the
package-exports work points.

### Extraction across worker processes {#multi-process-extraction}

Extraction runs on one core. We have already made the cheap
improvements: the rule profiler work narrowed and merged walks, and
the per-file cache lets a warm run skip most files. What is left is
splitting the first run across processes, with one worker per group of
files, each with its own ts-morph project, and merging the results at
the end. Threads won't work, because ts-morph state cannot be shared.

Two costs need measuring before anyone starts. Memory multiplies,
since each worker keeps the ASTs for its group, and large repositories
already need heaps of several gigabytes. Cross-file resolution also
still has to work. Either a worker's group contains everything its
files import, or a second pass after the merge resolves what was left
over.

Start on this when a repository's first run needs to finish sooner and
memory is less of a concern.

### A unit that is both a library unit and a caller {#two-summaries-one-unit}

The dogfood run gives each unit one summary. When a function is both
an internal helper and a caller into another package, only the caller
half is recorded. So its summary moves from the internal column to the
consumer column, and the count gate fires on the drop. Nothing was
misread. One true fact was traded for another.

Two questions need a deliberate decision. Should `claimedUnits` allow
a library summary and a caller summary for the same function, and if
so, what does pairing do with the duplicate identity? And should the
count gate show a drop in internal that matches a rise in consumer as
a unit moving between categories, instead of as a regression? Today
this costs a baseline refresh and a sentence in the PR.

### Which write a read sees {#reaching-definitions}

A name written more than once resolves in two cases: when the writes
run in order at module level, or when every write is the same
construction (a client cached on first use, or a config object
assigned under one guard). suss can work out both from the writes
alone. A name that different branches assign different values does
not resolve:

```ts
let db: { name: string };
if (flag) {
  db = { name: "a" };
} else {
  db = { name: "b" };
}
```

Working out which write a later read sees is called reaching
definitions, and it needs control-flow facts the adapters do not emit.
On suss itself, the names this leaves unresolved are cursors in tree
walks (`current`, `root`, `node`), and nothing asks what they were
assigned. `reassignedNamesUnstated` counts them on each run.

We should start when a pack needs one of these names resolved on field
code. The first version would probably be facts per branch. A rule
could then say a name is one of two values, and a reader could accept
both when they agree on what the reader needs.

### `suss emit --format fast-check` (summaries as generated tests)

A summary already contains what a property test needs: the conditions
that select a path and the outcome the path claims. Emitting runnable
fast-check properties (or assertions for simulation platforms) would
turn summaries into something other tools can run and build on. The
strategy review chose that kind of partnership over building
simulators ourselves. The input synthesis in the corroborate engine is
the natural place to start. What we emit has to be tests a person
would want to keep, which is harder than sampling inputs.

### What the witness slot can still buy {#datalog-provenance}

Every derived fact keeps one witness: the rule that fired and the body
tuples it used. `proofOf` rebuilds a proof from those witnesses on
demand, and that is what `suss ask "why does"` prints. The confidence
level uses the same per-key tag slot, taking the minimum across a body
and the maximum across derivations. Two things we built the slot for
are still not built.

Deletion on edit. When a file changes, `evaluate` recomputes
everything. DRed and counting both retract exactly the facts that a
removed input supported, and both need a support count for each fact
next to the witness. The extraction cache needs that before a re-run
after an edit can be cheaper than a first run.

Counterfactual questions. A proof says why a fact holds. An agent
wants the smallest change that would make it stop holding, which is a
minimal cut over the rebuilt proof tree. That turns "no" into "no, and
here are the edits that would make it yes".

Both are waiting for something to call them. The watch loop would need
deletion, and the first agent integration that asks would need
counterfactuals.

### Goal-directed evaluation {#datalog-magic-sets}

Magic sets rewrite a rule set so that it only derives the facts
relevant to a query. The resolution store solves the same problem one
layer down, by extracting facts in waves and widening only when an
answer is still missing. That works, and we have measured it, but it
is built for that one consumer.

We should start when a second consumer wants evaluation driven by
demand, or when a fact base gets large enough that deriving the whole
model to answer one question is no longer cheap. Neither is true now.
The reachable-closure and rethrow passes derive everything by design,
and fact sets at extraction scale are thousands of tuples.

### Two rule sets sharing one database {#datalog-shared-database}

`evaluate` keeps track of what each rule set derived, so that a re-run
with negation can take back its own conclusions. When two rule sets
both derive a fact, the fact belongs to whichever got there first. If
that owner retracts it during a run with negation, the other rule
set's conclusion disappears even though it is still valid, until that
rule set runs again.

This can't happen today, because no rule set in the adapter uses
negation and the databases shared between passes are purely positive.
It becomes a problem with the first rule set that uses negation and
shares a database with another.

## Dogfooding extensions

The main dogfooding work has shipped (see
[`dogfooding.md`](./docs-internal/dogfooding.md)). The remaining
extensions are all tracked as deferred items under Phase 9 in
`status.md`:

- **Factory-return follow-through**: methods like
  `createAdapter().extractAll()` that are only reachable through a
  returned object.
- **Detecting chains of member calls** on the consumer side:
  `adapter.extractAll()` and `Schema.parse()` aren't tracked, only
  calls on a bare identifier are.
- **Namespace imports**: `import * as X from "pkg"` isn't scanned.
- **Pattern exports and conditional resolution**: `./utils/*` and
  `development` conditionals show up as warnings today.

## The Jackson arc (aspirational, framework-grounded)

The items below come from
[`concept-design.md`](../docs/theory/prior-art.md) and
[`quality.md`](./docs-internal/quality.md). They form one line of work
and are not independent features, so keep that in mind when you
schedule them.

### Intent specification as a structured data interface {#intent-specs}

This is a structured way to express *desired* behaviour: "this
endpoint should return 404 for deleted users, 200 otherwise." You
could then compare intent specs with each other (does the product spec
disagree with the PR spec?), with derivations (does the code do what
the spec says?), and with observations (do the tests cover the
intent?).

Jackson offers another way to look at this (see
[`concept-design.md`](./concept-design.md#prds-and-intent-specifications)).
A PRD or intent spec is a *top-down concept declaration indexed to an
audience*. It states a purpose, an operational principle, state,
actions and a role. The same failures of well-formedness apply: fused
purposes, scenarios that never end, state that is used but not owned,
and a missing audience. Checking derivation against spec, spec against
derivation, and one spec against another for different audiences are
three separate analyses over the same data.

[`quality.md`](./docs-internal/quality.md) takes this further. An
intent spec that only says what the feature *does* covers half the
contract. A fuller one says *how well*: the error budget, acceptable
latency, how edge cases are handled, and what has to be observable.
PRD-as-data should include quality specifications as well as
capability specifications.

### Arazzo workflows for cross-unit abstractions {#arazzo-workflows}

Arazzo describes API workflows with several steps as declared
artifacts. It could represent "functionality as code units interacting
over a bounded context", which is a concept cluster in Jackson's
terms, written down as an artifact we can compare against. It is
probably related to intent specs, since an Arazzo workflow is an
intent spec for an operation that spans several endpoints.

### Audience annotation on summaries {#audience-annotation}

This is a layer of tags that says which roles can observe a unit's OP.
We can infer some audiences from the code, such as an `/admin/` route
prefix, an operator-only CLI or an internal SDK package. Others have to
be declared from outside. It would make possible a taxonomy of features
for several audiences, and the case in
[`concept-design.md`](./concept-design.md#audience-indexing) where the
same behaviour has different OPs for different audiences. It is also
the axis that [`quality.md`](./docs-internal/quality.md#audience)
indexes quality by.

### Sync-chain identification / feature assembly {#sync-chains}

Today suss pairs providers with consumers, which gives edges between
two nodes. The next step is to join those paired edges into named
chains, treat each chain as a candidate feature, and check it against
intent specs and Arazzo workflows. That comes directly before checking
at the level of features and analysing quality across a whole feature,
specifically the
[*how*-at-workflow-level facet](./docs-internal/quality.md#layer-1--impedance-quality-user-determined)
and [feature-level quality](./docs-internal/quality.md#aspirational-implications)
in the quality doc.

### Failure-mode detection {#failure-modes}

These would be heuristics over the shared-state graph that detect
smeared, fused and phantom concepts (see
[`concept-design.md`](./concept-design.md#failure-modes-of-bottom-up-derivation)):

- Smeared: many units share a lineage of state, with no pairing
  binding between them.
- Fused: one unit's transitions split into separate sub-clusters by
  the lineage of their `subjects`.
- Phantom: a unit whose OP only ends in invocations of *other* units'
  actions, and never in an outcome a role can observe.

The signals are already in the IR, so turning them into findings is an
extension to the checker.

### Event / temporal / absence sync packs {#non-call-syncs}

Each of these needs a new `BoundarySemantics` variant (see
[`boundary-semantics.md`](/boundary-semantics)). The biggest piece of
work is that the IR has no notion of time, and pairing on an event
name works differently from the pairing suss has shipped for
in-process calls, HTTP and GraphQL. This would close the gap in reach
listed in
[`concept-design.md`](./concept-design.md#what-suss-can-and-cant-reach-yet).

### L2-shaped pattern packs {#l2-patterns}

From [`quality.md`](./docs-internal/quality.md#aspirational-implications):
recognise common resilience patterns (`retry`, `circuitBreaker`,
`withTimeout`, `fallback`) as framework-pack terminal or effect
matches, through the same interface as HTTP-status extraction. When
one is *absent* from a code unit whose role suggests it should be
there, such as an external API call with no timeout or a handler with
no error boundary, we can derive a finding. It is the win for
operational quality with the lowest effort and the highest payoff.

### Observation adapters {#observation-adapters}

A stub that reads traces or production logs and emits observation
records shaped like a `BehavioralSummary` at the same boundaries. It
would let checks like `contractDisagreement` run across spec,
derivation and observation together. It is the foundation for the full
epistemic split at the quality layer (see
[`quality.md`](./docs-internal/quality.md#epistemic)), and not only for
capabilities.

### Trade-off annotations {#tradeoff-annotations}

A layer of declared metadata ("this concept takes the consistency side
of the consistency/latency surface") that we can compare with derived
behaviour and observed behaviour. The hard part is that the taxonomy
of trade-off surfaces (see
[`quality.md`](./docs-internal/quality.md#trade-offs-as-named-surfaces))
has to be stable and extensible before the annotations become useful.

## How to apply

When you design a new feature or extension point, check whether it
rules out any of these, especially pack authoring tooling, factory
discovery, intent specs, audience tagging and sync chains. Prefer
designs that let them be added later without reworking what exists.

The items grounded in Jackson's work (intent specs, Arazzo, audience
annotation, sync chains, failure modes, non-call syncs, L2 patterns,
observation adapters, trade-off annotations) are one line of work. You
can schedule them one at a time, but understand them as related.
