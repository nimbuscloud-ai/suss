# Concept design as the theoretical ground

suss's structural decisions look like practical choices: code units as
the smallest pieces, boundary bindings connecting them, and
`contractDisagreement` as the place a violated purpose shows up. Each
of them is grounded in Daniel Jackson's concept-design framework
(MIT). Below, the two are mapped onto each other: what Jackson's
framework says, where suss matches it, where it differs, and what the
mapping opens up that we haven't built yet.

The primary sources and the internal cross-references are listed under
[References](#references) at the end.

Scope note: this is a design record because it is theory and future
work, and none of it describes behaviour we ship. The version of these
ideas in the product docs is in
[Kinds of contract](../docs/why/kinds-of-contract.md) (why contracts
come in several forms) and
[Boundary semantics](../docs/theory/boundary-semantics.md) (the
structural model). The one-paragraph summary for readers of the
documentation is in [Prior art](../docs/theory/prior-art.md). Links
below that go to GitHub point at design records under `design/`. Those
are proposals and working notes, and they are not documentation.

## The core framework

A **concept** has three parts:

- **Purpose**: the one job it does. A concept with two purposes is
  two concepts.
- **State**: private memory it owns. Nothing outside the concept
  reads or writes it directly.
- **Actions**: the only interface through which its state changes.

One phrase makes independence enforceable: *actions are the concept
interface.* Nothing outside a concept can reach past its actions. A
concept is self-contained.

You compose concepts with **synchronizations** (syncs). A sync is an
external rule of the form:

> *when action A fires (optionally: and some state condition
> holds), fire action B*

Syncs never change state directly. They invoke actions, and the
actions change state. Syncs can only restrict behaviour. They can
never enable new actions.

Composing concepts with syncs does **not** produce a larger concept.
Jackson's model is flat. The only thing above a concept is the app
itself, which is a set of concepts plus the syncs between them. There
is no hierarchy of concepts.

A **feature** is a workflow a user would recognise. It is a path
through the sync graph that ends in an outcome some role can observe.
A single concept can itself *be* a feature, when its own operational
principle ends in such an outcome. Take a commenting concept whose
last action is "comment appears under the post". The end user sees
that immediately, so the concept and the feature are the same thing.
A concept is *instrumental*, and not a feature, when you can only
perceive its outcome through some other concept's behaviour. A
password concept succeeds silently, and the end user only notices it
because the session concept lets them in.

### Audience indexing

Jackson's examples quietly assume one main role, the end user. Once
you have end users, administrators, developers using an API,
operators running the system, and other services calling it, you have
to say which role "observable" means observable to.

That refines the test on the operational principle:

> A concept's operational principle must terminate in an outcome
> observable to *some identified role*, in that role's vocabulary.

The strict reading still applies, because a purpose still has to match
a mental model some role actually has. But the refinement accepts that
there are several mental models. That rearranges the taxonomy:

- Rate limiter: invisible to end users, but a concept for operators.
- API key: invisible to end users, but a concept for developers.
- Audit log: invisible to end users, but a concept for compliance and
  admin roles.
- Upvote: a concept for end users.

This still rules something out. Code that matches no role's mental
model at all, such as a clever serialisation optimisation nobody would
have a word for, is still classified as a sync or as infrastructure
the model doesn't represent.

Two consequences follow:

- A concept can serve several audiences with the *same* behaviour but
  *different* operational principles. Payment ends in an outcome for
  an end user (they paid). For an admin it is instrumental, an input
  to reconciliation. An operator observes it differently again,
  through volume and latency.
- Features split the same way. "Commenting on posts" is a feature for
  end users, and a "rate-limit dashboard" is a feature for operators.
  Both are workflows built from concepts in the vocabulary of their
  own audience.

## Mapping Jackson → suss

First, a short primer on suss's vocabulary, so you can read the
mapping without going elsewhere. The full definitions are in
[IR types](../docs/reference/ir.md) and
[Summary format](../docs/reference/summary-format.md).

- **Code unit**: one named thing in the source that can be invoked,
  such as a handler, a React component's render, a single event
  handler, a `useEffect`, a library function or a resolver. Each code
  unit produces exactly one `BehavioralSummary`, and a file can
  contain many code units.
- **Transition**: one case in a code unit's behaviour. It is a set of
  conditions that all hold, plus the output and effects that follow
  when they do. A handler with three `if` guards and a fallback has
  four transitions. A transition is a *branch of a code unit's
  behaviour*, and it does not stand on its own.
- **Subject**: a reference taken from a predicate or a value, which
  says what the code is reading (`params.id`, `db.findById()`,
  `context.user.email`). suss traces shared state back to where it
  came from by following a subject's lineage.
- **Boundary binding**: a description in three layers of where one
  code unit meets another. The layers are transport (`http`,
  `in-process`, …), semantics (`rest`, `function-call`,
  `graphql-resolver`, …), and recognition (which pack emitted it).

With that, here is the corrected mapping:

| Jackson | suss |
|---|---|
| Concept | A *cluster* of code units whose transitions share a state lineage. A single code unit is a candidate concept when its state lineage doesn't spread beyond it, but a well-formed concept is usually the cluster and not the unit. |
| Action | A **code unit**: the named thing that can be invoked, and whose invocation may change the concept's state. `createUser` is one action and `getUser` is another. |
| Case analysis of an action | The code unit's **transitions**. An action with three guard clauses and a fallback has four transitions. That is one action with four cases, and not four actions. |
| State | The memory behind a concept's actions: shared closures, hooks, module-scoped variables, external stores. The IR has no primitive for it. suss *infers* that it's there from subjects that trace across transitions back to a common origin. |
| Operational principle | A chain of actions linked through shared state that ends in an outcome some role can observe. In suss terms, it is a path through the pairing graph where each step is a code unit invocation and each hand-off is a boundary binding with a predicate that refers to state. |
| Synchronization | No single IR object represents this today. You *assemble* it from three pieces: (a) a transition of action A whose effects invoke another code unit, (b) an optional condition on that transition whose subject traces back to a second concept's state, and (c) the boundary binding that says where the call site is. Today suss emits (a) and (c) as edges you can find, and (b) as a subject reference. The layer that combines them into named syncs is missing. |
| State condition in a sync | The **condition** part of the transition, limited to predicates whose subjects trace back to a *different* concept's state. That is what separates case analysis inside a concept from coordination between concepts, and the `subjects` tree lets you inspect it. |
| Feature | A *named* path through the sync graph: several actions and syncs composed into a workflow that some identified audience would recognise. suss has no representation of its own for this yet, though the pairing graph does contain the raw edges. |

Two things don't fit neatly, and the table can't show them:

- **Not every code unit is an action in Jackson's strict sense.** A
  React component's render displays state and does not change it.
  suss still produces a summary for it, but Jackson's framework would
  classify it as machinery for observing and not as a concept's
  action. The framework fits best on handlers, event handlers,
  resolvers and workers, which are the units that change state in
  response to outside input.
- **A transition is a branch of an action, and not an action itself.**
  Reading the mapping as "Jackson action ≈ suss transition" is wrong,
  because it turns every `if` arm into its own concept. Read it this
  way instead: the code unit is the action, and its transitions are
  where that action's case analysis lives, including the points where
  syncs to other actions can fire.

Every piece of a sync is already in suss's IR. What's missing is the
pairing layer that combines them into named workflows. suss pairs
providers with consumers today, across one boundary at a time, but it
doesn't yet work out *chains* across several syncs.

## Where suss diverges from Jackson, on purpose

1. **Direction.** Jackson designs top-down from declared purposes.
   suss derives bottom-up from code, so a purpose is implicit and has
   to be reconstructed. A `contractDisagreement` finding is the
   closest thing we have today to "purpose violated."
2. **Granularity.** Jackson treats a *concept* as the smallest design
   unit. You declare each concept whole, define its actions and state
   together, and draw its boundary up front. suss works one action at
   a time. It produces a summary per code unit and has no explicit
   concept boundary. The two fit together like this: a suss unit is
   one action, a *cluster* of units that share a state lineage is the
   candidate concept, and the OP test separates well-formed concepts
   from fused or smeared ones. suss infers concept boundaries, and
   nobody tells it where they are.
3. **Infrastructure.** Jackson rules infrastructure out by definition,
   putting it outside the model. suss can't rule it out. The strict
   reading still works once you allow several audiences: code is
   either a concept for *some* identified role, or a sync, or
   infrastructure the model doesn't represent.
4. **Opacity.** Jackson assumes a fully resolved model. suss labels
   what it couldn't resolve (opaque predicates, unresolved subjects)
   and passes those labels up to the level of syncs. So you can tell a
   sync exists without resolving the state condition that gates it.
5. **Completeness.** Jackson's model is closed. suss's derivation
   leaves some code unclassified, and the amount it leaves tells you
   how much of the codebase is coordination and how much is purpose.
6. **Reach.** Syncs that go through a call, depend on state, or cross
   a boundary all map fully. Syncs built on event subscription, on
   ordering in time, on something not happening, or on an opaque gate
   either escape extraction completely or come out partial (see
   §What suss can't reach yet).

## Failure modes of bottom-up derivation

Deriving concepts from code turns the identification problem around.
You don't start from purposes. You start from code units (handlers,
components, resolvers) and reconstruct the concepts from their
behaviour. Expect three ways that goes wrong:

- **Smeared concepts**: one concept's behaviour is scattered across
  many code units. Authentication lives partly in middleware, partly
  in a login handler, and partly in a session hook. No single code
  unit corresponds to it.
- **Fused concepts**: one code unit implements several concepts at
  once. A User handler mixes Profile, Session and Permissions. Its
  behavioural summary shows transitions that different purposes
  actually govern.
- **Phantom concepts**: code units that look like concepts but are
  actually syncs, such as logging, retry, caching and rate limiting.
  They have no purpose a user can see. They coordinate other concepts.

We would like to detect these, and we already have signals that could
feed the detection:

- Smearing: many units whose `subjects` trace back to a shared state
  lineage, with no pairing binding between them.
- Fusion: one unit whose transitions split into separate sub-clusters
  by `subjects` lineage (several families of state in one summary).
- Phantom: a unit whose OP only ever ends in invocations of *other*
  units' actions, and never in an outcome a role can observe.

None of this exists today. It is the form that future heuristics
could take.

## What suss can and can't reach yet

These map fully:

- **Syncs through a call**: one unit's transition invokes another,
  and the boundary pairs the provider with the consumer. Shipped.
- **Syncs that depend on state**: a predicate that refers to another
  unit's state gates the invocation, and you can trace it through
  `subjects`. Partial: the adapter resolves intermediate subjects up
  to depth 8.
- **Syncs across a boundary**: HTTP, GraphQL, function-call and React
  render. Shipped. React is still being filled in (see the
  [status design record](./status.md), Phase 9 and the React phases).

These map partially or not at all:

- **Event-subscription syncs**: `emitter.on(event, handler)`,
  `eventTarget.addEventListener`, and Pub/Sub. You can see both the
  place where the handler is registered and the handler itself, but
  the *connection* between them is an event-name string, and the IR
  has no boundary variant for that.
- **Syncs on ordering in time**: "X must happen before Y" or "retry
  after N minutes." suss extracts nothing about time. It reads the
  structure of the code, and it never sees what happened when.
- **Syncs on absence**: "if X *didn't* fire within a window, do Y."
  These run into the same limitation as syncs on time.
- **Syncs behind an opaque gate**: the sync is there, but the state
  condition is an opaque predicate. We can tell the sync exists
  without resolving what gates it. That limits precision, but suss can
  still see the sync. Reducing opaqueness during extraction pays off
  many times over, because every analysis of syncs inherits the
  precision.

## PRDs and intent specifications

A PRD or a feature description is, in structure, a **top-down concept
declaration written for a particular audience**. A well-formed PRD
says:

- **Purpose**: the one job the feature does for the target user.
- **Operational principle**: a scenario (user does X, system responds
  Y, user observes Z).
- **State**: what the system keeps track of for the user.
- **Actions**: the interface the user works through.
- **Role / audience**: who this is for, in their vocabulary.

When a PRD reads as confused, one of those parts is usually broken:

- Two purposes stapled together (a fused concept, at the level of the
  spec).
- A scenario that never ends in an outcome some role can observe (a
  phantom concept, so probably infrastructure or a sync dressed up as
  a feature).
- State the feature uses but doesn't own. It belongs to a different
  concept, so the PRD is specifying a sync without saying so.
- No audience (Jackson's trap of the implicit user), so it's unclear
  whose mental model "observable" is measured against.

The failures that affect deriving concepts bottom-up affect writing
specs top-down too. That suggests PRDs and summaries can be compared
in both directions:

- **Forward**: a structured PRD is an intent spec. Compare it with
  derived summaries to find out whether the code does what the spec
  says.
- **Backward**: derived summaries are candidate concepts. Compare them
  with a PRD to find out whether there is a well-formed concept here,
  or whether we shipped fused, smeared or phantom code.
- **Lateral**: several intent specs (a product PRD, an engineering
  design doc, a test plan, a support runbook) are concept declarations
  for *different audiences*. When they disagree, the disagreement
  tells you something.

suss has none of this today. The closest item on the backlog is
[intent specs as a structured data
interface](./backlog.md#intent-specs). In the Jackson mapping, an
intent spec is a concept declaration, and you can evaluate it with the
same OP test that classifies derived summaries.

See also: [Arazzo workflows](./backlog.md#arazzo-workflows). Arazzo
describes API workflows with several steps as declared artifacts. In
these terms, an Arazzo workflow is a **feature specification**: a
declared chain of syncs across concepts. It is the closest existing
standard to "PRD as data."

## Aspirational implications

These are ordered by how much work each one takes compared with how
much its value builds up:

1. **Reducing opacity keeps paying off.** Every gain in extraction
   precision, such as breaking predicates down, resolving subjects
   through wrappers or following a factory's return value, feeds into
   sync detection, OP assembly and PRD comparison. Cheap
   improvements here help every analysis downstream.
2. **Audience annotation on summaries.** A layer of tags over derived
   summaries that says which roles can observe a unit's OP. You can
   infer some roles from the code (an `/admin/` route prefix, a CLI
   only operators use, an internal SDK package), and somebody has to
   declare the rest. This would make a taxonomy of features for several
   audiences possible.
3. **OPs for several audiences.** When a concept serves several
   audiences, its behaviour is identical but its OP differs from one
   audience to the next. The open question is whether that is one
   summary with several OP annotations, or N summaries, one per
   audience.
4. **Identifying sync chains.** Today we pair summaries, which gives
   us edges between two nodes. The next step is to join those paired
   edges into chains, name each chain as a candidate feature, and
   check them against PRDs and Arazzo workflows.
5. **Detecting failure modes.** Heuristics over the shared-state graph
   for smeared, fused and phantom concepts. The signals are already
   there (`subjects` lineage, where an OP ends, transitions that only
   sync), and turning them into findings is an extension to the
   checker.
6. **Sync packs for events, time and absence.** Each one needs a new
   `BoundarySemantics` variant. This is probably the most work of any
   of these. The IR knows nothing about ordering in time today, and
   pairing on an event name works differently from the pairing suss
   has shipped for in-process calls, HTTP and GraphQL.

## Open threads

The framework leaves two questions open for suss:

1. **Where do audiences come from?** You can infer some of them (a
   route prefix, a CLI namespace, the name of an SDK package), and
   somebody has to supply the rest, because some distinctions only
   exist in convention. Inference alone will miss the audience
   boundaries that nothing in the code marks.
2. **A concept serving several audiences: one summary or several?**
   The behaviour is identical and the OP differs for each audience.
   Both options have a cost. N summaries multiply the pairing problem,
   and one summary with N annotations pushes the complexity into
   whatever renders or consumes it.

Neither needs an answer yet. We wrote both down so the options don't
quietly disappear when audience work gets scheduled.

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
  2025), which makes the argument for the structural pattern. Its
  framing, where concepts are independent and a sync is a separate
  rule, is the one we follow most directly here. [Conference
  page](https://2025.splashcon.org/details/splash-2025-Onward-papers/14/What-You-See-Is-What-It-Does-A-Structural-Pattern-for-Legible-Software).
- Daniel Jackson's [CSAIL
  homepage](https://people.csail.mit.edu/dnj/) and the [MIT
  Software Design Group](https://sdg.csail.mit.edu/project/conceptual/)
  for the broader list of publications.

Internal cross-references:

- [Kinds of contract](../docs/why/kinds-of-contract.md): the taxonomy
  of contract shapes, which is the shipped product's version of
  Jackson's point that contracts come in several forms.
- [Boundary semantics](../docs/theory/boundary-semantics.md): the
  model of transport, semantics and recognition in three layers, which
  is the structural counterpart to the semantics of syncs.
- [The backlog design record](./backlog.md): longer-term items
  grounded in this framework (intent specs, Arazzo workflows, audience
  annotation, sync-chain identification, failure-mode detection,
  non-call sync packs).
