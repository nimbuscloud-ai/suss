# A theory of quality

suss checks correspondence: whether a consumer's expectation
matches what the provider produces. That is one part of a larger
question, which is whether the software is *good* in the ways a
particular user or operator would judge it. Below, each layer of
that question gets a name, along with how the layers interact and
what suss can and can't say about each one today.

Scope note: this is internal and aspirational, like
[`concept-design.md`](../../docs/theory/prior-art.md). The
production treatment of "what is a contract" is in
[`contracts.md`](/contracts). This doc is about a separate
question, "what is quality". Links below that go to GitHub point
at design records under `design/`. Those are proposals and working
notes, and they are not documentation.

## Why correspondence isn't enough

Correspondence looks like this. The provider produces
`{200, 404}`, the consumer reads `{200, 404}`, and the contract
declares `{200, 404}`. All three agree, it ships, and the finding
count is zero.

Correspondence is necessary but not sufficient. A system can have
perfect correspondence and still be bad. There are four kinds of
failure that correspondence can't see, and each is a different
*reason* the software is worse than its agreement with itself
would suggest.

**Speed failure.** The consumer and provider agree on status
codes and body shapes, and the contract declares them too. Every
correspondence check passes. But p99 is four seconds, and the
user sits watching a spinner that never resolves. The software
does what it said it would, only too slowly to be useful. Nothing
in the IR, the contract or the pairing report shows this, because
latency is not a static property of a function's branches.

**Missing capability.** The declared contract matches the code,
and the code matches the consumer. All three agree on what the
endpoint does. The trouble is that the user wanted to *update*
their profile, and all three describe a *read*. Every
correspondence check passes because the three descriptions agree
with each other. Nothing in the system matches the task the user
has.

**Shape agreement with meaning mismatch.** The provider returns
`200 { status: "deleted" }` for soft-deleted accounts. The schema
validates, the consumer's extracted behavioural summary pairs with
the provider's, and TypeScript checks. But downstream code reads
the `200` as "user is usable" and renders deleted accounts as if
they were active. Everyone agreed on the shape on the wire, and
they disagree about what that shape *means*. Types and schemas only
catch disagreements about shape. "`status` is a string" stays true
whether the string is `"active"` or `"deleted"`, so nothing in the
correspondence layer flags this.

**Audience blindness.** Traces show no errors, metrics are
healthy, the endpoint is fast and the schema is precise. To an
operator watching the system run, quality looks excellent.
Meanwhile the product team can't work out why revenue is off by
3%. The data they need is not instrumented, because the system
was never designed to expose revenue attribution. Quality is high
for the operator and missing for the analyst. Correspondence can
only say that the system agrees with itself. It has nothing to say
about *whose* questions the system answers.

Each of these four comes back as a specific facet once the layers
below have names. Speed is operational, and it feeds back into how
the user experiences the flow. Missing capability is the coarsest
failure of user impedance. Meaning mismatch is user impedance at
the level of the *outcome*. Audience blindness is what happens when
you forget that quality depends on who is judging.

Quality is a superset of correspondence. suss describes
correspondence precisely and leaves the rest implicit, and this
doc tries to describe the rest.

## Layer 1: Impedance quality (user-determined) {#layer-1--impedance-quality-user-determined}

In this layer, quality is the *mismatch* between what a user
expects or needs and what the system delivers. It has three
facets.

### Whether: can the task be done?

Does the system have a concept for the purpose the user has in
mind? This is the coarsest quality failure. The system did not do
the thing wrong. The user can't do the thing at all.

- An end user can't find a way to export their data → the Export
  concept doesn't exist for this audience.
- An operator can't disable a feature without a full deploy →
  there is no feature-flag concept, or there is one the operator
  has no way to reach.
- A developer using the API has to POST to a non-idempotent
  endpoint to find out whether a user exists → there is no Lookup
  concept, only Create.

*Whether* failures don't show up in any comparison of artifacts,
because the missing thing has no artifact. They show up in product
feedback and abandonment, in operator runbooks full of
workarounds, and in developers writing their own wrappers.

### What: does the outcome match what the user expects?

