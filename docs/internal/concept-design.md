# Concept design as the theoretical ground

suss's structural decisions (code units as atoms, boundary
bindings as the connective tissue, `contractDisagreement` as the
place a violated purpose shows up) are easy to read as pragmatic
choices. They aren't. Underneath each one is Daniel Jackson's
concept-design framework (MIT). What follows maps the two onto each
other: what Jackson's framework says, where suss lines up with it,
where it diverges, and what territory the mapping opens up that we
haven't built yet.

The primary sources and the internal cross-references are in
[References](#references) at the end.

Scope note: this lives under `internal/` because it's theoretical
scaffolding and work we aspire to, not behaviour we ship. The
production-facing version of these ideas is in
[`contracts.md`](/contracts) (contract plurality) and
[`boundary-semantics.md`](/boundary-semantics) (the structural
model). Links below that leave for GitHub go to design records under
`design/`, which are proposals and working notes rather than
documentation.

## The core framework

A **concept** has three components:

- **Purpose**: one job it does. A concept with two purposes is
  really two concepts.
- **State**: private memory it owns. Nothing outside the concept
  reads or writes it directly.
- **Actions**: the only interface through which state changes.

One phrase is what makes independence enforceable: *actions are the
concept interface.* Nothing outside a concept can reach past its
action surface. A concept is self-contained.

You compose concepts with **synchronizations** (syncs), which are
external rules of the form:

> *when action A fires (optionally: and some state condition
> holds), fire action B*

Syncs never mutate state directly. They invoke actions, which
mutate state. Syncs can only restrict behaviour; they can never
enable new actions.

Composing concepts with syncs does **not** produce a super-concept.
Jackson's model is flat. The only unit above a concept is the app
itself: a set of concepts plus the syncs between them. There is
no concept hierarchy.

A **feature** is a workflow a user would recognise: a thread through
the sync graph that ends in an outcome some role can observe. A single
concept can itself *be* a feature, when its own operational
principle ends in such an outcome. A commenting concept whose last
action is "comment appears under the post" is immediately observable
to the end user, so the concept and the feature are the same thing.
A concept is *instrumental* rather than a feature when you can only
perceive its outcome through some other concept's behaviour. A
password concept succeeds silently, and the end user perceives that
only through the session concept letting them in.

### Audience indexing

Jackson's examples quietly assume one dominant role, the end user.
Once you have end users, administrators, developers consuming an
API, operators running the system, and other services as callers,
you have to say which role "observable" is observable to.

That refines the operational-principle test:

> A concept's operational principle must terminate in an outcome
> observable to *some identified role*, in that role's vocabulary.

This keeps the strict reading intact, since a purpose still has to
correspond to a mental model some role actually has, while admitting
that mental models are plural. That reshuffles the taxonomy:

- Rate limiter: invisible to end users, qualifies as a concept
  for operators.
- API key: invisible to end users, qualifies as a concept for
  developers.
- Audit log: invisible to end users, qualifies as a concept for
  compliance/admin roles.
- Upvote: qualifies as a concept for end users.

This still rules something out. Code that corresponds to no role's
mental model at all (a clever serialisation optimisation nobody
would have a word for) stays classified as a sync, or as
infrastructure the model doesn't represent.

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

First, a short primer on suss's vocabulary, so you can read the
mapping without going elsewhere. The full definitions are in
[`ir-reference.md`](/ir-reference) and
[`behavioral-summary-format.md`](/behavioral-summary-format).

- **Code unit**: one named, invocable thing in the source (a
  handler, a React component's render, a single event handler, a
  `useEffect`, a library function, a resolver). Each code unit
  produces exactly one `BehavioralSummary`. A file can contain
  many code units.
- **Transition**: one case within a code unit's behaviour, made of
  a conjunction of conditions plus the output and effects that
  follow when those conditions are true. A handler with three `if`
  guards and a fallback gives you four transitions. A transition is
  a *branch of a code unit's behaviour*, not a thing in its own
  right.
- **Subject**: a reference pulled out of a predicate or a value,
  which says what the code is reading (`params.id`,
  `db.findById()`, `context.user.email`). Following a subject's
  lineage is how suss traces shared state back to where it came
  from.
- **Boundary binding**: a three-layer description of where one
  code unit meets another: transport (`http`, `in-process`, …),
  semantics (`rest`, `function-call`, `graphql-resolver`, …), and
  recognition (which pack emitted it).

With that in hand, here is the corrected mapping:

| Jackson | suss |
|---|---|
| Concept | A *cluster* of code units whose transitions share a state lineage. A single code unit is a candidate concept when its state lineage doesn't spread beyond it, but a well-formed concept is usually the cluster rather than the unit. |
| Action | A **code unit**: the named, invocable thing whose invocation may change concept state. `createUser` is one action and `getUser` is another. |
| Case analysis of an action | The code unit's **transitions**. An action with three guard clauses and a fallback has four transitions. That's one action with four cases, not four actions. |
| State | The memory that lives behind a concept's actions: shared closures, hooks, module-scoped variables, external stores. The IR has no primitive for it. suss *infers* that it's there from subjects that trace across transitions back to a common origin. |
| Operational principle | A chain of actions threaded through shared state that ends in an outcome some role can observe. In suss terms, a path through the pairing graph where each step is a code unit invocation and each hand-off is a boundary binding with a predicate that refers to state. |
| Synchronization | There's no single IR object for this today. You *assemble* it from three pieces: (a) a transition of action A whose effects invoke another code unit, (b) an optional condition on that transition whose subject traces back to a second concept's state, and (c) the boundary binding that says where the call site is. Today suss emits (a) and (c) as edges you can find, and (b) as a subject reference. Putting them together into named syncs is the layer that's missing. |
| State condition in a sync | The **condition** part of the transition, restricted to predicates whose subjects trace back to a *different* concept's state. That's what tells internal case analysis apart from coordination between concepts, and it's what the `subjects` tree lets you inspect. |
| Feature | A *named* path through the sync graph: several actions and syncs composed into a workflow that some identified audience would recognise. suss has no representation of its own for this yet, though the pairing graph does contain the raw edges. |

Two things fit imperfectly, and the table can't show them:

- **Not every code unit is an action in Jackson's strict sense.**
  A React component's render projects state rather than changing
  it. suss still produces a summary for it, while Jackson's
  framework would classify it as observation machinery rather
  than as a concept's action. The framework fits tightest on
  handlers, event handlers, resolvers, and workers, which are the
  units that change state in response to outside input.
- **A transition is a branch of an action, not an action itself.**
  Earlier drafts of this mapping said "Jackson action ≈ suss
  transition," which is wrong, because it turns every `if` arm
  into its own concept. Read it this way instead: the code unit is
  the action, and the transition is where that action's case
  analysis lives, including the points where syncs to other actions
  can fire.

Every piece of a sync is already in suss's IR. What's missing
is the pairing layer that puts them together into named workflows.
suss pairs providers with consumers today, across the same
boundary, but it hasn't yet worked out *chains* across several
syncs.

## Where suss diverges from Jackson, on purpose

1. **Direction.** Jackson designs top-down from declared purposes.
   suss derives bottom-up from code, so a purpose is implicit and
   you have to reconstruct it. A `contractDisagreement` finding is
   the closest thing we have today to "purpose violated."
2. **Granularity.** Jackson treats a *concept* as the atomic
   design unit: you declare each concept whole, you define its
   actions and state together, and you draw its boundary up front.
   suss works one action at a time. It produces a summary per code
   unit and has no explicit concept boundary. Here is how the two
   reconcile: a suss unit is one action, a *cluster* of units that
   share a state lineage is the candidate concept, and the OP test
   sorts the well-formed concepts from the fused or smeared ones.
   suss infers concept boundaries rather than being told them.
3. **Infrastructure.** Jackson rules infrastructure out by fiat,
   putting it outside the model. suss can't rule it out. The
   strict reading survives once you admit plural audiences: either
   code qualifies as a concept for *some* identified role, or it's
   a sync, or it's infrastructure the model doesn't represent.
4. **Opacity.** Jackson assumes a fully resolved model. suss
   labels what it couldn't resolve (opaque predicates, unresolved
   subjects) and passes those labels up to the sync level, so you
   can tell a sync exists without resolving the state condition
   that gates it.
