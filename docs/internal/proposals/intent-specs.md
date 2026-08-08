# The intent layer: design proposal

A plan for closing the loop between *what the code does* and *what the
team meant to ship*. The first half, derived behavioural summaries from
code, ships today. Below is a design for the second half: a structured
intent layer that pairs against the derived side, delivered in the order
`v0.1` … `v0.4`.

Worked examples live under
`docs/internal/proposals/intent-layer-examples/`. The Fastify
`users-lookup` example exercises v0.1; the aws-sqs `order-intake`
example exercises v0.2. Both target fixtures that today's checkers
already analyse.

## Why this exists

People in several different traditions make this argument: the
observability writers (Charity Majors et al.), concept design (Jackson),
the formal-methods and lightweight-spec writers (Hillel Wayne and
others), and the AI-codegen commentary (Willison, Larson) that has made
the question urgent over the last two years. They all say the same
thing: as code becomes cheaper to generate, the bottleneck moves from
writing it to checking it. To check it you need a structured statement
of *what was meant*, one you can **map onto** *what shipped* and,
eventually, onto *what production does*. Mapped, not identical: intent
and behaviour share primitives (a boundary, a status code, a body shape)
and get compared at defined join points, but they work at different
granularities and are different kinds of artifact. AI codegen makes this
urgent: when humans are no longer the bottleneck on producing code, the
question becomes "is what we got what we meant," and ad-hoc PRDs spread
across different tools cannot answer that at review time.

Suss today has derived summaries from code, which is one side of that
loop, plus third-party schemas (OpenAPI, GraphQL SDL, Prisma) that
happen to state structural truth about an API. Nobody wrote any of these
as *team intent*; they wrote them as wire contracts, data-model
definitions, or vendor-supplied descriptions. The team's own intent
(what the PR was supposed to ship, what the product description meant by
"order is acknowledged and queued," what the engineering doc said about
the failure mode) lives in markdown PRDs, Notion pages, Confluence
spaces, Linear / Jira ticket descriptions, and chat threads. Each tool
is structured for its own purpose, and you cannot compare any of those
structures against running code.

Two costs of staying where we are:

1. Every project ships derived summaries with no top-down ground truth
   to anchor them. suss catches drift between implementations, but not
   drift between *intent and implementation*.
2. AI codegen makes that particular drift worse. A natural-language
   PRD in Notion cannot gate generation, so the code that comes back
   matches the prompt's phrasing and nobody can check it against a
   structured statement of what was wanted.
3. An outside review of the project picked out the
   PRD-as-typed-concept framing as the strongest idea we have not built
   yet: useful right away as a vocabulary, and more useful once the tool
   catches up to it.

## Two citizens, one layer

Intent splits into two separate artifacts that serve different purposes.
What separates them is not who writes them (any team member can write
either one, depending on how the team works) but what they are for:

| | Outcome intent | System intent |
|---|---|---|
| **Purpose** | Describe what should happen for the user / consumer in terms they care about. | Specify how the system should behave: the contract a downstream tool can compare to running code. |
| **Register** | Descriptive, human-readable, scenario-shaped. | Structural, machine-comparable, contract-shaped. |
| **Where it lives today (without suss)** | Notion / Confluence pages, Linear / Jira tickets, markdown PRDs in the repo. | OpenAPI files, Prisma schemas, code comments, sometimes nowhere. |
| **What changes with suss** | The same thing to write, but committed to the repo alongside the code, where a machine can check its coverage. | An artifact the team writes, which pairs against derived code summaries. |
| **Typical authors** | Whoever writes PRDs today (PM, designer, founder, eng lead). | Whoever owns the contract surface (engineer, architect). |
| **Specificity** | User-observable ("rate-limited request gets a friendly rejection"). | Contract-level ("POST /auth/login returns 429 with `{error, retryAfter}`"). |
| **File suffix** | `*.prd.yaml` | `*.system.yaml` (or `*.intent.yaml`, v0.1's existing suffix) |
| **Static check** | Coverage: is there a system intent that claims to implement each scenario? | Pairing: does the code match the declared structural behaviour? |
| **Runtime check (future)** | Runtime observability: did users actually experience the declared outcomes? | Runtime observability: does the system actually behave as declared? |

Each of the two forms has its own benefits and limits. Descriptive PRDs
are cheap to write and stay readable as the team grows, but you cannot
resolve one against running code without the link to system intent.
Structural system intent is precise enough to compare field by field,
but it loses the user framing that makes a PRD readable to anyone
outside the team that wrote it. The intent layer supports both as
separate artifacts, so neither one pays the other's cost.

A team can adopt either side independently: outcome intent first to
make planning gaps visible, system intent first to formalise contracts
the OpenAPI / Prisma readers don't already cover.

## Author-facing surface vs structural model

The PRD is one of the two surfaces an author writes against. Anyone
writing a PRD types purpose, audience, and scenarios. The internal
structural vocabulary (boundary, workflow, concept) is what the reader
walks and what findings point at, and not something the author has to
learn.

```yaml
# author-facing PRD: what a product description looks like
kind: prd
title: User profile lookup
purpose: Fetch a user's profile information by id.
audience: web-client
scenarios:
  - title: Successful lookup
    when: a request arrives with a known user id
    expect: the caller receives the user's profile
    link: users-lookup.found          # optional structured link
  - title: Missing id
    when: the request omits the id parameter
    expect: the caller is told the id is required
    # no `link` yet; a valid scenario, not linked yet
```

`when` / `expect` is the whole scenario in human terms. `link` is an
optional structured reference, and a scenario without one is a valid
unlinked state (see [Scenarios](#scenarios-and-how-they-link-to-system-intent)).
(Earlier drafts named these `then` / `expect`; the shipped schema uses
`expect` / `link` because a data object with a `then` property is
treated as a thenable by Promise resolution, a latent footgun.)
The structural vocabulary appears in two places, both optional:

- **Findings** reference the concrete endpoint or function, not
  abstractions: `unimplementedBoundary at GET /users/:id`.
- **Engineers** who want fine-grained precision over sync chains can
  write at the workflow level directly. Otherwise, working out the
  structural model is the reader's job.

## System intent has three kinds

System intent comes in three kinds, and you can compare each one against
the level above and below it. Drift between adjacent levels is a
finding.

1. **Boundary intent**: a contract for one endpoint or function
   call. It is complete by itself, with no composition. v0.1 ships
   this.
2. **Workflow intent**: a sequence across boundaries. Ordered
   effects (message sends, storage writes, function calls), input
   sources (queue reads, scheduled triggers), and the success
   criteria that tie them together. v0.2 ships this.
3. **Concept declaration**: what a unit of user-visible value does.
   The purpose it serves, the state it owns, the actions it exposes,
   and the canonical scenario that demonstrates the purpose. The
   long-form mapping to Daniel Jackson's concept-design vocabulary
   lives in [`concept-design.md`](../concept-design.md), and this
   proposal points there rather than arguing it again. v0.3 ships this.

Outcome intent (PRDs) is a level above all three: a PRD's scenarios link to
outcomes declared at any of the three kinds of system intent.

A fourth axis, **outcome / SLO**, cuts across all of these rather than
being a layer of its own. An SLO can attach to a concept, a workflow, a
boundary, or even one specific transition. It is out of scope until the
runtime observability adapters ship in v0.4.

## Arazzo as inspiration for the workflow layer

[Arazzo](https://spec.openapis.org/arazzo/latest.html) (Linux
Foundation, late 2024) describes multi-step API workflows in YAML:
ordered operations with success criteria, and output forwarded from one
step to the next. It is the closest existing standard to what v0.2
workflow intent needs for the HTTP part, and worth borrowing mechanics
from. Arazzo only covers HTTP-to-HTTP workflows, so the v0.2 schema
extends it to boundaries that are not HTTP (function calls, queue sends,
storage writes) and adds the purpose / audience wrapper that puts a
workflow inside a concept.

## Scenarios, and how they link to system intent

A PRD scenario reads on its own and has an optional structured link.
Here is all of it, as shipped in `@suss/intent-ir`:

```yaml
scenarios:
  - title: Successful lookup          # optional label
    when: a request arrives with a known user id     # condition, human terms
    expect: the caller receives the user's profile   # expected outcome, human terms
    link: users-lookup.found          # optional structured link
```

The author always writes `when` and `expect`, in their own terms.
Together the two make a complete scenario that a reader can follow
without knowing anything about the system's internals. `link` is the
optional structured reference: a qualified outcome reference,
`<system-intent-name>.<outcome-id>`, that points at one particular
transition or effect in a system intent.

**A scenario without `link` is a valid state, and a deliberate one.**
The author describes the behaviour they want in `when` / `expect` and
leaves the link unset. The checker reports an unlinked scenario as
**info** ("scenario not yet linked to a system intent") rather than as a
coverage error, so a team can drop in scenarios and nothing fails. A
team that wants the link to be mandatory can turn on stricter checking
later, with a flag rather than by default.

The author does not have to know the system intent's outcome ids.
Somebody or something else makes the link, whatever fits the team: an
LLM that reads the `when` / `expect` text and proposes a link, a
platform that shows candidate outcomes, or an engineer who wires it up
by hand. For a new feature there may be no system intent to link to yet.
In that case whoever is facilitating *generates* the system intent from
the scenarios (a third way of authoring, see below) and makes the link
as part of that generation. So the id an engineer put in `link` is not
vocabulary the author has to learn; it is a slot that something else
fills.

When `link` is present, the checker resolves it. The dotted form keeps
the link separate from the underlying API surface: renaming an endpoint
(`GET /users/:id` → `GET /accounts/:id`) does not touch the PRD, as long
as the system intent's name and outcome ids stay put. An ambiguous
reference (two system intents share a `name`) is a mistake in the
authoring, and the checker reports it. A dangling reference (no matching
name, or a matching name with an unknown outcome id) gets reported
separately, so the author knows whether to rename something or to add
the outcome. (The exact finding kinds and severities get settled along
with the decision about the finding type below.)

## Worked example #1: Fastify `/users/:id` (v0.1 territory)

See `intent-layer-examples/fastify-users/` for the full files.

The Fastify fixture's `/users/:id` handler has four transitions:
`!id` → 400, `!user` → 404, `user.role === "admin"` → 200 enriched,
default → 200 plain. The system intent declares all four with
matching outcome ids, and the PRD refers to each one as a scenario.

Static checks that fire:

- **PRD → system intent (coverage).** Each PRD scenario's `expect`
  resolves to an outcome id in the system intent. When the intent
  matches, there are no findings.
- **System intent → derived code (pairing).** Each system intent
  transition pairs against a derived handler transition. When the two
  structures match, there are no findings.

Drift demos (the kind names are the ones shipped on `IntentFinding`; the
PRD kinds are the remaining v0.1 work):

- PRD links a scenario to `users-lookup.deleted` and no system intent
  declares it → `danglingScenarioLink` (proposed name; ships with the
  PRD coverage checker).
- System intent declares `found-admin` but the handler drops the
  admin branch → `uncoveredOutcome`.
- Handler adds a 410 branch (soft-delete) that no system intent
  declares → `undeclaredOutcome`.
- System intent declares body `{ id, fullName }` but the handler
  returns `{ id, name }` → `outcomeShapeMismatch`.

The intent-vs-code drift findings are wired up end to end in
`@suss/checker-intent` (`uncoveredOutcome`, `undeclaredOutcome`,
`outcomeShapeMismatch`, plus `unimplementedBoundary` for a boundary
with no implementation at all and `unkeyableBoundary` for an intent
whose boundary the checker cannot pair). The PRD-coverage finding is the
one thing still to add for v0.1.

## Worked example #2: aws-sqs Orders (v0.2 territory)

See `intent-layer-examples/aws-sqs-orders/` for the full files.

The aws-sqs fixture's `OrderProducer` accepts an order, publishes
`{ id, total }` to `OrdersQueue`, and returns `{ ok: true }`.
`OrderConsumer` reads from the queue and destructures `{ id,
totalAmount }`, a field-name mismatch we put there on purpose.

The intent layer says all of this with two `kind: workflow` files plus
one PRD:

- `order-intake.system.yaml` declares one transition
  (`acknowledged`) and one effect (`queued-for-processing` →
  message-send to `OrdersQueue` with `{ id, total }`).
- `order-processing.system.yaml` declares one input (queue source
  `OrdersQueue` with `{ id, total }`) and one transition
  (`processed`).
- `order-intake.prd.yaml` declares two scenarios, one referencing
  both `order-intake.acknowledged` and `order-intake.queued-for-processing`,
  the other referencing `order-processing.processed`.

Drift demos:

- The producer changes its emitted body from `{ id, total }` to
  `{ id, totalAmount }` without updating `order-intake.system.yaml`
  → `outcomeShapeMismatch` at the system-intent ↔ code layer.
- A team removes the `total` field from the system intent's effect
  body but the PRD still expects `queued-for-processing` to include the
  order amount → the PRD coverage check catches it, because the
  scenario resolves to an outcome whose body no longer matches what the
  PRD said it wanted (`scenarioBodyDrift`, proposed name).

These are the integration-bug failure modes the
[anatomy-of-an-integration-bug](https://nimbusai.dev/blog/the-anatomy-of-an-integration-bug-its-not-just-your-apis)
demo exists to illustrate: a single-service refactor that silently
breaks a cross-service consumer. The intent layer catches them before
the PR ships rather than after the production incident.

## Checking pipeline

```
PRD (scenarios, audience, purpose)
   │
   │  Coverage check (per scenario), remaining v0.1 work:
   │  - resolve `link` outcome ref against loaded system intents
   │  - emit unlinkedScenario / danglingScenarioLink /
   │    ambiguousScenarioLink / scenarioBodyDrift as appropriate
   ▼
System intent (boundary / workflow / concept)
   │
   │  Pairing check (shipped, @suss/checker-intent):
   │  - pair by boundary key against derived code summaries
   │  - emit unimplementedBoundary / uncoveredOutcome /
   │    undeclaredOutcome / outcomeShapeMismatch / unkeyableBoundary
   ▼
Derived code summary
```

There are two hops, and each one is useful on its own. A team can write
either side first, and coverage and pairing fire on whatever is loaded.

## Authoring paths

Intent docs reach the repo three ways, and all three are treated the
same: the reader cannot tell them apart, because they are the same YAML
on disk. The one thing that differs is provenance, which the `source`
field below records.

**Writing intent directly (greenfield).** The team writes intent
declaratively, alongside the code or ahead of it. PRD first and then the
implementation, or both together as the feature gets scoped. This is the
natural path on new features, and on small projects where writing intent
for every boundary is manageable.

**Inferring intent from code (brownfield).** Use the current code as a
stand-in for intent: extract derived summaries, turn them into starter
system intent docs, then have the team curate the result into team
intent. The barrier is lower on a project with thousands of existing
endpoints. The tradeoff is different: the starter describes what the
code does today, which is not necessarily what anyone meant. `suss
infer` (below) does this.

**Generating system intent from a PRD (greenfield, facilitated).**
The author writes outcome-intent scenarios in human terms (`when` /
`expect`, no `link`). Somebody or something else (an LLM, a platform, or
an engineer) reads those scenarios and produces the structural system
intent plus the links back to the scenarios. This runs the opposite way
from `suss infer`: that one goes code → system intent, and this one goes
described intent → system intent. It is how a new feature gets its
structural layer without the author writing it by hand, and it is what
settles the "the author shouldn't have to know outcome ids" tension,
because something else generates the ids rather than the author writing
them. How the facilitation works is out of scope for v0.1 (the schema
supports unlinked scenarios so that the facilitator has something to
read); the generator itself comes later.

What does differ is **provenance**, and the design has to carry it
through to make brownfield adoption work:

- Each system intent and PRD has an optional `source` field with
  values like `"author"` (default; the team wrote this), `"inferred"`
  (straight output of `suss infer`, not yet curated), or
  `"inferred, curated"` (inferred, then edited by a person).
- The checker downgrades findings against `inferred` intent that
  nobody has curated yet. That intent describes what the code did when
  the inference ran, so a finding that says "intent says X, code does Y"
  most likely means the code changed since then, rather than that
  somebody wrote the intent wrong. Curating a doc is what moves it from
  `inferred` to `inferred, curated`, which says drift findings should
  now fire at full severity.
- Once somebody curates inferred intent, it drifts from re-inferred
  intent the same way any spec drifts from code. Refreshing it
  (re-infer, then merge against the curation) is its own piece of work,
  sketched below.

### `suss infer` (v0.1.1)

`suss infer` walks derived summaries from `suss extract`, picks the
boundaries the team scoped it to (filter by file glob, by framework, by
boundary kind), and emits one boundary system intent per boundary with
`source: "inferred"`. It derives outcome ids from status codes (e.g.
`200-ok`, `404-not-found`), and expects somebody to rename them during
curation.

```bash
# Greenfield workflow
$ # Team writes intent/users-lookup.intent.yaml by hand.

# Brownfield workflow
$ suss extract -p tsconfig.json -f express -o summaries/code.json
$ suss infer --from summaries/code.json --out intent/
# Produces one intent/<endpoint>.intent.yaml per boundary,
# with source: "inferred" and placeholder outcome ids.
$ # Team reviews, renames outcome ids, adds purpose/audience,
$ # changes source to "inferred, curated" in each file.
```

The implementation mostly moves fields around: a derived summary on one
side, a boundary intent on the other. The harder design question is what
**refresh** does when the code changes after an inference:

1. The naive option is to re-infer over the existing intent files,
   which loses the curation edits.
2. The other is to merge against a baseline: keep an
   `inferred-baseline.yaml` snapshot next to each curated intent file.
   Re-inference produces a new baseline. The diff against the previous
   baseline shows what changed in the code, the diff against the curated
   file shows what the team edited, and the tool merges where it can and
   reports conflicts where it cannot. That is the right design, but it
   is not v0.1.1 work; it is about three days on its own.

For v0.1.1, ship naive re-inference with a clear warning:
"re-inferring over curated intent will overwrite your edits; use
`--into <new-dir>` to write the re-inferred output to a separate
directory for manual reconciliation." Merging against a baseline is
a v0.1.2 / v0.2 follow-on.

### Subset selection

A team adopting the layer rarely wants to generate over the whole repo.
They select at extract time, with the filters that already exist there
(`--files`, `-f <framework>`, and so on). `suss infer` reads the
summaries file the team filtered into, so they pick the boundaries
before generation runs.

### Implications for the v0.1 schema

The `source` field needs to be in the schema from v0.1. `suss infer` is
v0.1.1, but if the schema does not have `source` from the start, then
once `suss infer` ships nobody can tell a curated intent file written in
v0.1 apart from an inferred one. Adding a default `source: "author"` to
the boundary intent schema in v0.1 keeps the migration path clear.

## Sequencing

| Stage | Adds | Demo fixture | Status |
|---|---|---|---|
| **v0.1** | Boundary system intent + PRD shape + coverage checker + outcome ids on transitions + `source` provenance field | Express `/users/:id` | Shipped: `@suss/ir-core` primitives, `@suss/intent-ir` (schema + summary + `IntentFinding`), `@suss/contract-intent` reader (boundary + prd), `@suss/checker-intent` (`checkIntentAgreement` → findings + checked / unchecked accounting, including PRD scenario coverage and provenance-aware severity downgrade), CLI `suss check --dir --intent`. Remaining: `scenarioBodyDrift` (needs the PRD side to state what body it expects, which a v0.1 scenario has no room for, so it waits for the v0.2 workflow body grain) |
| **v0.1.1** | `suss infer` (infers intent from code for brownfield adoption) | Same Express fixture, inferred then curated | ~2 days |
| **v0.2** | Workflow shape (effects, inputs, queue references); non-HTTP boundary semantics; three-way merge for generator refresh | aws-sqs Orders | Pending; ~5 days |
| **v0.3** | Concept declarations with state + actions + failure-mode predicates | TBD | Gated on workflow shape shipping |
| **v0.4** | Runtime observability adapters; SLO declarations | Gated on runtime observability adapters | Gated |

v0.1 is shipped end to end (schema with transition ids + `source`,
PRD shape, reader, `@suss/checker-intent`, CLI wiring), including PRD
scenario coverage:

1. The PRD coverage checker (in `@suss/checker-intent`) walks PRDs,
   resolves each scenario's structured link against the loaded system
   intents, and emits:
   - `unlinkedScenario` (info: scenario authored, link pending)
   - `danglingScenarioLink` (the link points at an intent or outcome
     that no system intent declares, including a matched intent whose
     outcome id is unknown, keyed on that intent's boundary)
   - `ambiguousScenarioLink` (multiple system intents share the name)

   Coverage resolves against the loaded system intents and stops
   there. Whether the code implements a linked outcome stays the
   boundary pass's job (`uncoveredOutcome` / `unimplementedBoundary`),
   so the two hops stay useful on their own and somebody can check a PRD
   before any code exists. PRDs move from `unchecked` into `checked`
   accounting (total / resolved / unlinked scenario counts).
2. Severity that takes provenance into account: the checker downgrades
   findings against `source: "inferred"` intent that nobody has curated
   yet, whether that intent is a boundary or a PRD, by one level.
   Curating it restores full severity.
3. Integration coverage: `@suss/checker-intent` and `@suss/cli`
   exercise resolved / unlinked / dangling / ambiguous scenarios plus
   the coverage accounting.

`scenarioBodyDrift` (the linked outcome's body disagrees with what the
PRD said it expected) waits. A v0.1 PRD scenario has `when` / `expect` /
`link` but says nothing about a body, so there is nothing to compare
against the resolved outcome's body. It lands with the v0.2 workflow
body grain, where scenarios refer to effect bodies.

**Settled while shipping: a malformed spec is an error at load time, not
a finding.** The earlier draft listed `intentSpecMalformed` as a finding
kind; the shipped reader throws instead. What the layer runs on is the
difference between *pending* and *broken*. An unlinked scenario or an
unkeyable boundary is a valid pending state, reported as info or a
warning while the run continues. A doc that fails schema validation is
broken, and there is no sound way to check part of it, so the author has
to fix it before the run means anything.

## Out of scope, deferred

- **Backward comparison (concept-shape audit).** "Did we ship a
  fused / smeared / phantom concept?" Needs failure-mode detection
  from the existing backlog; ships with v0.3.
- **Lateral comparison (intent vs intent for different audiences).**
  Same concept's PRD for end-users vs admins disagrees. Requires
  audience tagging; defer.
- **Quality specifications (latency, error budget, observability
  obligations).** Per `internal/quality.md`, full intent includes
  quality alongside capability. Defer until capability-only intent is
  in production use.
- **Diff mode** (`suss check --intent intents/ --diff main` →
  findings introduced by the current PR). Worth holding the CLI
  interface open to.
- **Generated intent stubs from existing code.** Reverse mode that
  emits a starter intent spec from a derived summary so teams can
  adopt intent on an existing codebase. It falls out of v0.2 with
  little extra work, once that form is in production use.
- **LLM-mediated authoring help.** An LLM can suggest outcome ids or
  boundary refs from a PRD's prose at write time; the suggestion is
  committed and reviewed. The LLM stays out of the verification path.
  Out of scope for the v0.1 schema; relevant once teams are authoring
  PRDs at volume.

## Parked refinements (revisit, don't build yet)

These came up during design review and we deliberately did not act on
them in v0.1: the design is not settled, and rushing it would freeze a
guess in place.

- **Input contract on boundary system intent.** A PRD condition like
  "a *valid* order" has nowhere to be defined at the system level
  today, because the boundary intent declares only `transitions` (the
  outputs) and never says what a well-formed request looks like. To
  ground conditions as well as outcomes, the boundary intent would grow
  a declaration of the input, the way OpenAPI has parameters and a
  requestBody. The two sides would then match: linking to an outcome
  grounds `expect`, and the input contract plus the branch guards would
  ground `when`. Parked; come back to it when grounding a condition is
  something a team actually needs rather than a v0.1 nicety.
- **Condition-grounding / predicate comparison.** Even with an input
  contract, checking that "the code accepts *exactly* the valid
  requests" means comparing the PRD's condition against the code's
  branch guards. suss has machinery for comparing predicates, but this
  is hard, so v0.1 treats `when` as human text it does not read into,
  and checks outcomes only. This is tied to the input contract above.

## Settled architecture decisions

We debated these four during design and they are now settled. The
sections below assume them. They are written down here so they do not
live only in conversation.

**Implementation status (feat/intent-checker):** decisions 1 to 3 are
implemented as written. `@suss/ir-core` is extracted (with `boundaryKey`
and `bodyShapesMatch` moved there so both checkers share the pairing
primitives), `@suss/intent-ir` contains the intent types and the thin
`IntentFinding`, and intent serializes to its own files. Decision 4 is
implemented with one deviation and one gap, both of which are flagged
below rather than quietly absorbed.

**Decision 4, resolved:** the CLI is the dispatch point, not
`@suss/checker`. We wrote the decision while "separate package **or a
sub-path** of `@suss/checker`" was still open, and in the sub-path
version `@suss/checker` stayed the entry point. We took the package
split from the same decision, and the point of that split was that the
two can evolve independently. With two peer packages, making the checker
the orchestrator would force `@suss/checker` to depend on
`@suss/checker-intent`, which contradicts the IR-only rule in
`architecture.md`. Putting the CLI in that role still does what the
decision set out to do: one dispatch point, and independent evolution.
If some programmatic consumer later wants a single call that checks
everything, that is a new thin package above both checkers rather than
another role for `@suss/checker`.

**Decision 2, closed:** the pipeline operates on the shared base as
written. The suppression pipeline (rule schema, matching semantics,
effect application, threshold counting) lives in `@suss/ir-core` over
the thin finding base; `@suss/checker` and `@suss/checker-intent`
each supply only their field matcher, and `.sussignore` rules apply
to both finding streams with identical gating semantics.

**1. Intent gets its own IR package, `@suss/intent-ir`.** Intent is
not a `BehavioralSummary`: a PRD is not a code unit, and having to force
one into `kind: "library"` with empty transitions and a metadata blob
was the sign that the type was wrong. `@suss/intent-ir` contains the
intent types (PRD / outcome intent, boundary / workflow / concept system
intent). Behaviour stays in `@suss/behavioral-ir`. The two share
primitives: `TypeShape`, boundary identity, status codes,
`SourceLocation`, `Confidence`. There is a smaller decision inside this
one, which we recommend and you should push back on if you disagree:
pull those primitives out into a small `@suss/ir-core` that both import,
so neither IR depends on the other. The alternative, where
`@suss/intent-ir` imports primitives from `@suss/behavioral-ir`, is less
mechanical work now, but it makes intent depend on behaviour, which it
does not. Pulling them out is the bigger one-time change, and it ends
with neither IR depending on the other.

**2. Intent findings use a thin shared base, not the peer-pairing
`Finding` shape.** The existing `Finding` is built for pairing a
provider against a consumer: it is symmetric, with `provider` and
`consumer` sides and kinds like `unhandledProviderCase`. Intent findings
are not symmetric. They run top-down ("we declared X, the code does Y",
or "this scenario has no system intent"), and those field names would
describe the data wrongly. The shared base has `kind`, `severity`,
`description`, `sources`, and a boundary reference. The fields that only
intent needs (the scenario, the declared-against-found pair) live in an
extension for intent findings. The pipeline (dedup, suppressions,
severity thresholds) works on the base. If some case shows that the base
has no room for what an intent finding needs, promote it to a fully
separate type, but start with the shared one.

**3. Intent serializes to its own file, separate from behavioural
summaries.** Behaviour and intent are different artifacts that get
compared against each other, rather than mixed together in one stream. A
`suss extract` run writes behavioural summaries, intent docs are their
own files, and the checker loads both and compares them. No tagged union
in one file.

**4. Checkers split into behavioural and intent, with `@suss/checker`
as the orchestrator.** The intent-vs-code and PRD-coverage checkers move
to their own module (`@suss/checker-intent`, or a sub-path), and
`@suss/checker` stays the entry point that loads both streams of
artifacts and dispatches. That keeps a single dispatch point while
letting the intent checkers change without churning the behavioural
ones.

**What this means for sequencing:** the package split (decision 1)
happens *before* anyone writes the PRD coverage checker, so whoever
writes it writes it once, against `@suss/intent-ir` and the thin finding
base, rather than retrofitting it afterwards. The boundary-intent reader
and `checkIntentAgreement` shipped earlier against
`@suss/behavioral-ir`, and they move into the new packages as part of
the split.

## Mechanics

The types below live in `@suss/intent-ir` per decision 1, and the reader
(`@suss/contract-intent`) parses YAML into them. We show them as plain
interfaces here; the Zod schemas mirror them.

### Schema

A top-level `kind` discriminator over the intent docs:

```ts
type IntentDoc =
  | BoundaryIntent   // kind: "boundary", system intent for one boundary
  | Prd;             // kind: "prd", outcome intent
  // workflow / concept system-intent kinds ship in v0.2 / v0.3
```

`BoundaryIntent` has an `id` on each transition (the outcome id that PRD
scenarios refer to) and a `source` provenance field (`"author"` by
default, `"inferred"`, `"inferred, curated"`).

The PRD shape, with `link` optional (as shipped):

```ts
interface Prd {
  kind: "prd";
  title: string;
  purpose: string;
  audience: string;
  source: IntentSource;             // "author" | "inferred" | ...
  scenarios: Array<{
    title?: string;
    when: string;                   // condition, human terms; required
    expect: string;                 // expected outcome, human terms; required
    link?: string | string[];       // qualified outcome ref(s); optional
  }>;
}
```

`when` and `expect` are required so that every scenario reads on its
own. `link` is optional so that somebody can write a scenario before it
is linked, or generate it together with its link. `source` is what tells
a hand-written doc apart from an inferred or facilitated one.

### Reader

`@suss/contract-intent` parses files into `IntentDoc` and hands them to
the right checker stream. A directory walk picks up
`*.intent.{yaml,yml,json}` and `*.prd.{yaml,yml,json}`, and the reader
dispatches on the top-level `kind`.

### PRD coverage checker

This lives in the intent checker module (decision 4). Given the loaded
system intents and PRDs, for each PRD scenario:

1. If `link` is unset → emit an **info** saying the scenario is not
   linked yet. This is not a coverage error: it is info by default, and
   strict mode is a flag you turn on.
2. If `link` is set, parse each ref as `<name>.<outcome-id>` and
   resolve against the loaded system intents:
   - no system intent with that `name` → dangling reference finding
   - multiple system intents with that `name` → ambiguous reference
     finding
   - matched name, unknown outcome id → dangling reference finding
     (which lists the outcomes it does know about, so the author can
     correct it)

### Finding kinds

The intent finding kinds live on `IntentFinding` (decision 2) in
`@suss/intent-ir`. On naming: no `intent` prefix, because the kinds
already live on the intent finding type. The kinds and severities as
shipped (the reasoning is in the `@suss/checker-intent` header):

- `unimplementedBoundary` (error): the intent declares a boundary that
  no code implements
- `uncoveredOutcome` (error): the intent declares an outcome the code
  never produces
- `outcomeShapeMismatch` (error): an outcome matched, but the two body
  shapes disagree
- `undeclaredOutcome` (info): the code produces a REST status the
  intent does not declare
- `unkeyableBoundary` (warning): the checker cannot key an intent
  boundary for pairing, so the coverage the intent declares is not
  happening

Severities follow the "severity follows epistemic character" rule in
`contracts.md`: a derivation that violates a specification is an error.
`undeclaredOutcome` is info rather than error because intent docs are
*open* specifications. They declare the floor (what must exist) rather
than a closed list, the way an OpenAPI schema does. Code that goes
beyond the intent probably means somebody has not written that intent
down yet, rather than that anything is in violation.

PRD coverage kinds (proposed, and they ship with the coverage checker):

- `unlinkedScenario` (info: the link is pending, which is the
  deliberate partial state)
- `danglingScenarioLink` (warning: a gap in the planning, because the
  scenario points at an outcome no system intent declares)
- `ambiguousScenarioLink` (warning: the author has to say which one
  they meant)
- `scenarioBodyDrift` (warning: the linked outcome has drifted from
  what the PRD expected)

## Validation

The Fastify worked example is also the v0.1 integration test:

1. Place the PRD + system intent files in
   `fixtures/fastify/intent/` (move from
   `docs/internal/proposals/intent-layer-examples/fastify-users/`).
2. Add `fastifyIntentIntegration.test.ts` to the CLI package that:
   - Extracts handler summaries from `fixtures/fastify/handlers.ts`
   - Reads the intent files via `@suss/contract-intent`
   - Runs `checkAll` over the union
   - Asserts the happy path produces zero intent findings
3. Add fixture variants for each drift case (a PRD scenario with no
   system intent to point at, a system intent transition the handler
   does not produce, a handler transition no system intent declares) and
   assert that the matching findings fire.

## Doc impact

- New: `docs/guides/author-intent-specs.md`, a how-to for the v0.1
  authoring workflow (PRD + system intent file shapes).
- New: `docs/reference/intent-schema.md`, the schema reference.
- Updated: `docs/contracts.md`. "intent" becomes a fourth source
  alongside specification / observation / derivation, and it should show
  the split between PM-authored and engineer-authored intent.
- Updated: `docs/internal/concept-design.md`. The PRD section links
  to this proposal, and says what has shipped once v0.1 ships.
- Updated: `docs/internal/backlog.md`. `#intent-specs` moves to
  "in flight" with the v0.x sequencing.

## Cost estimate (v0.1 completion only)

- Schema discriminator + PRD shape + outcome-id field: half a day
- PRD reader path: half a day
- Coverage checker + finding kinds: 1 day
- Integration test against the Fastify fixture (happy + 3 drift
  cases): 1 day
- Doc updates: half a day

Total: about 3 days before v0.1 can ship end to end.

v0.2 (workflow grain, boundaries that are not HTTP, the aws-sqs worked
example) is a separate 5 days or so. v0.3 and v0.4 are gated.

## Sequencing notes

- v0.1 does not depend on `#46` (adapter ECMAScript ownership). The
  Fastify fixture's `/users/:id` handler extracts fully today.
- v0.2 depends on `#46` in part, for any consumer-side workflow step
  that needs `.then` chain binding. The aws-sqs producer / consumer demo
  does not need it, because those are Lambda handlers with no Promise
  chaining.
- v0.3 depends on the failure-mode detection backlog item.
- v0.4 depends on observation adapters from the backlog.
