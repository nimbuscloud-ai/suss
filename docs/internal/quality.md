# A theory of quality

suss's correspondence checks — does a consumer's expectation
match what the provider produces — are one slice of a larger
question: is the software *good*, in the ways a particular user
or operator would judge it so. This doc names the layers,
identifies how they interact, and maps each one to what suss can
and can't say about it today.

Scope note: internal and aspirational, like
[`concept-design.md`](concept-design.md). Production framing of
the "what's a contract" question lives in
[`contracts.md`](/contracts); this doc is the orthogonal
"what's quality" axis.

## Why correspondence isn't enough

Correspondence says: the provider produces `{200, 404}`, the
consumer reads `{200, 404}`, the contract declares `{200, 404}`
— all three agree. Shipped. Finding count: zero.

Necessary, but not sufficient. A system can have perfect
correspondence and still be bad. Four kinds of failure
correspondence can't see, each a different *reason* the software
is worse than its agreement with itself would suggest:

**Speed failure.** The consumer and provider agree on status
codes and body shapes. The contract declares them too. Every
correspondence check passes. But p99 is four seconds, and the
user sits watching a spinner that never resolves. The software
is doing what it said it would do — just too slowly to be useful.
Nothing in the IR, the contract, or the pairing report surfaces
this; latency isn't a static property of a function's branches.

**Missing capability.** The declared contract matches the code
matches the consumer. All three artifacts agree on what the
endpoint does. The trouble is the user wanted to *update* their
profile and all three artifacts describe a *read*. Every
correspondence check passes because the thing the artifacts
describe is internally consistent; the failure isn't in the
match, it's that nothing in the system matches the task the user
actually has.

**Shape agreement with meaning mismatch.** The provider returns
`200 { status: "deleted" }` for soft-deleted accounts. The
schema validates, the consumer's extracted behavioural summary
pairs cleanly with the provider's, TypeScript checks. But
downstream code reads the `200` as "user is usable" and renders
deleted accounts as if they were active. The shape on the wire
is what everyone agreed to; the *meaning* of that shape diverged.
Types and schemas only catch disagreements about shape —
"`status` is a string" stays true whether the string is `"active"`
or `"deleted"` — so nothing in the correspondence layer flags
this.

**Audience blindness.** Traces are clean, metrics are healthy,
the endpoint is fast, the schema is precise. For an operator
watching the system run, quality looks excellent. Meanwhile
product can't figure out why revenue is off by 3% — the data
they need to answer that question isn't instrumented, because
revenue attribution isn't a concept the system was designed to
expose at all. Quality for the operator audience is high;
quality for the analyst audience is absent. Correspondence has
nothing to say about *whose* question the system answers, only
that the system is consistent with itself.

The four above will reappear as specific facets once the layers
are named below — speed is operational (and feeds back into how
the user experiences the flow); missing capability is the
coarsest user-impedance failure; meaning mismatch is user
impedance at the *outcome* level; audience blindness is what
happens when you forget quality is role-indexed.

Quality is a superset of correspondence. suss names
correspondence precisely and leaves the rest implicit; this doc
names the rest.

## Layer 1 — Impedance quality (user-determined)

Quality in this layer is measured as the *mismatch* between what
a user expects or needs and what the system delivers. Three
facets:

### Whether — can the task be done?

Does a concept exist in the system for the purpose the user has
in mind? This is the coarsest quality failure: not "the system
did it wrong," but "the user can't do the thing."

- End user can't find a way to export their data → the Export
  concept doesn't exist for this audience.
- Operator can't disable a feature without a full deploy → no
  feature-flag concept, or one that doesn't reach their
  vocabulary.
- Developer consuming the API has to POST to a non-idempotent
  endpoint to know if a user exists → no Lookup concept, only
  Create.

*Whether* failures don't show up in any artifact comparison,
because the absent thing has no artifact. They show up in
product feedback, abandonment, operator runbooks full of
workarounds, or developers writing their own wrappers.

### What — does the outcome match what the user expects?

