# Cross-Boundary Checking

Given behavioral summaries for two sides of a boundary, a provider (the handler producing a response) and a consumer (the call site reading it), is their behavior compatible?

This document covers the checker mechanics: which comparisons run, what the IR gives them to work with, and the findings they emit. For the contract taxonomy those comparisons rest on, the three kinds of truth and the three contracts at every boundary, see [`contracts.md`](contracts.md). For the design of `BehavioralSummary` itself, see [`ir-reference.md`](ir-reference.md); for the extraction story, see [`architecture.md`](architecture.md).

**Shipping scope: HTTP (REST), GraphQL resolver↔operation, and in-process function-call (package exports).** REST is the dispatch-dominant case, status code as the outcome discriminator, response body as the payload, `(method, normalizedPath)` as the pairing key. GraphQL resolvers pair by `(typeName, fieldName)`. In-process `function-call` pairs by `fn:<package>::<exportPath>`, introduced with the `packageExports` / `packageImport` discovery variants so a library's provider summaries pair with every caller that imports from it. See [`boundary-semantics.md`](boundary-semantics.md) for the layered model; see [`reference/pack-patterns.md`](reference/pack-patterns.md) for the discovery variants.

## The comparison matrix

Every boundary carries three contracts, the declared contract (a specification), the provider's inferred contract, and the consumer's inferred contract (both derivations). [`contracts.md`](contracts.md#the-three-contracts-at-a-boundary) defines them. The checker's job is to compare them pairwise; each comparison catches a different class of failure.

<svg class="suss-diagram" viewBox="0 0 660 300" role="img" aria-labelledby="matrix-title matrix-desc">
  <title id="matrix-title">The three contracts at one boundary</title>
  <desc id="matrix-desc">One boundary, GET /users/:id, carries a declared contract that is a specification, and two derivations, one read from the provider's code and one from the consumer's. Arrows show which pairs the checker compares and what each comparison catches.</desc>

  <defs>
    <marker id="matrix-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="axis" x="330" y="16" text-anchor="middle">One boundary: GET /users/:id</text>

  <rect class="box-data" x="215" y="34" width="230" height="52" rx="6" />
  <text class="label" x="330" y="54" text-anchor="middle">Declared contract</text>
  <text class="note" x="330" y="72" text-anchor="middle">a specification: OpenAPI, SDL, a SAM template</text>

  <rect class="box" x="20" y="200" width="250" height="70" rx="6" />
  <text class="label" x="145" y="222" text-anchor="middle">Provider's behaviour</text>
  <text class="note" x="145" y="240" text-anchor="middle">a derivation, read from the handler</text>
  <text class="note" x="145" y="257" text-anchor="middle">"404 when the user is missing"</text>

  <rect class="box" x="390" y="200" width="250" height="70" rx="6" />
  <text class="label" x="515" y="222" text-anchor="middle">Consumer's expectations</text>
  <text class="note" x="515" y="240" text-anchor="middle">a derivation, read from the call site</text>
  <text class="note" x="515" y="257" text-anchor="middle">"handles 200 and 500"</text>

  <line class="arrow" x1="270" y1="80" x2="160" y2="196" marker-end="url(#matrix-arrow)" />
  <text class="note" x="150" y="124" text-anchor="middle">does the code</text>
  <text class="note" x="150" y="140" text-anchor="middle">do what it promised?</text>

  <line class="arrow" x1="390" y1="80" x2="500" y2="196" marker-end="url(#matrix-arrow)" />
  <text class="note" x="512" y="124" text-anchor="middle">does the caller expect</text>
  <text class="note" x="512" y="140" text-anchor="middle">what was promised?</text>

  <line class="arrow" x1="270" y1="235" x2="386" y2="235" marker-end="url(#matrix-arrow)" />
  <line class="arrow" x1="390" y1="248" x2="274" y2="248" marker-end="url(#matrix-arrow)" />
  <text class="note" x="330" y="192" text-anchor="middle">do the two sides agree</text>
  <text class="note" x="330" y="285" text-anchor="middle">about statuses, sub-cases, and body fields?</text>
</svg>

| Comparison | What it catches | Implemented |
|---|---|---|
| Provider inferred vs declared | Handler never produces declared status. Handler produces undeclared status. Body shape doesn't match schema. | Yes (`checkContractConsistency`) |
| Provider inferred vs consumer inferred (status) | Provider returns 404, consumer doesn't handle it. Consumer handles 410, provider never produces it. | Yes (`checkProviderCoverage`, `checkConsumerSatisfaction`) |
| Provider inferred vs consumer inferred (sub-cases) | Provider has two 200s (active vs deleted user), consumer has one 200 branch. | Yes (`checkProviderCoverage` sub-case analysis) |
| Provider inferred vs consumer inferred (body fields) | Consumer reads `body.email` but provider's 200 response doesn't include it. | Yes (`checkBodyCompatibility`) |
| Consumer inferred vs declared | Consumer reads `body.role` but the declared 200 schema doesn't include `role`. Consumer depends on an undeclared implementation detail. | Yes (`checkConsumerContract`) |
| Provider output ↔ consumer conditions (semantic bridging) | Provider's `user.deletedAt` transition produces body with `status: "deleted"`. Consumer tests `body.status === "deleted"`. These are the same behavioral case expressed in different domains. | Yes (`checkSemanticBridging`) |

## What's checked today

The checker compares status-code coverage in both directions, detects when a consumer collapses provider sub-cases that share a status code, compares the body fields a consumer reads against what the provider produces (and against the declared contract), and traces subjects through intermediate variables so a condition on `const data = result.body` still resolves back to the response. It also bridges semantic conditions: when a provider puts `status: "deleted"` in a 200 body on the `user.deletedAt` branch and the consumer never tests `body.status`, the sub-case flows through undistinguished and the checker reports it. That last comparison is where suss catches the motivating example, a 200 that changed meaning, end to end.

The depth of comparison has grown in stages, and some layers remain in progress, local-function inlining, complement reasoning on negated conditions, additional body accessors beyond `.body` and `.json()`.

## How the IR supports comparison

**Transitions are atomic.** Each transition is `(conditions → output, effects)` with a stable `id`. Matching happens at the transition level.

**Predicates are structural, not textual.** A predicate is `{ subject, test }`, not a source string. Structured predicates can be compared across boundaries where the same concept appears in different forms.

**Subjects have identity.** `ValueRef` records where a value came from (parameter, dependency call, derived property access) as a traversable DAG. On the provider side, `user.deletedAt` resolves to `derived(dependency("db.findById"), propertyAccess("deletedAt"))`. On the consumer side, `result.body.status` resolves to `derived(derived(dependency("client.getUser"), propertyAccess("body")), propertyAccess("status"))`. Semantic bridging works by matching the provider's *output body field paths* against the consumer's *subject derivation chains*.

**`expectedInput` captures what the consumer reads.** Each client transition has an optional `expectedInput: TypeShape` representing the response body fields the consumer accesses within that branch. This is inferred from property access chains on the response variable, no annotation needed.

**Opaque predicates surface uncertainty explicitly.** When decomposition fails, the checker emits `lowConfidence` rather than a false negative.

**Gaps carry forward.** Provider gaps (declared-but-not-produced, produced-but-not-declared) flow through the checker as `providerContractViolation` findings.

## Output: findings

```typescript
interface Finding {
  kind: FindingKind;  // see /reference/findings for the full catalog
  boundary: BoundaryBinding;
  provider: { summary: string; transitionId?: string; location: SourceLocation };
  consumer: { summary: string; transitionId?: string; location: SourceLocation };
  description: string;
  severity: "error" | "warning" | "info";
  sources?: string[];               // present when dedupe collapsed multiple
  suppressed?: FindingSuppression;  // present when a .sussignore rule matched
}
```

`FindingKind` spans REST coverage / consumer satisfaction / contract consistency, GraphQL operation pairing, React-component / Storybook agreement, storage-relational field pairing, message-bus producer / consumer / queue pairing, runtime-config env-var pairing, and meta-findings (`lowConfidence`, `unsupportedSemantics`, `opaquePredicateBlocking`). The authoritative enumeration is `FindingKindSchema` in `packages/ir/src/schemas.ts`; the [findings catalog](/reference/findings) groups every kind by domain with severity, emitter, and example.

Findings are JSON-serializable. The CLI exits non-zero when any `error`-severity finding exists (tunable via `--fail-on`).

**Accepted findings.** When a finding is true but intentionally tolerated (e.g. "this consumer genuinely doesn't need to handle 500"), a `.sussignore.yml` file at the project root can `mark`, `downgrade`, or `hide` it. `mark` keeps the finding visible but excludes it from exit-code; `downgrade` drops severity one level; `hide` removes it entirely. See [`suppressions.md`](suppressions.md) for the full format. The `Finding.suppressed` field on output carries the rule's reason and effect so downstream tools can distinguish accepted-and-known from silently-ignored.

**Cross-source contract agreement.** When multiple providers describe the same boundary (an OpenAPI contract + a CloudFormation contract for the same endpoint, say), they each carry their own declared contract. `checkContractAgreement` (invoked automatically by `checkAll`) compares those contracts to each other and emits `contractDisagreement` findings when they don't match, "sources disagree on whether status 500 exists at `GET /pet/:id`," for example. This runs at the contract level only (`{statusCode, body}` tuples), independent of transitions, so 3+ sources produce one finding per non-unanimous status rather than an N-way pairwise explosion. Layer 1 (`checkContractConsistency`) still answers the orthogonal "is each provider consistent with its own contract?" question; Layer 2 adds cross-source agreement on top of that without replacing it. The `declaredContract.provenance` field ("derived" vs "independent") tells Layer 1 whether a provider's transitions and contract share a source, OpenAPI contracts are "derived" (self-comparison skipped); CFN contracts and extracted handlers with authored contracts are "independent."

**Confidence is informational, not prescriptive.** Each summary carries `ConfidenceInfo` (high / medium / low, plus source) reflecting how well the extractor decomposed the source, how many opaque predicates it fell back to, whether wrapper-expansion inferred the summary indirectly, etc. The checker does **not** downgrade severities based on it; the `lowConfidence` finding kind is the per-finding mechanism for "I couldn't decide." Summary-level confidence is a different axis (analysis quality on one side) and conflating it with finding certainty would hide both. The human `suss check` output appends `(confidence: medium|low)` after a provider or consumer side whose confidence is below `high`, so reviewers can weigh findings themselves; downstream tools (dashboards, docs generators) can read `summary.confidence` from the JSON output and apply their own policy if they want one.

## Scope

### In scope (OSS)

- The `suss check <provider.json> <consumer.json>` command, pairwise, local, stateless.
- Deterministic findings output (JSON or human-readable).
- The comparisons described above, status-code coverage, sub-case detection, field-presence, consumer-vs-declared, subject resolution, and semantic bridging.
- Library API so other tools can call the checker programmatically.

### Beyond pairwise

The checker compares two summaries at a time. Every analysis layer above that, aggregating summaries across a whole organization, tracking boundaries over commits, alerting on behavioral regressions, answering "which PRs break which consumers", is a separate concern. Those layers consume `BehavioralSummary[]` and pairwise findings as their input.

The OSS scope stops at producing summaries and running local checks. It's designed so aggregation layers are straightforward to build on top (summaries are stable JSON, findings are structured), but this repository does not include them.
