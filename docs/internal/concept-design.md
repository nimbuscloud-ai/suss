# Concept design as the theoretical ground

suss's structural decisions — code units as atoms, boundary
bindings as the connective tissue, `contractDisagreement` as the
purpose-violation surface — are easy to read as pragmatic choices.
They aren't. Underneath each one is Daniel Jackson's concept-design
framework (MIT). This doc is the internal map between the two:
what Jackson's framework says, where suss maps cleanly, where it
diverges, and what aspirational territory the mapping opens up.

Primary sources and internal cross-references live in
[References](#references) at the end.

Scope note: this sits under `internal/` because it's theoretical
scaffolding and aspirational work, not shipped behaviour. The
production-facing version of these ideas lives in
[`contracts.md`](/contracts) (contract plurality) and
[`boundary-semantics.md`](/boundary-semantics) (the structural
model).

## The core framework

A **concept** has three components:

- **Purpose** — one job it does. A concept with two purposes is
  really two concepts.
- **State** — private memory it owns. Nothing outside the concept
  reads or writes it directly.
- **Actions** — the only interface through which state changes.

The phrase that makes independence enforceable: *actions are the
concept interface.* Nothing outside a concept can reach past its
action surface. A concept is self-contained.

Concepts are composed by **synchronizations** (syncs), which are
external rules shaped as:

> *when action A fires (optionally: and some state condition
> holds), fire action B*

Syncs never mutate state directly. They invoke actions, which
mutate state. Syncs can only restrict behaviour; they can never
enable new actions.

Composing concepts with syncs does **not** produce a super-concept.
Jackson's model is flat. The only unit above a concept is the app
itself — a set of concepts plus the syncs between them. There is
no concept hierarchy.

A **feature** is a user-recognisable workflow: a thread through
the sync graph ending in a role-observable outcome. A single
concept can itself *be* a feature when its own operational
principle terminates in such an outcome — a commenting concept
whose last action is "comment appears under the post" is
immediately observable to the end user, so concept and feature
coincide. A concept is *instrumental* rather than a feature when
its outcome only becomes perceivable through another concept's
behaviour — a password concept's success is silent; the end
user perceives it only through the session concept letting them
in.

### Audience indexing

Jackson's examples silently assume a single dominant role (the
end user). Once you have end users, administrators, developers
consuming an API, operators running the system, and other services
as callers, "observable" must be indexed to a role.

Refined operational-principle test:

> A concept's operational principle must terminate in an outcome
> observable to *some identified role*, in that role's vocabulary.

This keeps the strict read intact — purpose must correspond to a
real mental model somewhere — while admitting mental models are
plural. Reshuffled taxonomy:

- Rate limiter — invisible to end users, qualifies as a concept
  for operators.
- API key — invisible to end users, qualifies as a concept for
  developers.
- Audit log — invisible to end users, qualifies as a concept for
  compliance/admin roles.
- Upvote — qualifies as a concept for end users.

What's ruled out: code that corresponds to no role's mental model
at all (a clever serialisation optimisation no role would name)
stays classified as a sync or as infrastructure the model doesn't
represent.

Two consequences:

- A concept can serve multiple audiences with the *same*
  behaviour but *different* operational principles. Payment is
  terminal for an end user (they paid), instrumental for an admin
  (input to reconciliation), observable differently for an operator
  (volume, latency).
- Features partition the same way. "Commenting on posts" is a
  feature for end users; "rate-limit dashboard" is a feature for
  operators. Both are workflows built from concepts in their
  respective audience's vocabulary.

## Mapping Jackson → suss

A brief primer on suss's vocabulary, so the mapping reads
cleanly. Full definitions in [`ir-reference.md`](/ir-reference)
and [`behavioral-summary-format.md`](/behavioral-summary-format).

- **Code unit** — one named, invocable thing in the source: a
  handler, a React component's render, a single event handler, a
  `useEffect`, a library function, a resolver. Each code unit
  produces exactly one `BehavioralSummary`. A file can contain
  many code units.
- **Transition** — one case within a code unit's behaviour: a
  conjunction of conditions plus the output / effects that follow
  when those conditions hold. A handler with three `if` guards
  and a fallback yields four transitions. Transitions are
  *branches of a code unit's behaviour*, not independent things.
- **Subject** — a reference extracted from a predicate or value
  that names the thing the code is reading (`params.id`,
  `db.findById()`, `context.user.email`). Subject lineage is how
  suss traces shared state back to its origin.