If the task exists and the user invokes it, is the outcome what
they expected? Correspondence checks cover this facet best: a
wrong status, a wrong body shape, a missing field.

But correspondence only covers what a consumer *declared*
expectations about. The deeper *what* failure is an expectation
the consumer never declared. They assumed that a `200` with a
`user` object means the user is usable, and the provider now
returns `200 { ...user, status: "deleted" }`. The code
type-checks, the schema validates and the correspondence passes,
and the consumer is still wrong about what they got.

### How: does the path to the outcome match how the user expects?

If the task exists and the outcome is right, does the *sequence*
feel right to the user?

- End user: submit → spinner → success. A two-page modal chain
  before "success" is a *how* failure even though the outcome
  matches.
- Operator: one dashboard → enable flag → observe metric. If
  enabling the flag takes three CLI invocations with opaque error
  messages, the outcome matched but the *how* is broken.
- Developer: one SDK call gets the user. If it takes three calls
  plus a join plus pagination, *how* fails.

*How* depends partly on the quality of the workflow across a
feature (Layer 1 at the level of sync chains) and partly on the
ergonomics of each action, such as error messages, argument order
and confirmation steps.

## Layer 2: Operational quality (infrastructural)

Even when Layer 1 lines up (the task exists, the outcome matches,
and the path feels right), operational quality still decides
whether the software behaves well under load, under failure and
under attack.

- **Availability**: when invoked, does the action fire at all?
- **Latency**: when it fires, is it fast enough to keep
  L1-*how* intact?
- **Resiliency**: when something fails, does the system degrade
  predictably? (Retries, circuit breakers, fallbacks, controlled
  denial.)
- **Security**: do actions fire only when they should? Does the
  state the concept protects stay protected?
- **Observability**: when operators need to know why something
  happened, can they find out?
- **Cost predictability**: does the system's cost grow in a
  predictable way, or can a single pathological query blow the
  budget?

Layer 2 **feeds back into Layer 1.** A slow concept fails
L1-*how* for an end user, because the spinner never resolves. An
unavailable concept fails L1-*whether* for as long as the outage
lasts. A concept that degrades unpredictably fails L1-*what*: the
fallback returned something different, so the outcome is not what
the user expected.

Layer 2 is also **constrained by business needs on their own.**
No individual user asked for an SLA of 99.99%. The organisation
set it as a trade between cost, risk and reputation. No user
asked for a latency budget of 200ms either. The business decided
that number was worth the engineering effort. The ceiling users
set and the floor the business sets meet somewhere, and quality
gets negotiated at that point.

## Two orthogonal axes cutting across both layers

### Audience