Given the task exists, when the user invokes it, is the
outcome what they expected? This is the facet correspondence
checks cover best — wrong status, wrong body shape, missing
field.

But correspondence covers only the artifacts a consumer
*declared* expectations about. The deeper *what* failure is
when a consumer's expectation was never declared: they assumed
a `200` with a `user` object means the user is usable; the
provider now returns `200 { ...user, status: "deleted" }`. The
code type-checks, the schema validates, the correspondence
passes — the consumer is still wrong about what they got.

### How — does the path to the outcome match how the user expects?

Given the task exists and the outcome is right, does the
*sequence* feel right to the user?

- End user: submit → spinner → success. A two-page modal chain
  before "success" is a *how* failure even though the outcome
  matches.
- Operator: one dashboard → enable flag → observe metric. If
  enabling the flag requires three CLI invocations with opaque
  error messages, the outcome matched, but the *how* is broken.
- Developer: one SDK call gets the user. If it takes three calls
  + a join + pagination, *how* fails.

*How* lives partly in feature-level workflow quality (Layer 1 at
the sync-chain level) and partly in individual action ergonomics
(error messages, argument order, confirmation steps).

## Layer 2 — Operational quality (infrastructural)

When Layer 1 aligns — the task exists, the outcome matches,
the path feels right — operational quality still determines
whether the software behaves well under load, failure, and
adversarial conditions.

- **Availability** — when invoked, does the action fire at all?
- **Latency** — when it fires, is it fast enough to preserve
  L1-*how*?
- **Resiliency** — when something fails, does the system degrade
  predictably? (Retries, circuit breakers, fallbacks, graceful
  denial.)
- **Security** — do actions fire only when they should? Does the
  state the concept protects stay protected?
- **Observability** — when operators need to know why something
  happened, can they?
- **Cost predictability** — does running the system produce
  predictable cost curves, or does a single pathological query
  blow the budget?

Layer 2 **feeds back into Layer 1.** A slow concept fails
L1-*how* for an end user (the spinner never resolves). An
unavailable concept fails L1-*whether* during the outage. A
concept that degrades unpredictably fails L1-*what* — the
outcome shape isn't what was expected because the fallback
returned a different thing.

Layer 2 is also **constrained by business needs independently.**
An SLA of 99.99% isn't what any individual user demanded; it's a
cost / risk / reputation trade set by the organisation. A
latency budget of 200ms isn't what the user asked for; it's
what the business decided is worth engineering effort. The
user-determined ceiling and the business-determined floor meet
somewhere — the *somewhere* is where quality gets negotiated.

## Two orthogonal axes cutting across both layers

### Audience

