# Forward-looking backlog

Items flagged as "think about later". None of them is
scheduled, but the theory docs
([`concept-design.md`](../docs/internal/concept-design.md),
[`quality.md`](../docs/internal/quality.md)) refer to them as aspirational arcs
the shipped design should leave room for, and they point here
when they do.

Deferred items that belong to one phase live in
[`status.md`](status.md#phase-8-real-world-readiness) under that
phase. This doc is for items that don't belong to any one phase.

## Near-term engineering

### Pack maintenance across upstream version changes

As React, Express, OpenAPI and the rest evolve, the patterns in
packs go stale. We have no story for any of it yet: noticing
that a pack targets an old API, migrating patterns when an
upstream library renames or removes a primitive, or telling the
user "this pack was written against ts-rest 3.x and your project
uses 4.x." We may need versioned packs, version ranges declared
in pack metadata, or runtime checks against the versions of the
libraries a project imports.

### Pack authoring tooling

Writing a pack today requires reading the pack interface,
studying similar packs, and understanding the target framework.
Making it easier to write a new pack, whether a person or an LLM
writes it, depends on documenting and specifying the pattern
vocabulary clearly. Good specs make AI-assisted pack scaffolding
tractable, and bad specs make it impossible.

### Factory discovery for dynamic endpoint registration

Current discovery patterns (`registrationCall`, `namedExport`,
etc.) assume mostly static registration. Production codebases
frequently do `registerEndpoints(config)` where `config` is built
programmatically. We need a pattern that says "this factory call
creates N routes, according to its argument."

### A route somebody else's code serves {#library-served-routes}

NextAuth's route file is `export { GET, POST } from "@/auth"`,
where those two exports come from destructuring what the library
returned. The route exists and serves requests, and no function
in the project implements it, so suss reports nothing for it.

A reader looking at the summaries sees a hole where a route
should be and cannot tell whether discovery missed it or whether
there is nothing there. What we lack is a way to say "this
boundary exists, and a library we cannot read serves it", which
is different from saying nothing and different from describing
the behaviour.

The same situation comes up wherever a library returns a
handler: tRPC's adapter export, or an OpenAPI router mounted
from generated code.

### A response type a library defines {#library-response-types}

A Next.js handler that ends in `new ImageResponse(...)` from
`next/og`, or `new StreamingTextResponse(stream)` from `ai`,
matches no terminal the framework pack describes. suss reports
that it could not read the return, which is the right floor, and
the summary still says nothing about what the handler produces.

Both are subclasses of Response, so we can work out what comes
back. The question is who declares it: a per-library pack, a
rule that says any constructed subclass of Response is a
response, or letting a library ship its own summaries the way
the package-exports work points at.

### Extraction across worker processes {#multi-process-extraction}

Extraction runs on one core. The cheap wins have been taken:
walks were narrowed and merged in the rule profiler work, and
the per-file cache lets a warm run skip most files. What is left
is splitting the first run across processes, one worker per
group of files with its own ts-morph project, merged at the end.
Threads will not do, because ts-morph state cannot be shared.

Two costs to measure before starting. Memory multiplies, since
each worker keeps the ASTs for its group and large repositories
already want multi-gigabyte heaps. Cross-file resolution still
has to work, so either a worker's group contains everything its
files import, or a second pass after the merge resolves what was
left over.

The trigger is a first run on a repository where the wall time
matters more than the memory.

### A unit that is both a library unit and a caller {#two-summaries-one-unit}

The dogfood gives one unit one summary. When a function is both
an internal helper and a caller into another package, only the
caller half is recorded, so its summary moves from the internal
column to the consumer column and the count gate fires on the
drop. Nothing was misread; one true fact was traded for another.

Two questions to decide rather than fall into: whether
`claimedUnits` should allow a library summary and a caller
summary for the same function, and what pairing does with the
duplicate identity if it does; and whether the count gate should
show a matched internal drop plus consumer rise as a category
move rather than a regression. Today this costs a baseline
refresh and a sentence in the PR.

### `suss emit --format fast-check` (summaries as generated tests)

A summary already contains what a property test needs: the
conditions that select a path and the outcome the path claims.
Emitting runnable fast-check properties (or assertions for
simulation platforms) turns summaries into an output other tools
can run and compose, which is the partnership the strategy
review chose over building simulators ourselves. The corroborate
engine's input synthesis is the natural starting point. What we
emit has to be "tests a human would keep," which is a higher bar
than sampling.

### What the witness slot can still buy {#datalog-provenance}

Every derived fact keeps one witness, the rule that fired and the
body tuples it consumed, and `proofOf` rebuilds a proof from
those on demand. That is what `suss ask "why does"` prints, and
the confidence level rides the same per-key tag slot with min
across a body and max across derivations. Two things the slot
was built for are still unbuilt.

Deletion on edit. When a file changes, `evaluate` recomputes
everything. DRed and counting both retract exactly the facts a
removed input supported, and both want a support count per fact
beside the witness. That is the piece the extraction cache needs
before a re-run after an edit is cheaper than a first run.

Counterfactual questions. A proof says why a fact holds. An
agent wants the smallest change that would make it stop holding,
which is a minimal cut over the reconstructed proof tree. That
turns "no" into "no, and here are the edits that make it yes".

Both wait on a caller. The trigger for deletion is the watch
loop; the trigger for counterfactuals is the first agent
integration that asks.

### Goal-directed evaluation {#datalog-magic-sets}

Magic sets rewrite a rule set so that it derives only the facts
a query is relevant to. The resolution store solves the same
problem one layer down, by extracting facts in waves and
widening only when an answer is still missing. That works, and
we have measured it, but it is built for that one consumer.

The trigger is a second consumer that wants demand-driven
evaluation, or a fact base large enough that deriving the whole
model to answer one question stops being cheap. Neither is true
now: the reachable-closure and rethrow passes derive everything
by design, and fact sets at extraction scale are thousands of
tuples.

### Two rule sets sharing one database {#datalog-shared-database}

`evaluate` keeps what each rule set derived, so that a re-run
with negation can take its own conclusions back. A fact that two
rule sets both derive belongs to whichever one got there first,
so when that owner retracts during a run with negation, the
other rule set's conclusion disappears even though it is still
valid, until that rule set runs again.

This cannot happen today, since no rule set in the adapter uses
negation and the databases shared between passes are purely
positive. The trigger is the first rule set with negation that
shares a database with another.

## Dogfooding extensions

The main dogfooding arc has shipped (see
[`dogfooding.md`](../docs/internal/dogfooding.md)). The remaining extensions are
all tracked as Phase 9 deferred items in `status.md`:

- **Factory-return follow-through**: `createAdapter().extractAll()`-style
  methods reachable only through a returned object.
- **Member-call chain detection** on the consumer side: `adapter.extractAll()`
  and `Schema.parse()` aren't tracked; only bare-identifier calls are.
- **Namespace imports**: `import * as X from "pkg"` isn't scanned.
- **Pattern exports and conditional resolution**: `./utils/*` and
  `development` conditionals surface as warnings today.

## The Jackson arc (aspirational, framework-grounded)

The items below trace back to
[`concept-design.md`](../docs/internal/concept-design.md) and
[`quality.md`](../docs/internal/quality.md). They form one coherent arc rather
than independent features, so treat them that way when you
schedule them.

### Intent specification as a structured data interface {#intent-specs}

A structured way to express *desired* behaviour: "this endpoint
should return 404 for deleted users, 200 otherwise." You could
then compare intent specs against each other (does the product
spec disagree with the PR spec?), against derivations (does the
code do what the spec says?), and against observations (do the
tests cover the intent?).

Jackson gives another way to look at this (see
[`concept-design.md`](../docs/internal/concept-design.md#prds-and-intent-specifications)):
a PRD or intent spec is a *top-down concept declaration indexed
to an audience*. It states a purpose, an operational principle,
state, actions, and a role. The same well-formedness failure
modes apply (fused purposes, non-terminating scenarios, state
invoked but not owned, missing audience). Forward (derive vs
spec), backward (spec vs derive), and lateral (spec vs spec for
different audiences) are three distinct analyses over one data
shape.

[`quality.md`](../docs/internal/quality.md) extends this: an intent spec that
says only what the feature *does* captures half the contract. A
fuller one says *how well*: error budget, acceptable latency,
edge-case handling, observability obligations. PRD-as-data
should carry quality specifications too, not capability
specifications alone.

### Arazzo workflows for cross-unit abstractions {#arazzo-workflows}

Arazzo describes multi-step API workflows as declared
artifacts. It could represent "functionality as code units
interacting over a bounded context", which is a concept cluster
in Jackson's terms, written down as an artifact we can compare
against. It probably relates to intent specs: an Arazzo workflow
is an intent spec for an operation that spans several endpoints.

### Audience annotation on summaries {#audience-annotation}

A tagging layer: which roles can observe this unit's OP? Some
audiences we can infer from the code (`/admin/` route prefix,
operator-only CLI, internal SDK package); others have to be
declared from outside. This unblocks a multi-audience feature
taxonomy and the "same behaviour, different OPs per audience"
case from
[`concept-design.md`](../docs/internal/concept-design.md#audience-indexing). It
also doubles as the index axis for
[`quality.md`](../docs/internal/quality.md#audience).

### Sync-chain identification / feature assembly {#sync-chains}

Today suss pairs providers with consumers, which gives two-node
edges. The next step is to compose those paired edges into named
chains, treat each chain as a candidate feature, and check it
against intent specs and Arazzo workflows. That is a direct
precursor to feature-level checking and to composite-quality
analysis, specifically the
[*how*-at-workflow-level facet](../docs/internal/quality.md#layer-1--impedance-quality-user-determined)
and [feature-level quality](../docs/internal/quality.md#aspirational-implications)
in the quality doc.

### Failure-mode detection {#failure-modes}

Heuristics over the shared-state graph for smeared / fused /
phantom concepts (see
[`concept-design.md`](../docs/internal/concept-design.md#failure-modes-of-bottom-up-derivation)):

- Smeared → many units sharing state lineage without a pairing
  binding between them.
- Fused → one unit whose transitions split into distinct
  sub-clusters by `subjects` lineage.
- Phantom → a unit whose OP terminates only in invocations of
  *other* units' actions, never in a role-observable outcome.

The signals are already in the IR, so turning them into findings
is an extension to the checker.

### Event / temporal / absence sync packs {#non-call-syncs}

Each of these needs a new `BoundarySemantics` variant (see
[`boundary-semantics.md`](/boundary-semantics)). The biggest
piece of work is that the IR has no notion of time, and pairing
on an event name works differently from the pairing suss has
shipped for in-process, HTTP, and GraphQL. This closes the reach
gap listed in
[`concept-design.md`](../docs/internal/concept-design.md#what-suss-can-and-cant-reach-yet).

### L2-shaped pattern packs {#l2-patterns}

From [`quality.md`](../docs/internal/quality.md#aspirational-implications):
recognise common resilience patterns (`retry`, `circuitBreaker`,
`withTimeout`, `fallback`) as framework-pack terminal or effect
matches, through the same interface as HTTP-status extraction.
When they're *absent* from a code unit whose role suggests they
should be present (an external API call with no timeout, a
handler with no error boundary), that's a finding we can derive.
It is the lowest-lift, highest-leverage operational-quality win.

### Observation adapters {#observation-adapters}

A stub that reads traces or production logs and emits
`BehavioralSummary`-shaped observation records at the same
boundaries. It lets `contractDisagreement`-style checks run
across spec / derivation / observation triples. It is the
foundation for the full epistemic split at the quality layer
(see [`quality.md`](../docs/internal/quality.md#epistemic)), not capabilities
alone.

### Trade-off annotations {#tradeoff-annotations}

A declared metadata layer ("this concept takes the consistency
side of the consistency/latency surface") that can be compared
against derived behaviour and observed behaviour. The hard part
is that the taxonomy of trade-off surfaces (see
[`quality.md`](../docs/internal/quality.md#trade-offs-as-named-surfaces)) has to be
stable and extensible before the annotations become useful.

## How to apply

When you design a new feature or extension point, check whether
it forecloses any of these, especially pack authoring tooling,
factory discovery, intent specs, audience tagging, and sync
chains. Prefer designs that leave room for them to land
additively.

The Jackson-grounded items (intent specs, Arazzo, audience
annotation, sync chains, failure modes, non-call syncs, L2
patterns, observation adapters, trade-off annotations) form one
arc. You can schedule them piecemeal, but it matters that you
understand them as related.
