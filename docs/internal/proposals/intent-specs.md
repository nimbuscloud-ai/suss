# The intent layer: design proposal

A plan for closing the loop between *what the code does* and *what the
team meant to ship*. The first half (derived behavioural summaries
from code) ships today. This proposal designs the second half, a
structured intent layer that pairs against the derived side, and
sequences its delivery as `v0.1` … `v0.4`.

Worked examples live under
`docs/internal/proposals/intent-layer-examples/`. The Fastify
`users-lookup` example exercises v0.1; the aws-sqs `order-intake`
example exercises v0.2. Both target fixtures that today's checkers
already analyse.

## Why this exists

The argument cuts across several voices in different traditions: the
observability lineage (Charity Majors et al.), concept design (Jackson),
the formal-methods / lightweight-spec writers (Hillel Wayne and
others), and the AI-codegen commentary (Willison, Larson) that has
made the question urgent over the last two years. The shared claim: as
code becomes cheaper to generate, the bottleneck moves from coding to
verifying. Verification needs a structured statement of *what was
meant* that can be **mapped to** *what shipped* and (eventually) *what
production does*. Mapped, not identical: intent and behaviour share
primitives (the notion of a boundary, a status code, a body shape)
and are compared at defined join points, but they sit at different
granularities and are different kinds of artifact. AI codegen makes
this acute: when humans aren't the bottleneck on producing code, the
question shifts to "is what we got what we meant," and ad-hoc PRDs in
disparate tools don't answer it at review time.

Suss today has derived summaries from code (one side of that loop)
plus third-party schemas (OpenAPI, GraphQL SDL, Prisma) that
happen to declare structural truth about an API. None of these were
authored as *team intent*; they were authored as wire contracts,
data-model definitions, or vendor-supplied descriptions. The team's
own intent (what the PR was supposed to ship, what the product
description meant by "order is acknowledged and queued," what the
engineering doc said about the failure mode) lives in markdown PRDs,
Notion pages, Confluence spaces, Linear / Jira ticket descriptions,
chat threads. Each tool is structured for its own purpose and none
of those structures are comparable against running code.

Two costs of staying where we are:

1. Every project ships derived summaries that have no top-down ground
   truth to anchor them. Drift between implementations is caught;
   drift between *intent and implementation* isn't.
2. AI codegen amplifies that drift specifically. A natural-language
   PRD in Notion can't gate generation; the code that comes back
   matches the prompt's phrasing without anyone able to check it
   against a structured statement of what was wanted.
3. Outside review of the project named the PRD-as-typed-concept
   framing as the single strongest unrealised idea: useful immediately
   as a vocabulary, more useful once the tool catches up to it.

## Two citizens, one layer