Quality depends on the role of whoever judges it, the same as the
OP test in [`concept-design.md`](../concept-design.md#audience-indexing).

- A rate limiter is **L2 quality for operators**, because it
  protects the system's availability and cost limits.
- The same rate limiter is **L1-*how* friction for end users**.
  They hit a 429 and don't know what to do.
- An audit log is **L2 observability for operators**. It is
  **L1-*whether* quality for compliance roles**, because they can
  answer "did this happen". End users never see it.

Each audience judges the same code differently. Be suspicious of a
quality claim that doesn't say who its audience is.

### Epistemic

Quality splits into specified, observed and derived, the same way
[`contracts.md`](/contracts) splits capabilities.

| Epistemic kind | Shape | Artifacts |
|---|---|---|
| Specified quality | What the system claims it delivers | PRDs, SLAs, error budgets, accessibility standards, security policies |
| Observed quality | What the system actually delivered on some occasion | Traces, metrics, incident reports, user studies, support tickets |
| Derived quality | What the system is *capable* of delivering, across every reachable path | Static analysis (suss), load-test surfaces, threat models |

In a well-run system all three agree. Where they disagree, the
disagreement tells you something:

- Specified ⊄ Observed → the PRD promises X and production misses
  X. This is an ordinary SLO breach.
- Specified ⊄ Derived → the PRD says "this endpoint returns a
  user", and suss derives that it can also return 500 from an
  uncaught path. The spec is missing a case.
- Derived ⊄ Observed → behaviour that is reachable but nobody has
  hit yet. This is a coverage signal.
- Observed ⊄ Derived → something happened in production that the
  code shouldn't have produced. This is either a bug worth chasing
  or a surprise in the environment.

## Trade-offs as named surfaces {#trade-offs-as-named-surfaces}

A theory of quality needs names for the trade-offs. Most
interesting quality decisions balance two things against each
other and do not maximise either:

| Surface | + gains | − loses |
|---|---|---|
| Security vs ergonomics | L2-security (protected state, attested actions) | L1-*how* (more steps, more friction) |
| Consistency vs latency | L2-latency (eventual-consistency reads) | L1-*what* (occasionally stale outcomes) |
| Reliability vs feature velocity | L2-availability, L2-resiliency (stable, well-tested surface) | L1-*whether* expansion (fewer new concepts per cycle) |
| Observability vs cost | L2-observability (richer traces/metrics) | L2-cost (storage, ingestion, processing) |
| Specificity vs reusability | L1-*what* (concept fits this audience precisely) | Concept count explosion (more actions, more syncs) |
| Defaults vs control | L1-*how* (one-click flow) | L1-*whether* for power users (no escape hatch for their case) |

Trade-offs get decided at three levels. The architecture decides
which ones we are choosing, the PRD decides which ones a feature
takes a position on, and the code decides which ones a particular
function resolves. You have to name a trade-off before you can
evaluate it.

## Where suss reaches today

This follows the same format as the map of reach in
[`concept-design.md`](../../docs/theory/prior-art.md).

**Reaches:**

- **L1-*what*** (correspondence: the outcome matches the
  expectation) is suss's core territory. Both the positive case,
  where contracts agree, and the negative case
  (`providerContractViolation`, `consumerContractViolation`,
  `contractDisagreement`) ship today.
- **Ambient L1-*how***: the branch structure of a behavioural
  summary maps onto the steps in someone's mental model. If a
  consumer's inferred decision tree has four branches where the
  provider has three, the inspect output shows that mismatch.
- **Signals close to audience**: routes under `/admin`, internal
  SDK packages and operator-only CLIs can be detected statically,
  and we could use them to tag summaries with audience hints.
- **The epistemic split at the level of artifacts**: suss compares
  contracts (specified) with extracted summaries (derived)
  directly, and `contractDisagreement` across sources already
  ships.

**Doesn't reach:**

- **L1-*whether*.** suss has no concept of "the task isn't here".
  It would need [intent
  specs](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#intent-specs) or PRD-as-data (which extends
  the same backlog item into a full PRD spec), plus some kind of
  existence check.
- **L2 operational** as a whole. suss is static, and availability,
  latency and resiliency are runtime properties. But *missing*
  resiliency patterns can be detected if packs recognise them:
  no try/catch around an external call, no timeout on a fetch, no
  retry policy, no fallback branch. That is a useful middle
  ground. suss *can* see code that suggests an L2 problem, even
  though it can't see L2 *outcomes*.
- **Observed quality.** suss doesn't read traces or metrics. That
  integration would live outside suss (OpenTelemetry → a stub
  adapter) and would not be built in.
- **Trade-off awareness.** Nothing represents "this concept takes
  position X on surface Y". That would need a taxonomy of
  trade-offs, declared as metadata on concepts or on PRDs.

## Aspirational implications

These are ordered by how much they give per unit of engineering
effort. The section mirrors the aspirational section of
[`concept-design.md`](../concept-design.md#aspirational-implications).

1. **L2-shaped pattern packs.** Recognise common resilience
   patterns (`retry`, `circuitBreaker`, `withTimeout`, `fallback`)
   as framework-pack terminal or effect matches, through the same
   interface as HTTP-status extraction. When one is *absent* from a
   code unit whose role suggests it should be there, such as an
   external API call with no timeout or a handler with no error
   boundary, suss can derive a finding. This is a signal about L2
   that we can get from static source, and it is the L2 win with
   the lowest effort and the highest payoff.
2. **Observation adapters.** A stub that reads a set of traces or
   production logs and emits observation records shaped like a
   `BehavioralSummary` at the same boundaries. That would let checks
   like `contractDisagreement` run across spec, derivation and
   observation together. It is the foundation for the full
   epistemic split at the quality layer, and not only for
   capabilities.
3. **Trade-off annotations.** A layer of declared metadata ("this
   concept takes the consistency side of the consistency/latency
   surface") that suss can compare with derived behaviour ("the
   code is checking a cache-only read path; the declaration and
   code agree") and with observed behaviour ("p99 latency supports
   the consistency claim", or contradicts it). The hard part is
   that the taxonomy of trade-off surfaces has to be stable and
   extensible. It will probably follow the same pattern as the
   taxonomy of contract shapes.
4. **Audience tagging.** This is already listed in
   [`concept-design.md`](../concept-design.md#aspirational-implications)
   §2. Audience is also the axis quality depends on, so tagging it
   makes quality reports for several audiences possible: the same
   system, judged differently by each one.
5. **PRD as quality specification, not capability specification
   alone.** An intent spec that only says what the feature does
   covers half the contract. A fuller one says *how well*: the
   error budget, acceptable latency, how edge cases are handled,
   and what has to be observable. This would widen
   [intent specs](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#intent-specs) from a "capability
   spec" to a "full PRD spec".
6. **Feature-level quality.** Sync chains compose into features,
   and features have quality properties that single actions don't,
   such as end-to-end latency, all-or-nothing resilience, and
   whether a compensating action is available. This depends on
   [sync-chain
   identification](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#sync-chains), and it leads on to
   quality findings scoped to a feature.

## Open threads

- **Trade-off taxonomy.** The trade-off table above is an
  illustration, and it is not a canonical list. A well-formed
  taxonomy needs stable names, a clear polarity (what counts as
  "more" on each axis), and statements about which surfaces
  overlap and which are independent. It is probably a research
  project of its own before anyone encodes it.
- **Quality contract shapes.** [`contracts.md`](/contracts) lists
  the shapes a capability contract can take (schema, examples,
  tests, snapshots, design). Quality contracts have their own:
  SLAs, error budgets, accessibility standards, performance
  budgets. That is a different taxonomy, and nobody has listed it
  yet.
- **Whose quality?** Indexing by audience assumes we can say who
  the audience is. Some audiences are coded in, through a route
  prefix or a CLI namespace. Others are only a convention. Some
  change over time, as when a developer audience starts to look
  like an operator audience while the SDK grows. Inference alone
  won't cover all of it, and declaring audiences by hand creates
  maintenance work.

## References

Cross-references within suss:

- [`concept-design.md`](../../docs/theory/prior-art.md): the
  Jackson mapping, audience indexing and the OP test. Quality's
  L1-*whether* and the OP test are the same test asked from
  different directions.
- [`contracts.md`](/contracts): the three epistemic kinds
  (specification, observation, derivation). This doc reuses that
  split for quality.
- [`cross-boundary-checking.md`](/cross-boundary-checking): the
  part of L1-*what* that ships.
- [The backlog design record](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md): items
  that would unblock parts of the quality layers: [intent specs](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#intent-specs),
  [sync-chain identification](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#sync-chains),
  [event/temporal/absence sync packs](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#non-call-syncs),
  [L2-shaped pattern packs](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#l2-patterns),
  [observation adapters](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#observation-adapters),
  [trade-off annotations](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#tradeoff-annotations),
  [audience annotation](https://github.com/nimbuscloud-ai/suss/blob/main/design/backlog.md#audience-annotation).

External sources:

- Treating quality-in-use as something the user decides is an old
  thread in HCI. ISO 25010 lists the attributes but flattens the
  layers into one list. The two-layer split here, impedance and
  operational, is closer to Garvin's 1987 dimensions of quality
  than to ISO's flat list.
- The specified, observed and derived split comes directly from
  the same move in [`contracts.md`](/contracts), with no new
  sources.
- Naming trade-off surfaces goes back to Parnas's work on
  information hiding and to Bass, Clements and Kazman's software
  architecture books, which treat quality attributes as drivers of
  trade-offs. Mapping them onto features built from sync chains is
  specific to suss.
