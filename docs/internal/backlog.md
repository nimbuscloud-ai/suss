# Forward-looking backlog

Items flagged as "think about later" — not scheduled, but
referenced from the theory docs
([`concept-design.md`](concept-design.md),
[`quality.md`](quality.md)) as aspirational arcs the shipped
design should leave room for. This doc is the shared pointer
those references target.

Phase-scoped deferred items live in
[`status.md`](status.md#phase-8-real-world-readiness) under each
phase. This doc is for items that don't belong to one phase.

## Near-term engineering

### Pack maintenance across upstream version changes

As React / Express / OpenAPI / etc. evolve, patterns in packs go
stale. No story yet for: detecting that a pack targets an old
API, migrating patterns when an upstream renames or removes a
primitive, surfacing "this pack was written against ts-rest 3.x,
project uses 4.x." May need versioned packs, version-range
declarations in pack metadata, or runtime checks against imported
library versions.

### Pack authoring tooling

Writing a pack today requires reading the pack interface,
studying similar packs, and understanding the target framework.
Facilitating new-pack creation — by humans or LLMs — depends on
clear documentation and specification of the pattern vocabulary.
Good specs make AI-assisted pack scaffolding tractable; bad specs
make it impossible.

### Factory discovery for dynamic endpoint registration

Current discovery patterns (`registrationCall`, `namedExport`,
etc.) assume mostly static registration. Real codebases
frequently do `registerEndpoints(config)` where `config` is built
programmatically. Need a pattern for "this factory call spawns N
routes according to its argument."

## Dogfooding extensions

Primary dogfooding arc shipped (see
[`dogfooding.md`](dogfooding.md)). Remaining extensions, all
tracked as Phase 9 deferred in `status.md`:

- **Factory-return follow-through** — `createAdapter().extractAll()`-style
  methods reachable only through a returned object.
- **Member-call chain detection** on the consumer side — `adapter.extractAll()`
  and `Schema.parse()` aren't tracked; only bare-identifier calls are.
- **Namespace imports** — `import * as X from "pkg"` isn't scanned.
- **Pattern exports and conditional resolution** — `./utils/*` and
  `development` conditionals surface as warnings today.

## The Jackson arc (aspirational, framework-grounded)

Items below trace back to
[`concept-design.md`](concept-design.md) and
[`quality.md`](quality.md). They form one coherent arc, not
independent features — treat them that way when scheduling.

### Intent specification as a first-class data interface {#intent-specs}

A structured way to express *desired* behaviour: "this endpoint
should return 404 for deleted users, 200 otherwise." Compare
intent specs against each other (does the product spec disagree
with the PR spec?), against derivations (does the code do what
the spec says?), against observations (do the tests cover the
intent?).

Reframed via Jackson (see
[`concept-design.md`](concept-design.md#prds-and-intent-specifications)):
a PRD or intent spec is a *top-down concept declaration indexed
to an audience* — name purpose, operational principle, state,
actions, role. Same well-formedness failure modes apply (fused
purposes, non-terminating scenarios, state invoked but not
owned, missing audience). Forward (derive vs spec), backward
(spec vs derive), lateral (spec vs spec for different audiences)
are three distinct analyses on one data shape.

Extended by [`quality.md`](quality.md): an intent spec that names
only what the feature *does* captures half the contract. A
fuller one names *how well* — error budget, acceptable latency,
edge-case handling, observability obligations. PRD-as-data
should carry quality specifications as first-class too, not just
capability specifications.

### Arazzo workflows for cross-unit abstractions {#arazzo-workflows}

Arazzo describes multi-step API workflows as first-class
artifacts. Could represent "functionality as code units
interacting over a bounded context" — a concept cluster in
Jackson terms, materialised as a comparable artifact. Likely
relates to intent specs: an Arazzo workflow is an intent spec
for a multi-endpoint operation.

### Audience annotation on summaries {#audience-annotation}

A tagging layer: which role(s) is this unit's OP observable to?
Some audiences are inferable from code (`/admin/` route prefix,
operator-only CLI, internal SDK package); others need external
declaration. Unblocks multi-audience feature taxonomy and the
"same behaviour, different OPs per audience" case from
[`concept-design.md`](concept-design.md#audience-indexing).
Doubles as the index axis for
[`quality.md`](quality.md#audience).

### Sync-chain identification / feature assembly {#sync-chains}

Today suss pairs providers with consumers (two-node edges).
Next: compose paired edges into named chains, treat them as
candidate features, check them against intent specs / Arazzo
workflows. Direct precursor to feature-level checking and to
composite-quality analysis — specifically the
[*how*-at-workflow-level facet](quality.md#layer-1--impedance-quality-user-determined)
and [feature-level quality](quality.md#aspirational-implications)
in the quality doc.

### Failure-mode detection {#failure-modes}

Heuristics over the shared-state graph for smeared / fused /
phantom concepts (see
[`concept-design.md`](concept-design.md#failure-modes-of-bottom-up-derivation)):

- Smeared → many units sharing state lineage without a pairing
  binding between them.
- Fused → one unit whose transitions split cleanly into
  sub-clusters by `subjects` lineage.
- Phantom → a unit whose OP terminates only in invocations of
  *other* units' actions, never in a role-observable outcome.

Signals are already in the IR; turning them into findings is a
checker extension.

### Event / temporal / absence sync packs {#non-call-syncs}

Each needs a new `BoundarySemantics` variant (see
[`boundary-semantics.md`](/boundary-semantics)). Largest lift —
the IR has no temporal notion, and event-name-as-key pairing is
structurally different from the pairing suss has shipped for
in-process, HTTP, and GraphQL. Closes the reach gap listed in
[`concept-design.md`](concept-design.md#what-suss-can-and-cant-reach-yet).

### L2-shaped pattern packs {#l2-patterns}

From [`quality.md`](quality.md#aspirational-implications):
recognise common resilience patterns (`retry`, `circuitBreaker`,
`withTimeout`, `fallback`) as framework-pack terminal or effect
matches, same interface as HTTP-status extraction. When they're
*absent* from a code unit whose role suggests they should be
present (external API call with no timeout, handler with no
error boundary), that's a derivable finding. Lowest-lift,
highest-leverage operational-quality win.

### Observation adapters {#observation-adapters}

Stub that reads traces or production logs and emits
`BehavioralSummary`-shaped observation records at the same
boundaries. Lets `contractDisagreement`-style checks run across
spec / derivation / observation triples. Foundation for the full
epistemic split at the quality layer (see
[`quality.md`](quality.md#epistemic)), not just capabilities.

### Trade-off annotations {#tradeoff-annotations}

A declared metadata layer — "this concept takes the consistency
side of the consistency/latency surface" — that can be compared
against derived behaviour and observed behaviour. Hard part: the
taxonomy of trade-off surfaces (see
[`quality.md`](quality.md#trade-offs-as-first-class)) has to be
stable and extensible before annotations become useful.

## How to apply

When designing a new feature or extension point, check whether
it forecloses on any of these — especially pack authoring
tooling, factory discovery, intent specs, audience tagging, and
sync chains. Prefer designs that leave room for them to land
additively.

The Jackson-grounded items (intent specs, Arazzo, audience
annotation, sync chains, failure modes, non-call syncs, L2
patterns, observation adapters, trade-off annotations) form one
arc. Scheduling them piecemeal is fine; understanding them as
related is important.