- **Boundary binding** — three-layer description of where one
  code unit meets another: transport (`http`, `in-process`, …),
  semantics (`rest`, `function-call`, `graphql-resolver`, …),
  recognition (which pack emitted it).

With that in hand, the corrected mapping:

| Jackson | suss |
|---|---|
| Concept | A *cluster* of code units whose transitions share a state lineage. A single code unit is a concept candidate when its state lineage doesn't spread beyond it; a well-formed concept is usually the cluster, not the unit. |
| Action | A **code unit** — the named, invocable thing whose invocation may change concept state. `createUser` is one action; `getUser` is another. |
| Case analysis of an action | The code unit's **transitions**. An action with three guard clauses and a fallback has four transitions — one action, four cases, not four actions. |
| State | The memory that lives behind a concept's actions — shared closures, hooks, module-scoped variables, external stores. Not directly first-class in the IR; its presence is *inferred* from subjects that trace across transitions to a common origin. |
| Operational principle | A chain of actions threaded through shared state, terminating in a role-observable outcome. In suss terms: a path through the pairing graph where each step is a code unit invocation and each hand-off is a boundary binding with a state-referring predicate. |
| Synchronization | Not a single IR object today — it's *assembled* from three pieces: (a) a transition of action A whose effects invoke another code unit, (b) an optional condition on that transition whose subject traces to a second concept's state, (c) the boundary binding that names the call site. Today suss emits (a) and (c) as findable edges and (b) as a subject reference; composing them into named syncs is the missing layer. |
| State condition in a sync | The transition's **condition** component, restricted to predicates whose subjects trace to a *different* concept's state. This is what distinguishes internal case-analysis from cross-concept coordination, and it's what the `subjects` tree makes inspectable. |
| Feature | A *named* path through the sync graph — multiple actions and syncs composed into a workflow recognisable to an identified audience. No first-class representation in suss yet; the pairing graph contains the raw edges. |

Two notes on imperfect fit that the table can't show:

- **Not every code unit is an action in Jackson's strict sense.**
  A React component's render is a *state projection*, not a state
  change. suss still produces a summary for it; Jackson's
  framework would classify it as observation machinery rather
  than a concept's action. The framework fits tightest on
  handlers / event handlers / resolvers / workers — units that
  invoke state change on external input.
- **A transition is a branch of an action, not an action itself.**
  Earlier drafts of this mapping wrote "Jackson action ≈ suss
  transition," which is off — that reading turns every `if` arm
  into its own concept. The cleaner reading: the code unit is the
  action, and the transition is where that action's case analysis
  lives, including the points where syncs to other actions can
  fire.

Every component of a sync is already in suss's IR. What's missing
is the pairing layer that assembles them into named workflows —
suss pairs providers with consumers today (same boundary), but
hasn't yet identified *chains* across multiple syncs.

## Where suss diverges from Jackson — on purpose

1. **Direction.** Jackson designs top-down with declared purposes.
   suss derives bottom-up from code, so purpose is implicit and
   must be reconstructed. `contractDisagreement` findings are the
   closest extant proxy for "purpose violated."
2. **Granularity.** Jackson treats *concepts* as the atomic
   design unit — each concept declared whole, its actions and
   state defined together, its boundary drawn up-front. suss
   works one action at a time: it produces a summary per code
   unit and has no explicit concept boundary. The reconciliation:
   a suss unit is one action; a *cluster* of units sharing state
   lineage is the concept candidate; the OP test sorts well-formed
   concepts from fused or smeared ones. Concept boundaries are
   inferred, not declared.
3. **Infrastructure.** Jackson excludes infrastructure by fiat —
   it's outside the model. suss can't exclude it. The strict read
   survives by admitting plural audiences: code qualifies as a
   concept for *some* identified role, or it's a sync / model-
   unrepresented infrastructure.
4. **Opacity.** Jackson assumes a clean model. suss treats opacity
   as labelled data (opaque predicates, unresolved subjects) and
   propagates it to the sync level — you can detect a sync exists
   without resolving its state-condition component.
5. **Completeness.** Jackson's model is closed. suss's derivation
   leaves code unclassified, and that unclassified portion is
   itself signal about how much of the codebase is coordination
   rather than purpose.