Quality is role-indexed, same as the OP test in
[`concept-design.md`](concept-design.md#audience-indexing).

- A rate limiter is **L2 quality for operators** — it protects
  the system's availability and cost envelope.
- The same rate limiter is **L1-*how* friction for end users** —
  they hit a 429 and don't know what to do.
- An audit log is **L2 observability for operators**,
  **L1-*whether* quality for compliance roles** (they can answer
  "did this happen"), and **invisible** to end users.

The same code produces different quality readings per audience.
Quality claims that don't name their audience are suspect.

### Epistemic

Quality has the same specified / observed / derived split
[`contracts.md`](/contracts) applies to capabilities.

| Epistemic kind | Shape | Artifacts |
|---|---|---|
| Specified quality | What the system claims it delivers | PRDs, SLAs, error budgets, accessibility standards, security policies |
| Observed quality | What the system actually delivered on some occasion | Traces, metrics, incident reports, user studies, support tickets |
| Derived quality | What the system is *capable* of delivering, across every reachable path | Static analysis (suss), load-test surfaces, threat models |

A well-run system has agreement across all three. Disagreement
is the real signal:

- Specified ⊄ Observed → PRD promises X; production misses X.
  Standard SLO breach.
- Specified ⊄ Derived → the PRD says "this endpoint returns a
  user," suss derives that it can also return 500 from an
  uncaught path. The spec is missing a case.
- Derived ⊄ Observed → reachable behaviour nobody has hit yet.
  Coverage signal.
- Observed ⊄ Derived → something happened in production the code
  shouldn't have produced. High-signal bug or environmental
  surprise.

## Trade-offs as first-class

A theory of quality isn't complete without naming the trade-off
surfaces. Most interesting quality decisions are balances, not
maximisations:

| Surface | + gains | − loses |
|---|---|---|
| Security vs ergonomics | L2-security (protected state, attested actions) | L1-*how* (more steps, more friction) |
| Consistency vs latency | L2-latency (eventual-consistency reads) | L1-*what* (occasionally stale outcomes) |
| Reliability vs feature velocity | L2-availability, L2-resiliency (stable, well-tested surface) | L1-*whether* expansion (fewer new concepts per cycle) |
| Observability vs cost | L2-observability (richer traces/metrics) | L2-cost (storage, ingestion, processing) |
| Specificity vs reusability | L1-*what* (concept fits this audience precisely) | Concept count explosion (more actions, more syncs) |
| Defaults vs control | L1-*how* (one-click flow) | L1-*whether* for power users (no escape hatch for their case) |

Trade-off surfaces live at the architecture level (which ones
we're choosing), at the PRD level (which ones the feature is
taking a position on), and at the code level (which ones this
particular function resolves). Naming them is a precondition
for evaluating them.

## Where suss reaches today

Honest map of reach, same format as
[`concept-design.md`](concept-design.md).

**Reaches:**

- **L1-*what*** (correspondence — outcome matches expectation)
  is suss's core territory. Both the positive case (contracts
  agree) and the negative case (`providerContractViolation`,
  `consumerContractViolation`, `contractDisagreement`) ship
  today.
- **Ambient L1-*how*** — the behavioural summary's branch
  structure maps onto mental-model steps. If a consumer's
  inferred decision tree has four branches where the provider
  has three, that's a mental-model mismatch the inspect output
  makes visible.
- **Audience-adjacent signals** — routes under `/admin`,
  internal SDK packages, operator-only CLIs are statically
  detectable; could be used to tag summaries with audience
  hints.
- **Epistemic split at artifact level** — contracts (spec) vs
  extracted summaries (derived) are compared directly;
  `contractDisagreement` across sources is already shipped.

**Doesn't reach:**