Intent splits into two distinct artifacts that serve different
purposes. The two are framed not by who writes them (any team
member can author either, depending on the team's working style) but
by what they're for:

| | Outcome intent | System intent |
|---|---|---|
| **Purpose** | Describe what should happen for the user / consumer in terms they care about. | Specify how the system should behave: the contract a downstream tool can compare to running code. |
| **Register** | Descriptive, human-readable, scenario-shaped. | Structural, machine-comparable, contract-shaped. |
| **Where it lives today (without suss)** | Notion / Confluence pages, Linear / Jira tickets, markdown PRDs in the repo. | OpenAPI files, Prisma schemas, code comments, sometimes nowhere. |
| **What changes with suss** | Same authoring shape, but committed to the repo alongside code and machine-checkable for coverage. | A team-authored artifact that pairs against derived code summaries. |
| **Typical authors** | Whoever writes PRDs today (PM, designer, founder, eng lead). | Whoever owns the contract surface (engineer, architect). |
| **Specificity** | User-observable ("rate-limited request gets a friendly rejection"). | Contract-level ("POST /auth/login returns 429 with `{error, retryAfter}`"). |
| **File suffix** | `*.prd.yaml` | `*.system.yaml` (or `*.intent.yaml`, v0.1's existing suffix) |
| **Static check** | Coverage: is there a system intent that claims to implement each scenario? | Pairing: does the code match the declared structural behaviour? |
| **Runtime check (future)** | Runtime observability: did users actually experience the declared outcomes? | Runtime observability: does the system actually behave as declared? |

The descriptive and structural shapes carry their own benefits and
limits. Descriptive PRDs are cheap to write and stay readable as the
team grows, but resolving them against running code requires the link
to system intent. Structural system intent is precise enough to compare
field-by-field but loses the user-framing that makes a PRD
intelligible to anyone outside the team that authored it. The intent
layer keeps both as supported, distinct artifacts so neither pays the other's
cost.

A team can adopt either side independently: outcome intent first to
make planning gaps visible, system intent first to formalise contracts
the OpenAPI / Prisma readers don't already cover.

## Author-facing surface vs structural model

The PRD shape is one of the two author-facing surfaces. Anyone
writing a PRD types purpose, audience, and scenarios; the structural
internal vocabulary (boundary, workflow, concept) is what the reader
walks and what findings reference, not what the author has to learn.

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
optional structured reference; a scenario without it is a valid
unlinked state (see [Scenarios](#scenarios-and-how-they-link-to-system-intent)).
(Earlier drafts named these `then` / `expect`; the shipped schema uses
`expect` / `link` because a data object with a `then` property is
treated as a thenable by Promise resolution, a latent footgun.)
The structural vocabulary appears in two places, both optional:

- **Findings** reference the concrete endpoint or function, not
  abstractions: `unimplementedBoundary at GET /users/:id`.
- **Engineers** who want fine-grained precision over sync chains can
  author at the workflow level directly. Otherwise, the structural
  model is the reader's job.

## System intent has three kinds

System intent comes in three kinds, each comparable to the level above
and below it. Drift between adjacent levels is a finding.

1. **Boundary intent**: a contract for one endpoint or function
   call. Self-contained, no composition. v0.1 ships this.
2. **Workflow intent**: a sequence across boundaries. Ordered
   effects (message sends, storage writes, function calls), input
   sources (queue reads, scheduled triggers), and the success
   criteria that tie them together. v0.2 ships this.
3. **Concept declaration**: what a unit of user-visible value does.
   The purpose it serves, the state it owns, the actions it exposes,
   and the canonical scenario that demonstrates the purpose. The
   long-form mapping to Daniel Jackson's concept-design vocabulary
   lives in [`concept-design.md`](../concept-design.md); this
   proposal points there rather than re-litigating it. v0.3 ships this.

Outcome intent (PRDs) sits above all three: a PRD's scenarios link to
outcomes declared at any system-intent kind.

A fourth axis, **outcome / SLO**, is cross-cutting rather than a
layer. SLOs can attach to a concept, a workflow, a boundary, or even a
specific transition. Out of scope until runtime observability adapters
ship in v0.4.

## Arazzo as inspiration for the workflow layer

[Arazzo](https://spec.openapis.org/arazzo/latest.html) (Linux
Foundation, late 2024) describes multi-step API workflows in YAML:
ordered operations with success criteria and output forwarding
between steps. It's the closest existing standard to what v0.2
workflow intent needs for the HTTP slice and worth borrowing
mechanics from. Arazzo only covers HTTP-to-HTTP workflows though, so
the v0.2 schema extends the shape to non-HTTP boundaries (function
calls, queue sends, storage writes) and adds the purpose / audience
wrapper that places a workflow inside a concept.

## Scenarios, and how they link to system intent

A PRD scenario is human-readable on its own and carries an optional
structured link. The full shape (as shipped in `@suss/intent-ir`):

```yaml
scenarios:
  - title: Successful lookup          # optional label
    when: a request arrives with a known user id     # condition, human terms
    expect: the caller receives the user's profile   # expected outcome, human terms
    link: users-lookup.found          # optional structured link
```

`when` and `expect` are what the author writes, always, in their own
terms. Together they're a complete scenario that reads without any
knowledge of the system's internals. `link` is the optional
structured reference: a qualified outcome reference
`<system-intent-name>.<outcome-id>` pointing at a specific transition
or effect in a system intent.

**A scenario without `link` is a valid, deliberate state.** The
author describes the behaviour they want in `when` / `expect` and leaves
the link unset. The checker reports an unlinked scenario as **info**
("scenario not yet linked to a system intent"), not a coverage error;
a team can drop in scenarios and nothing fails. Teams that want the
link mandatory can opt into stricter checking later (a flag, not the
default).

The author doesn't have to know the system intent's outcome ids.
Establishing the link is a **facilitated** step, done by whatever fits
the team: an LLM reading the `when` / `expect` text and proposing a
link, a platform showing candidate outcomes, or an engineer wiring
it by hand. For a new feature there may be no system intent to link to
yet. In that case the facilitator *generates* the system intent from
the scenarios (a third authoring direction; see below) and the link is
established as part of that generation. So `link` carrying
an engineer's id isn't a vocabulary the author has to learn; it's a
slot something else fills.

When `link` is present, the checker resolves it. The dotted form
keeps the link decoupled from the underlying API surface: an endpoint
rename (`GET /users/:id` → `GET /accounts/:id`) doesn't touch the PRD
as long as the system intent's name and outcome ids stay stable. An
ambiguous reference (two system intents share a `name`) is an
authoring error the checker reports; a dangling reference (no matching
name, or a matching name with an unknown outcome id) is reported
distinctly so the author knows whether to rename or to add the
outcome. (Exact finding kinds and severities are settled with the
finding-shape decision below.)

## Worked example #1: Fastify `/users/:id` (v0.1 territory)

See `intent-layer-examples/fastify-users/` for the full files.

The Fastify fixture's `/users/:id` handler has four transitions:
`!id` → 400, `!user` → 404, `user.role === "admin"` → 200 enriched,
default → 200 plain. The system intent declares all four with
matching outcome ids; the PRD references each as a scenario.

Static checks that fire:

- **PRD → system intent (coverage).** Each PRD scenario's `expect`
  resolves to an outcome id in the system intent. No findings when
  intent matches.
- **System intent → derived code (pairing).** Each system intent
  transition pairs against a derived handler transition. No findings
  when shapes match.

Drift demos (kind names as shipped on `IntentFinding`; PRD kinds are
the remaining v0.1 work):

- PRD links a scenario to `users-lookup.deleted` and no system intent
  declares it → `danglingScenarioLink` (proposed name; ships with the
  PRD coverage checker).
- System intent declares `found-admin` but the handler drops the
  admin branch → `uncoveredOutcome`.
- Handler adds a 410 branch (soft-delete) that no system intent
  declares → `undeclaredOutcome`.
- System intent declares body `{ id, fullName }` but the handler
  returns `{ id, name }` → `outcomeShapeMismatch`.

The intent-vs-code drift findings are wired end-to-end in
`@suss/checker-intent` (`uncoveredOutcome`, `undeclaredOutcome`,
`outcomeShapeMismatch`, plus `unimplementedBoundary` for a boundary
with no implementation at all and `unkeyableBoundary` for an intent
whose boundary can't be paired). The PRD-coverage finding is the
remaining v0.1 addition.

## Worked example #2: aws-sqs Orders (v0.2 territory)

See `intent-layer-examples/aws-sqs-orders/` for the full files.

The aws-sqs fixture's `OrderProducer` accepts an order, publishes
`{ id, total }` to `OrdersQueue`, and returns `{ ok: true }`.
`OrderConsumer` reads from the queue and destructures `{ id,
totalAmount }`, an intentional field-name mismatch.

The intent layer expresses this with two `kind: workflow` files plus
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
  body but the PRD still expects `queued-for-processing` to carry the
  order amount → caught by the PRD coverage check (the scenario
  resolves to an outcome whose body no longer matches the PRD's
  stated intent; flagged as `scenarioBodyDrift`, proposed name).

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

Two hops, each independently useful. A team can author either side
first; coverage and pairing fire on whatever's loaded.

## Authoring paths

Intent docs reach the repo three ways, all treated equally: the
reader doesn't distinguish them, they're the same YAML on disk. What
differs is provenance, tracked by the `source` field below.

**Writing intent directly (greenfield).** The team writes intent
declaratively, alongside code or in front of it. PRD first, then
implementation; or both together as the feature is scoped. The
natural path on new features and on small projects where writing
intent against every boundary is tractable.

**Inferring intent from code (brownfield).** Treat the current code
as a stand-in for intent: extract derived summaries, transform them
into starter system intent docs, then have the team curate the result
into team intent. Lower barrier on a project with thousands of
existing endpoints. Different tradeoff: the starter describes what
the code does today, not necessarily what was meant. Shipped by
`suss infer` (below).

**Generating system intent from a PRD (greenfield, facilitated).**
The author writes outcome-intent scenarios in human terms (`when` /
`expect`, no `link`). A facilitator (an LLM, a platform, or an
engineer) reads those scenarios and produces the structural system
intent plus the links back to the scenarios. This is the inverse of
`suss infer`: that direction goes code → system intent; this one goes
described intent → system intent. It's how a new feature gets its
structural layer without the author hand-writing it, and it's what
resolves the "the author shouldn't have to know outcome ids" tension:
the ids are generated, not authored. The facilitation mechanism is
out of scope for v0.1 (the schema supports unlinked scenarios so the
facilitator has something to consume); the generator itself follows.

What does differ is **provenance**, and the design has to carry it
through to make brownfield adoption work:

- Each system intent and PRD carries an optional `source` field with
  values like `"author"` (default; the team wrote this), `"inferred"`
  (straight output of `suss infer`, not yet curated), or
  `"inferred, curated"` (inferred then edited by a person).
- Findings against `inferred` intent that hasn't been curated yet
  are downgraded: the intent describes what the code did when the
  inference ran, so any "intent says X, code does Y" finding is most
  likely a code change since the inference, not an authoring error.
  The team's curation step is what moves intent from `inferred` to
  `inferred, curated`, signalling that drift findings should now fire
  at full severity.
- Inferred intent that's been curated drifts from re-inferred intent
  the same way any spec drifts from code. The refresh workflow
  (re-infer, then merge against curation) is its own scope, sketched
  below.

### `suss infer` (v0.1.1)

`suss infer` walks derived summaries from `suss extract`, picks the
boundaries the team scopes (filter by file glob, by framework, by
boundary kind), and emits one boundary system intent per boundary
with `source: "inferred"`. Outcome ids derive from status codes
(e.g. `200-ok`, `404-not-found`) with a rename step expected during
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

The implementation mostly reshapes fields: derived summary on one
side, boundary intent on the other. The harder design question is the
**refresh** flow when code changes after inference:

1. Naive: re-infer over the existing intent files. Loses curation
   edits.
2. Merge against a baseline: track an `inferred-baseline.yaml`
   snapshot next to each curated intent file. Re-inference produces a
   new baseline; the diff against the previous baseline shows code
   changes; the diff against the curated file shows team edits; the
   tool merges where it can and reports conflicts where it can't. The
   right shape, but not v0.1.1 work; its own ~3-day arc.

For v0.1.1, ship naive re-inference with a clear warning:
"re-inferring over curated intent will overwrite your edits; use
`--into <new-dir>` to write the re-inferred output to a separate
directory for manual reconciliation." Merging against a baseline is
a v0.1.2 / v0.2 follow-on.

### Subset selection

Teams adopting the layer rarely want to generate over the whole
repo. Selection comes from existing filtering at extract time
(`--files`, `-f <framework>`, etc.); `suss infer` reads
the summaries file the team filtered into, so boundary selection
happens before generation.

### Implications for the v0.1 schema

The `source` field needs to be in the schema from v0.1. `suss infer`
is v0.1.1, but if the schema doesn't carry `source` from the start,
curated intent files written in v0.1 can't be told apart from inferred
ones once `suss infer` ships. Adding a default `source: "author"` to
the boundary intent schema in v0.1 keeps the migration path clear.

## Sequencing

| Stage | Adds | Demo fixture | Status |
|---|---|---|---|
| **v0.1** | Boundary system intent + PRD shape + coverage checker + outcome ids on transitions + `source` provenance field | Express `/users/:id` | Shipped: `@suss/ir-core` primitives, `@suss/intent-ir` (schema + summary + `IntentFinding`), `@suss/contract-intent` reader (boundary + prd), `@suss/checker-intent` (`checkIntentAgreement` → findings + checked / unchecked accounting, including PRD scenario coverage and provenance-aware severity downgrade), CLI `suss check --dir --intent`. Remaining: `scenarioBodyDrift` (needs a PRD-side body expectation, which the v0.1 scenario shape doesn't carry; deferred with the v0.2 workflow body grain) |
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
   - `danglingScenarioLink` (link names an intent / outcome no system
     intent declares, including a matched intent whose outcome id is
     unknown, keyed on that intent's boundary)
   - `ambiguousScenarioLink` (multiple system intents share the name)

   Coverage resolves against the loaded system intents and stops
   there: whether the code implements a linked outcome stays the
   boundary pass's job (`uncoveredOutcome` / `unimplementedBoundary`),
   so the two hops remain independently useful and a PRD can be
   checked before any code exists. PRDs move from `unchecked` into
   `checked` accounting (total / resolved / unlinked scenario counts).
2. Provenance-aware severity: findings against `source: "inferred"`
   (not-yet-curated) intent, whether boundary or PRD, are downgraded
   one level; curation restores full severity.
3. Integration coverage: `@suss/checker-intent` and `@suss/cli`
   exercise resolved / unlinked / dangling / ambiguous scenarios plus
   the coverage accounting.

`scenarioBodyDrift` (linked outcome's body disagrees with the PRD's
stated expectation) is deferred: a v0.1 PRD scenario carries `when` /
`expect` / `link` but no body expectation, so there's nothing to
compare against the resolved outcome's body. It lands with the v0.2
workflow body grain, where scenarios reference effect bodies.

**Settled while shipping: malformed specs are load-time errors, not
findings.** The earlier draft listed `intentSpecMalformed` as a
finding kind; the shipped reader throws instead. The distinction the
layer runs on is *pending* vs *broken*: an unlinked scenario or an
unkeyable boundary is a valid pending state (surfaced as info /
warning, run continues), but a doc that fails schema validation is
broken. There's no sound way to partially check it, so the author
must fix it before the run means anything.

## Out of scope, deferred

- **Backward comparison (concept-shape audit).** "Did we ship a
  fused / smeared / phantom concept?" Needs failure-mode detection
  from the existing backlog; ships with v0.3.
- **Lateral comparison (intent vs intent for different audiences).**
  Same concept's PRD for end-users vs admins disagrees. Requires
  audience tagging; defer.
- **Quality specifications (latency, error budget, observability
  obligations).** Per `internal/quality.md`, full intent carries
  quality alongside capability. Defer until capability-only intent is
  in production use.
- **Diff mode** (`suss check --intent intents/ --diff main` →
  findings introduced by the current PR). Worth holding the CLI
  interface open to.
- **Generated intent stubs from existing code.** Reverse mode that
  emits a starter intent spec from a derived summary so teams can
  adopt intent on an existing codebase. Mechanically falls out of v0.2
  once the shape is in production use.
- **LLM-mediated authoring help.** An LLM can suggest outcome ids or
  boundary refs from a PRD's prose at write time; the suggestion is
  committed and reviewed. The LLM stays out of the verification path.
  Out of scope for the v0.1 schema; relevant once teams are authoring
  PRDs at volume.

## Parked refinements (revisit, don't build yet)

Surfaced during design review, deliberately not acted on in v0.1: the
shape isn't settled and rushing it would calcify a guess.

- **Input contract on boundary system intent.** A PRD condition like
  "a *valid* order" has no place to be defined at the system level
  today: the boundary intent declares only `transitions` (outputs),
  not what a well-formed request looks like. Grounding conditions
  (vs outcomes alone) would mean the boundary intent grows an input /
  request-shape declaration, the way OpenAPI has parameters +
  requestBody. The symmetry: `expect` is grounded by linking to an
  outcome; `when` would be grounded by the input contract plus the
  branch guards. Parked; revisit when condition-grounding becomes a
  requirement in practice rather than a v0.1 nicety.
- **Condition-grounding / predicate comparison.** Even with an input
  contract, verifying "the code accepts *exactly* the valid requests"
  means comparing the PRD's condition against the code's branch
  guards. suss has predicate-comparison machinery but it's hard;
  v0.1 leaves `when` as opaque human text and checks outcomes only.
  Tied to the input-contract refinement above.

## Settled architecture decisions

These four were debated during design and are now locked. The
implementation sections below assume them. Recorded here so they don't
live only in conversation.

**Implementation status (feat/intent-checker):** decisions 1 to 3 are
implemented as written: `@suss/ir-core` extracted (with `boundaryKey`
and `bodyShapesMatch` moved there so both checkers share pairing
primitives), `@suss/intent-ir` holds the intent types and the thin
`IntentFinding`, intent serializes to its own files. Decision 4 is
implemented with one deviation and one gap, both flagged below rather
than silently absorbed.

**Decision 4, resolved:** the dispatch point is the CLI, not
`@suss/checker`. The decision's text was written while "separate
package **or a sub-path** of `@suss/checker`" was still open; in the
sub-path world, `@suss/checker` naturally stayed the entry point.
The same decision's package split was taken (the point of the split:
independent evolution), and with two peer packages,
checker-as-orchestrator would force `@suss/checker` to depend on
`@suss/checker-intent`, contradicting `architecture.md`'s IR-only
rule. The decision's stated purpose (one dispatch point,
independent evolution) is satisfied with the CLI in that role. If a
programmatic consumer later wants a one-call check-everything entry,
that's a new thin package above both checkers, not a role added to
`@suss/checker`.

**Decision 2, closed:** the pipeline operates on the shared base as
written. The suppression pipeline (rule schema, matching semantics,
effect application, threshold counting) lives in `@suss/ir-core` over
the thin finding base; `@suss/checker` and `@suss/checker-intent`
each supply only their field matcher, and `.sussignore` rules apply
to both finding streams with identical gating semantics.

**1. Intent gets its own IR package, `@suss/intent-ir`.** Intent is
not a `BehavioralSummary`: a PRD isn't a code unit, and forcing one
into `kind: "library"` with empty transitions and a metadata blob was
the tell that the type was wrong. `@suss/intent-ir` holds the intent
types (PRD / outcome intent, boundary / workflow / concept system
intent). Behaviour stays in `@suss/behavioral-ir`. The two share
primitives: `TypeShape`, boundary identity, status codes,
`SourceLocation`, `Confidence`. Sub-decision (recommended, flag if you
disagree): extract those primitives into a small `@suss/ir-core` that
both import, so neither IR depends on the other. The alternative
(`@suss/intent-ir` importing primitives from `@suss/behavioral-ir`) is
less mechanical work now but makes intent conceptually depend on
behaviour, which it doesn't. Extraction is the bigger one-time change
but ends with neither IR depending on the other.

**2. Intent findings use a thin shared base, not the peer-pairing
`Finding` shape.** The existing `Finding` is built for provider ↔
consumer pairing: symmetric, with `provider` / `consumer` sides and
kinds like `unhandledProviderCase`. Intent findings are asymmetric
(top-down: "we declared X, the code does Y" or "this scenario has no
system intent") and those field names misrepresent the data. The
shared base carries `kind`, `severity`, `description`, `sources`, and
a boundary reference; intent-specific fields (the scenario, the
declared-vs-found pair) live in an intent finding extension. The
pipeline (dedup, suppressions, severity thresholds) operates on the
base. If a case shows the base can't carry what an intent finding
needs, promote to a fully separate type, but start shared.

**3. Intent serializes to its own file, separate from behavioural
summaries.** Behaviour and intent are different artifacts that get
compared, not co-mingled in one stream. A `suss extract` run writes
behavioural summaries; intent docs are their own files; the checker
loads both and compares. No tagged-union-in-one-file.

**4. Checkers split into behavioural and intent, with `@suss/checker`
as the orchestrator.** The intent-vs-code and PRD-coverage checkers
move to their own module (`@suss/checker-intent` or a sub-path);
`@suss/checker` stays the entry point that loads both artifact streams
and dispatches. Keeps the dispatch point single while letting the
intent checkers evolve without churning the behavioural ones.

**Sequencing consequence:** the package split (decision 1) happens
*before* the PRD coverage checker is written, so the checker is
authored once against `@suss/intent-ir` and the thin-base finding
shape rather than retrofitted. The boundary-intent reader and
`checkIntentAgreement` shipped earlier against `@suss/behavioral-ir`;
those migrate into the new packages as part of the split.

## Mechanics

The shapes below are authored in `@suss/intent-ir` per decision 1; the
reader (`@suss/contract-intent`) parses YAML into them. They're shown
as plain interfaces here; the Zod schemas mirror them.

### Schema

A top-level `kind` discriminator over the intent docs:

```ts
type IntentDoc =
  | BoundaryIntent   // kind: "boundary", system intent for one boundary
  | Prd;             // kind: "prd", outcome intent
  // workflow / concept system-intent kinds ship in v0.2 / v0.3
```

`BoundaryIntent` carries an `id` on each transition (the outcome id
PRD scenarios reference) and a `source` provenance field (`"author"`
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

`when` and `expect` are required so every scenario reads on its own;
`link` is optional so a scenario can be authored before it's linked
(or generated alongside its link). `source` distinguishes
hand-authored from inferred / facilitated docs.

### Reader

`@suss/contract-intent` parses files into `IntentDoc` and hands them
to the appropriate checker stream. Directory walks pick up
`*.intent.{yaml,yml,json}` and `*.prd.{yaml,yml,json}`; the reader
dispatches on the top-level `kind`.

### PRD coverage checker

In the intent checker module (decision 4). Given the loaded system
intents and PRDs, for each PRD scenario:

1. If `link` is unset → emit an **info** that the scenario isn't yet
   linked. Not a coverage error (info-by-default; strict mode is an
   opt-in flag).
2. If `link` is set, parse each ref as `<name>.<outcome-id>` and
   resolve against the loaded system intents:
   - no system intent with that `name` → dangling reference finding
   - multiple system intents with that `name` → ambiguous reference
     finding
   - matched name, unknown outcome id → dangling reference finding
     (names the known outcomes so the author can correct)

### Finding kinds

The intent finding kinds live on `IntentFinding` (decision 2) in
`@suss/intent-ir`. Naming convention: no `intent` prefix; the kinds
already live on the intent finding type. Shipped kinds and severities
(rationale in the `@suss/checker-intent` header):

- `unimplementedBoundary` (error): intent boundary has no
  implementing code
- `uncoveredOutcome` (error): declared outcome the code never
  produces
- `outcomeShapeMismatch` (error): matched outcome whose body shapes
  disagree
- `undeclaredOutcome` (info): code produces a REST status the intent
  doesn't declare
- `unkeyableBoundary` (warning): intent boundary can't be keyed for
  pairing; declared coverage isn't happening

Severities follow `contracts.md`'s "severity follows epistemic
character" rule: a derivation violating a specification is an error.
`undeclaredOutcome` is info rather than error because intent docs are
*open* specifications: they declare the floor (what must exist), not
a closed enumeration like an OpenAPI schema. Code exceeding intent is
possibly-missing intent, not a violation.

PRD coverage kinds (proposed, ship with the coverage checker):

- `unlinkedScenario` (info: pending link, the deliberate partial
  state)
- `danglingScenarioLink` (warning: planning gap, named an outcome no
  system intent declares)
- `ambiguousScenarioLink` (warning: author must disambiguate)
- `scenarioBodyDrift` (warning: linked outcome drifted from the
  PRD's expectation)

## Validation

The Fastify worked-example doubles as the v0.1 integration test:

1. Place the PRD + system intent files in
   `fixtures/fastify/intent/` (move from
   `docs/internal/proposals/intent-layer-examples/fastify-users/`).
2. Add `fastifyIntentIntegration.test.ts` to the CLI package that:
   - Extracts handler summaries from `fixtures/fastify/handlers.ts`
   - Reads the intent files via `@suss/contract-intent`
   - Runs `checkAll` over the union
   - Asserts the happy path produces zero intent findings
3. Add fixture variants for each drift case (PRD scenario without a
   system intent target, system intent transition the handler doesn't
   produce, handler transition no system intent declares) and assert
   the corresponding findings fire.

## Doc impact

- New: `docs/guides/author-intent-specs.md`, a how-to for the v0.1
  authoring workflow (PRD + system intent file shapes).
- New: `docs/reference/intent-schema.md`, the schema reference.
- Updated: `docs/contracts.md`. "intent" is now a fourth source
  alongside specification / observation / derivation, with the split
  between PM-authored and engineer-authored intent made visible.
- Updated: `docs/internal/concept-design.md`. The PRD section links
  to this proposal and notes the shipped state once v0.1 ships.
- Updated: `docs/internal/backlog.md`. `#intent-specs` moves to
  "in flight" with the v0.x sequencing.

## Cost estimate (v0.1 completion only)

- Schema discriminator + PRD shape + outcome-id field: half a day
- PRD reader path: half a day
- Coverage checker + finding kinds: 1 day
- Integration test against the Fastify fixture (happy + 3 drift
  cases): 1 day
- Doc updates: half a day

Total: ~3 days for v0.1 to be end-to-end shippable.

v0.2 (workflow grain, non-HTTP boundaries, aws-sqs worked example) is
a separate ~5 days. v0.3 / v0.4 are gated.

## Sequencing notes

- v0.1 is independent of `#46` (adapter ECMAScript ownership). The
  Fastify fixture's `/users/:id` handler extracts fully today.
- v0.2 partially depends on `#46` for any consumer-side workflow
  steps that need `.then` chain binding. The aws-sqs producer /
  consumer demo doesn't (Lambda handlers, no Promise chaining).
- v0.3 depends on the failure-mode detection backlog item.
- v0.4 depends on observation adapters from the backlog.