6. **Reach.** Call-mediated, state-conditioned, and cross-boundary
   syncs map cleanly. Event-subscription syncs, temporal-ordering
   syncs, absence syncs, and opaque-gated syncs either escape
   extraction or appear partial (see §What suss can't reach yet).

## Failure modes of bottom-up derivation

Deriving concepts from code inverts the identification problem.
You're not starting from purposes; you're starting from code units
(handlers, components, resolvers) and reconstructing concepts
from behaviour. Three failure modes to expect:

- **Smeared concepts** — one concept's behaviour scattered across
  many code units. Authentication lives partly in middleware,
  partly in a login handler, partly in a session hook. No single
  code unit corresponds to it.
- **Fused concepts** — one code unit implementing several concepts
  at once. A User handler that mixes Profile, Session, and
  Permissions. Behavioural summary shows transitions really
  governed by different purposes.
- **Phantom concepts** — code units that look concept-shaped but
  are actually syncs: logging, retry, caching, rate-limiting.
  They don't have independent user-visible purpose; they
  coordinate other concepts.

Detecting these is aspirational. Signals we already have that
could feed detection:

- Smearing → many units whose `subjects` trace to a shared state
  lineage without a pairing binding between them.
- Fusion → one unit whose transitions split cleanly into
  sub-clusters by `subjects` lineage (different state families in
  one summary).
- Phantom → a unit whose OP terminates only in invocations of
  *other* units' actions, never in a role-observable outcome.

None of this exists today. It's the shape future heuristics
could take.

## What suss can and can't reach yet

Maps cleanly:

- **Call-mediated syncs** — one unit's transition invokes another
  (provider/consumer pairing by boundary). Shipped.
- **State-conditioned syncs** — the invocation is gated by a
  predicate that references another unit's state, traceable via
  `subjects`. Partial — the adapter resolves intermediate subjects
  up to depth 8.
- **Cross-boundary syncs** — HTTP, GraphQL, function-call, React
  render. Shipped (React still filling in; see
  [`status.md`](status) Phase 9 + React phases).

Maps partially or not at all:

- **Event-subscription syncs** — `emitter.on(event, handler)` /
  `eventTarget.addEventListener` / Pub/Sub style. The registration
  site and the handler site are both visible, but the *connection*
  between them lives in an event-name string that the IR has no
  boundary variant for.
- **Temporal-ordering syncs** — "X must happen before Y" or "retry
  after N minutes." suss extracts no temporal semantics; it reads
  structure, not history.
- **Absence syncs** — "if X *didn't* fire within a window, do Y."
  Same root limitation as temporal syncs.
- **Opaque-gated syncs** — the sync exists, but the state-condition
  component is an opaque predicate. We can detect the sync exists
  without resolving what gates it. This is a sharpness ceiling,
  not a blind spot — reducing opaqueness at the extraction layer
  has compounding value, since every sync-level analysis inherits
  the sharpness.

## PRDs and intent specifications

PRDs and feature descriptions are, structurally, **top-down
concept declarations indexed to a specified audience**. A
well-formed PRD names:

- **Purpose** — the one job the feature does for the target user.
- **Operational principle** — a scenario: user does X, system
  responds Y, user observes Z.
- **State** — what the system tracks on the user's behalf.
- **Actions** — the interface the user interacts through.
- **Role / audience** — who this is for, in their vocabulary.

When a PRD reads as confused, it's usually one of these dimensions
that's broken:

- Two purposes stapled together (fused concept at the spec level).
- Scenario thread that never terminates in a role-observable
  outcome (phantom concept — likely infrastructure or a sync
  masquerading as a feature).
- State invoked but not owned — belongs to a different concept;
  the PRD is specifying a sync without saying so.
- Missing audience (Jackson's implicit-user trap) — unclear whose
  mental model "observable" is evaluated against.

The same failure modes that bite bottom-up derivation bite
top-down specification. Which suggests a two-way relationship
between PRDs and summaries:

- **Forward** — a structured PRD is an intent spec. Compared
  against derived summaries, it answers "does the code do what
  the spec says?"
- **Backward** — derived summaries are candidate concept-shapes.
  Compared against a PRD, they answer "is there a real concept
  here, or did we ship fused / smeared / phantom code?"
- **Lateral** — multiple intent specs (product PRD, engineering
  design doc, test plan, support runbook) are concept declarations
  for *different audiences*. Disagreement between them is a
  real signal, not noise.

Today suss has none of this. The closest adjacent item in the
backlog is [intent specs as a first-class data
interface](backlog.md#intent-specs). The Jackson mapping
reframes that item: an intent spec isn't just a declared shape
to compare against — it's a concept declaration, evaluable
under the same OP test that classifies derived summaries.

See also: [Arazzo workflows](backlog.md#arazzo-workflows) —
Arazzo describes multi-step API workflows as first-class
artifacts. In this
framing, an Arazzo workflow is a **feature specification**: a
declared sync chain across concepts. It's the closest existing
standard to "PRD as data."

## Aspirational implications

Ordered by how much lift each requires versus the compounding
value:

1. **Opacity reduction keeps compounding.** Every step of extraction
   sharpening (predicate decomposition, subject resolution through
   wrappers, factory-return follow-through) propagates upward to
   sync detection, OP assembly, and PRD comparison. Cheap wins
   here have the highest leverage across every downstream
   analysis.
2. **Audience annotation on summaries.** A tagging layer on
   derived summaries: role(s) for which this unit's OP is
   observable. Some roles are inferable from code (an `/admin/`
   route prefix, an operator-only CLI, an internal SDK package).
   Others need external declaration. Unblocks multi-audience
   feature taxonomy.
3. **Multi-audience OPs.** When a concept serves multiple
   audiences, the behaviour is identical but the OP differs per
   audience. Open question: one summary with multiple OP
   annotations, or N summaries, one per audience?
4. **Sync-chain identification.** Pair summaries today (2-node
   edges). Next step: compose paired edges into chains, name them
   as candidate features, check them against PRDs / Arazzo
   workflows.
5. **Failure-mode detection.** Smeared / fused / phantom heuristics
   over the shared-state graph. Signals exist (`subjects` lineage,
   OP terminus, sync-only transitions); turning them into findings
   is a checker extension.
6. **Event / temporal / absence sync packs.** Each needs a new
   `BoundarySemantics` variant. Likely the largest lift — the IR
   has no notion of temporal ordering today, and event-name-as-key
   pairing is structurally different from the pairing suss has
   shipped for in-proc + HTTP + GraphQL.

## Open threads

Two questions the framework doesn't answer for suss:

1. **Where do audiences come from?** Partly inferable (route
   prefix, CLI namespace, SDK package naming), partly external
   (convention-only distinctions). Pure inference will miss
   audience boundaries that exist only in convention.
2. **Multi-audience concept, one summary or several?** Behaviour
   is identical, OP differs per audience. Both options have
   costs — N summaries multiplies the pairing problem; one
   summary with N annotations pushes complexity into rendering /
   consumer tooling.

Neither needs an answer yet. Recording both so the option space
doesn't collapse silently when audience work gets scheduled.

## References

Primary sources:

- Daniel Jackson, [*The Essence of Software: Why Concepts Matter
  for Great Design*](https://essenceofsoftware.com/) (Princeton
  University Press, 2021) — book-length treatment of the
  framework. Companion site at
  [essenceofsoftware.com](https://essenceofsoftware.com/).
- Daniel Jackson, [*Concept Design
  Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf)
  (NASA Formal Methods, 2022) — the split/merge, unify/specialize,
  tighten/loosen design moves over concepts. [Springer
  chapter](https://link.springer.com/chapter/10.1007/978-3-031-06773-0_3).
- Eagon Meng and Daniel Jackson, [*What You See Is What It Does:
  A Structural Pattern for Legible
  Software*](https://arxiv.org/abs/2508.14511) (SPLASH Onward!,
  2025) — the structural pattern argument; the independence +
  sync-as-separate-rule framing is the one most directly adopted
  here. [Conference
  page](https://2025.splashcon.org/details/splash-2025-Onward-papers/14/What-You-See-Is-What-It-Does-A-Structural-Pattern-for-Legible-Software).
- Daniel Jackson's [CSAIL
  homepage](https://people.csail.mit.edu/dnj/) and the [MIT
  Software Design Group](https://sdg.csail.mit.edu/project/conceptual/)
  for the broader publication list.

Internal cross-references:

- [`contracts.md`](/contracts) — the multi-shape contract taxonomy
  (shipped product framing of Jackson's plurality insight).
- [`boundary-semantics.md`](/boundary-semantics) — the three-layer
  transport / semantics / recognition model (structural
  counterpart to sync semantics).
- [`backlog.md`](backlog.md) — forward-looking items grounded in
  this framework (intent specs, Arazzo workflows, audience
  annotation, sync-chain identification, failure-mode detection,
  non-call sync packs).