- **L1-*whether*.** No concept of "the task isn't here." Would
  require [intent specs](backlog.md#intent-specs) or PRD-as-data
  (which extends the same backlog item into a full PRD spec),
  plus some form of existence check.
- **L2 operational** as a whole. suss is static; availability,
  latency, and resiliency are runtime properties. But *missing*
  resiliency patterns are detectable — no try/catch around an
  external call, no timeout on a fetch, no retry policy, no
  fallback branch — if packs surface them as recognised shapes.
  This is a useful middle ground: "L2-shaped code smells" suss
  *can* see, even though L2 *outcomes* it can't.
- **Observed quality.** suss doesn't consume traces/metrics.
  Integration point is external (OpenTelemetry → a stub
  adapter), not native.
- **Trade-off awareness.** No representation of "this concept
  takes position X on surface Y." Would require trade-off
  taxonomy as declared metadata on concepts or on PRDs.

## Aspirational implications

Ordered by leverage per unit of engineering lift. Direct analogue
to the aspirational section of
[`concept-design.md`](concept-design.md#aspirational-implications).

1. **L2-shaped pattern packs.** Recognise common resilience
   patterns (`retry`, `circuitBreaker`, `withTimeout`, `fallback`)
   as framework-pack terminal or effect matches, same interface
   as HTTP-status extraction. When they're *absent* from a code
   unit whose role suggests they should be present (an external
   API call with no timeout, a handler with no error boundary),
   that's a derivable finding. L2-adjacent signal from static
   source. Lowest-lift, highest-leverage L2 win.
2. **Observation adapters.** A stub that reads a set of traces or
   production logs and emits `BehavioralSummary`-shaped
   observation records at the same boundaries. Lets
   `contractDisagreement`-style checks run across spec /
   derivation / observation triples. Foundation for the full
   epistemic split at the quality layer, not just capabilities.
3. **Trade-off annotations.** A declared metadata layer ("this
   concept takes the consistency side of the consistency/latency
   surface") that can be compared against derived behaviour
   ("the code is checking a cache-only read path — the
   declaration and code agree") and against observed behaviour
   ("p99 latency supports the consistency claim" or contradicts
   it). Hard part: the taxonomy of trade-off surfaces has to be
   stable and extensible. Probably follows the contract-shape
   taxonomy pattern.
4. **Audience tagging.** Already listed in
   [`concept-design.md`](concept-design.md#aspirational-implications)
   §2; doubles as the axis that indexes quality. Unblocks
   multi-audience quality reports (same system, different
   readings).
5. **PRD as quality specification, not just capability
   specification.** An intent spec that names only what the
   feature does captures half the contract. A fuller one names
   *how well* — error budget, acceptable latency, edge-case
   handling, observability obligations. This expands the scope
   of [intent specs](backlog.md#intent-specs) from "capability
   spec" to "full PRD spec."
6. **Feature-level quality.** Sync chains compose into features;
   features have quality properties (end-to-end latency, all-or-
   nothing resilience, compensating-action availability) that
   individual actions don't. Depends on [sync-chain
   identification](backlog.md#sync-chains); naturally extends
   to feature-scoped quality findings.

## Open threads

- **Trade-off taxonomy.** The trade-off table above is illustrative,
  not canonical. A well-formed taxonomy needs stable names, clear
  polarity (what counts as "more" on each axis), and overlap /
  orthogonality claims between surfaces. Likely a research
  artifact in itself before it's encoded.
- **Quality contract shapes.** [`contracts.md`](/contracts)
  enumerates shapes of capability contracts (schema, examples,
  tests, snapshots, design). Quality contracts have their own
  shapes — SLAs, error budgets, accessibility standards,
  performance budgets. They're not the same taxonomy and haven't
  been enumerated yet.
- **Whose quality?** The audience-indexing story assumes we can
  name the audience. Some audiences are coded in (route prefix,
  CLI namespace); others are convention-only; some change over
  time (a developer audience that becomes operator-shaped as the
  SDK grows). Pure inference won't cover all of it; pure
  declaration creates maintenance load.

## References

Cross-references within suss:

- [`concept-design.md`](concept-design.md) — Jackson mapping,
  audience indexing, OP test. Quality's L1-*whether* and the OP
  test are the same test asked from different directions.
- [`contracts.md`](/contracts) — the three epistemic kinds
  (specification / observation / derivation). This doc reuses
  that split at the quality axis.
- [`cross-boundary-checking.md`](/cross-boundary-checking) — the
  shipped subset of L1-*what*.
- [`backlog.md`](backlog.md) — forward-looking items that unblock
  pieces of the quality layers: [intent specs](backlog.md#intent-specs),
  [sync-chain identification](backlog.md#sync-chains),
  [event/temporal/absence sync packs](backlog.md#non-call-syncs),
  [L2-shaped pattern packs](backlog.md#l2-patterns),
  [observation adapters](backlog.md#observation-adapters),
  [trade-off annotations](backlog.md#tradeoff-annotations),
  [audience annotation](backlog.md#audience-annotation).

External groundings:

- Quality-in-use as user-determined is an old HCI thread; ISO
  25010 names the attributes but flattens the layering. This
  doc's two-layer impedance/operational split is closer to
  Garvin's 1987 dimensions of quality than to ISO's flat list.
- The specified / observed / derived split comes directly from
  the same epistemic move made in [`contracts.md`](/contracts);
  no new sourcing.
- Trade-off surfaces as first-class have antecedents in Parnas's
  work on information hiding and in Bass/Clements/Kazman's
  software architecture literature (quality attributes as
  trade-off drivers), but the mapping to sync-chain features
  here is suss-specific.