5. **Completeness.** Jackson's model is closed. suss's derivation
   leaves some code unclassified, and how much it leaves is itself
   a signal about how much of the codebase is coordination rather
   than purpose.
6. **Reach.** Syncs mediated by a call, gated on state, or
   crossing a boundary all map fully. Syncs built on event
   subscription, on temporal ordering, on absence, or on an opaque
   gate either escape extraction altogether or come out partial
   (see §What suss can't reach yet).

## Failure modes of bottom-up derivation

Deriving concepts from code turns the identification problem
around. You don't start from purposes. You start from code units
(handlers, components, resolvers) and reconstruct the concepts
from their behaviour. Expect three ways that goes wrong:

- **Smeared concepts**: one concept's behaviour scattered across
  many code units. Authentication lives partly in middleware,
  partly in a login handler, and partly in a session hook. No
  single code unit corresponds to it.
- **Fused concepts**: one code unit implementing several concepts
  at once. A User handler that mixes Profile, Session, and
  Permissions. Its behavioural summary shows transitions that are
  really governed by different purposes.
- **Phantom concepts**: code units that look like concepts but are
  really syncs (logging, retry, caching, rate limiting). They have
  no user-visible purpose of their own. They coordinate other
  concepts.

Detecting these is something we aspire to. We already have signals
that could feed the detection:

- Smearing → many units whose `subjects` trace back to a shared
  state lineage without a pairing binding between them.
- Fusion → one unit whose transitions split into separate
  sub-clusters by `subjects` lineage (several families of state in
  one summary).
- Phantom → a unit whose OP only ever ends in invocations of
  *other* units' actions, never in an outcome a role can observe.

None of this exists today. It's the form future heuristics could
take.

## What suss can and can't reach yet

Maps fully:

- **Call-mediated syncs**: one unit's transition invokes another
  (provider and consumer paired by boundary). Shipped.
- **State-conditioned syncs**: a predicate that references another
  unit's state gates the invocation, and you can trace it through
  `subjects`. Partial: the adapter resolves intermediate subjects
  up to depth 8.
- **Cross-boundary syncs**: HTTP, GraphQL, function-call, React
  render. Shipped (React is still being filled in; see
  the [status design record](https://github.com/nimbuscloud-ai/suss/blob/main/design/status.md), Phase 9 and the React
  phases).

Maps partially or not at all:

- **Event-subscription syncs**: `emitter.on(event, handler)`,
  `eventTarget.addEventListener`, and Pub/Sub style. You can see
  both the registration site and the handler site, but the
  *connection* between them is an event-name string, and the IR
  has no boundary variant for that.
- **Temporal-ordering syncs**: "X must happen before Y" or "retry
  after N minutes." suss extracts nothing about time. It reads
  structure, not history.
- **Absence syncs**: "if X *didn't* fire within a window, do Y."
  This runs into the same limitation as temporal syncs.
- **Opaque-gated syncs**: the sync is there, but the state
  condition is an opaque predicate. We can tell the sync exists
  without resolving what gates it. That's a ceiling on precision
  rather than a blind spot, and reducing opaqueness at the
  extraction layer compounds, because every analysis at the sync
  level inherits the precision.

## PRDs and intent specifications

Structurally, a PRD or a feature description is a **top-down
concept declaration written for a specified audience**. A
well-formed PRD says:

- **Purpose**: the one job the feature does for the target user.
- **Operational principle**: a scenario (user does X, system
  responds Y, user observes Z).
- **State**: what the system tracks on the user's behalf.
- **Actions**: the interface the user interacts through.
- **Role / audience**: who this is for, in their vocabulary.

When a PRD comes across as confused, one of those dimensions is
usually broken:

- Two purposes stapled together (a fused concept, at the level of
  the spec).
- A scenario thread that never ends in an outcome some role can
  observe (a phantom concept, so probably infrastructure or a sync
  dressed up as a feature).
- State the feature uses but doesn't own. It belongs to a
  different concept, so the PRD is specifying a sync without
  saying so.
- No audience (Jackson's implicit-user trap), so it's unclear
  whose mental model "observable" is evaluated against.

The same failure modes that bite bottom-up derivation bite
top-down specification too, which suggests PRDs and summaries
relate to each other in both directions:

- **Forward**: a structured PRD is an intent spec. Compare it
  against derived summaries and it answers "does the code do what
  the spec says?"
- **Backward**: derived summaries are candidate concepts. Compare
  them against a PRD and they answer "is there a well-formed
  concept here, or did we ship fused, smeared, or phantom code?"
- **Lateral**: several intent specs (a product PRD, an engineering
  design doc, a test plan, a support runbook) are concept
  declarations for *different audiences*. When they disagree,
  that's signal, not noise.

suss has none of this today. The nearest thing on the backlog is
[intent specs as a structured data
interface](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#intent-specs). Under the Jackson mapping,
an intent spec is a concept declaration, and you can evaluate it
under the same OP test that classifies derived summaries.

See also: [Arazzo workflows](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#arazzo-workflows).
Arazzo describes multi-step API workflows as declared
artifacts. In this framing, an Arazzo workflow is a **feature
specification**: a declared chain of syncs across concepts. It's
the closest existing standard to "PRD as data."

## Aspirational implications

These are ordered by how much work each one takes against how much
the value compounds:

1. **Opacity reduction keeps compounding.** Every gain in extraction
   precision (breaking predicates down, resolving subjects through
   wrappers, following a factory's return value) travels upward to
   sync detection, OP assembly, and PRD comparison. Cheap wins
   here give the most leverage across every analysis downstream.
2. **Audience annotation on summaries.** A tagging layer over
   derived summaries, saying which roles can observe this unit's
   OP. You can infer some roles from the code (an `/admin/` route
   prefix, a CLI only operators use, an internal SDK package), and
   somebody has to declare the rest. This unblocks a
   multi-audience taxonomy of features.
3. **Multi-audience OPs.** When a concept serves several
   audiences, its behaviour is identical but its OP differs from
   audience to audience. The open question: one summary with
   several OP annotations, or N summaries, one per audience?
4. **Sync-chain identification.** Today we pair summaries, which
   gives us two-node edges. The next step is to compose those
   paired edges into chains, name each chain as a candidate
   feature, and check them against PRDs and Arazzo workflows.
5. **Failure-mode detection.** Heuristics for smeared, fused, and
   phantom concepts over the shared-state graph. The signals are
   already there (`subjects` lineage, where an OP ends, transitions
   that only sync), and turning them into findings is a checker
   extension.
6. **Event / temporal / absence sync packs.** Each one needs a new
   `BoundarySemantics` variant. This is probably the most work of
   any of these: the IR knows nothing about ordering in time
   today, and pairing on an event name is structurally different
   from the pairing suss has shipped for in-proc, HTTP, and
   GraphQL.

## Open threads

The framework leaves two questions open for suss:

1. **Where do audiences come from?** You can infer some of them
   (a route prefix, a CLI namespace, how an SDK package is named)
   and somebody has to supply the rest, because some distinctions
   live only in convention. Inference alone will miss the
   audience boundaries that nothing in the code marks.
2. **A concept serving several audiences: one summary or
   several?** The behaviour is identical and the OP differs per
   audience. Both options cost something. N summaries multiplies
   the pairing problem, and one summary with N annotations pushes
   the complexity into whatever renders or consumes it.

Neither needs an answer yet. We write both down so that the
options don't quietly disappear when audience work gets scheduled.

## References

Primary sources:

- Daniel Jackson, [*The Essence of Software: Why Concepts Matter
  for Great Design*](https://essenceofsoftware.com/) (Princeton
  University Press, 2021), a book-length treatment of the
  framework. Companion site at
  [essenceofsoftware.com](https://essenceofsoftware.com/).
- Daniel Jackson, [*Concept Design
  Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf)
  (NASA Formal Methods, 2022), which sets out the split/merge,
  unify/specialize, and tighten/loosen design moves over
  concepts. [Springer
  chapter](https://link.springer.com/chapter/10.1007/978-3-031-06773-0_3).
- Eagon Meng and Daniel Jackson, [*What You See Is What It Does:
  A Structural Pattern for Legible
  Software*](https://arxiv.org/abs/2508.14511) (SPLASH Onward!,
  2025), which makes the structural-pattern argument. Its framing,
  where concepts are independent and a sync is a separate rule, is
  the one we adopt most directly here. [Conference
  page](https://2025.splashcon.org/details/splash-2025-Onward-papers/14/What-You-See-Is-What-It-Does-A-Structural-Pattern-for-Legible-Software).
- Daniel Jackson's [CSAIL
  homepage](https://people.csail.mit.edu/dnj/) and the [MIT
  Software Design Group](https://sdg.csail.mit.edu/project/conceptual/)
  for the broader publication list.

Internal cross-references:

- [`contracts.md`](/contracts): the multi-shape contract taxonomy
  (shipped product framing of Jackson's plurality insight).
- [`boundary-semantics.md`](/boundary-semantics): the three-layer
  transport / semantics / recognition model (structural
  counterpart to sync semantics).
- [The backlog design record](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md): forward-looking items grounded in
  this framework (intent specs, Arazzo workflows, audience
  annotation, sync-chain identification, failure-mode detection,
  non-call sync packs).
