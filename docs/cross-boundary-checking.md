# Cross-Boundary Checking

Given behavioral summaries for two sides of a boundary — a provider (the handler producing a response) and a consumer (the call site reading it) — is their behavior compatible?

This document is the canonical reference for how suss behavioral analysis works: the conceptual model, the analysis levels, what the checker does today, and where it's heading. For the design of `BehavioralSummary` itself, see [`ir-reference.md`](ir-reference.md); for the extraction story, see [`architecture.md`](architecture.md).

**Shipping scope: HTTP (REST).** The checker's current logic assumes REST boundary semantics throughout — HTTP status code as the outcome discriminator, response body as the payload, `(method, normalizedPath)` as the pairing key, the 2xx range as "success." None of the check functions below generalize to non-HTTP boundaries yet. When a second semantics lands (GraphQL, Lambda-invoke, queue messages, gRPC), the check functions get refactored to dispatch through a `BoundarySemantics` interface rather than hardcoding REST operations. See [`boundary-semantics.md`](boundary-semantics.md) for the target shape.

## The three contracts

Every API boundary has three behavioral contracts, whether anyone writes them down or not.

### 1. The declared contract (authored, optional)

ts-rest `responses`, OpenAPI schema, GraphQL SDL. Says what statuses and shapes are *supposed* to exist. This is what most tools check against. It's authored by a human, so it can be wrong, incomplete, or out of date — but when it exists, it's the shared source of truth between provider and consumer teams.

### 2. The provider's inferred contract (extracted from implementation)

The actual set of transitions — under condition A the provider produces output X, under condition B it produces output Y. This is richer than the declared contract because it captures:

- **Sub-cases within a status code.** A declared contract says "200 returns User." The inferred contract says "200 returns `{ ...user }` when `!user.deletedAt`, and 200 returns `{ ...user, status: "deleted" }` when `user.deletedAt`." Two behavioral cases that the declared contract collapses into one.
- **Body shape variation per condition.** Each transition has its own `Output.body` shape. Different conditions produce different shapes, even for the same status code.
- **Gaps.** The declared contract says 500 is possible; the implementation never produces it. Or the implementation returns 418, which the contract doesn't declare.

### 3. The consumer's inferred contract (extracted from call-site code)

What the consumer actually *depends on*: which status codes it branches on, which body fields it reads, what conditions it tests on the response. This contract is **never explicitly defined** — not in OpenAPI, not in types, not in Pact tests (unless someone thinks to write the specific example). It's the invisible contract that causes production incidents when violated.

suss infers it from the consumer's source code:
- Status branching: `if (result.status === 404)` → consumer expects status 404 as a case
- Field access: `result.body.name`, `result.body.email` → consumer depends on these fields existing
- Response conditions: `if (result.body.status === "deleted")` → consumer distinguishes a sub-case by testing a response field

## The comparison matrix

The checker's job is to compare these three contracts pairwise. Each comparison catches a different class of failure.

| Comparison | What it catches | Implemented |
|---|---|---|
| Provider inferred vs declared | Handler never produces declared status. Handler produces undeclared status. Body shape doesn't match schema. | Yes (`checkContractConsistency`) |
| Provider inferred vs consumer inferred (status) | Provider returns 404, consumer doesn't handle it. Consumer handles 410, provider never produces it. | Yes (`checkProviderCoverage`, `checkConsumerSatisfaction`) |
| Provider inferred vs consumer inferred (sub-cases) | Provider has two 200s (active vs deleted user), consumer has one 200 branch. | Yes (`checkProviderCoverage` sub-case analysis) |
| Provider inferred vs consumer inferred (body fields) | Consumer reads `body.email` but provider's 200 response doesn't include it. | Yes (`checkBodyCompatibility`) |
| Consumer inferred vs declared | Consumer reads `body.role` but the declared 200 schema doesn't include `role`. Consumer depends on an undeclared implementation detail. | Yes (`checkConsumerContract`) |
| Provider output ↔ consumer conditions (semantic bridging) | Provider's `user.deletedAt` transition produces body with `status: "deleted"`. Consumer tests `body.status === "deleted"`. These are the same behavioral case expressed in different domains. | Yes (`checkSemanticBridging`) |

## Analysis levels

The checks compose in layers, each building on the previous.

### Level 0: Status-code coverage (done)

Set comparison on status codes. Does the consumer handle every status the provider produces? Does the provider produce every status the consumer expects?

This catches the most common integration failures: a new error status that no consumer handles, or a consumer branch for a status the provider stopped returning.

### Level 1: Sub-case detection (done)

When a provider has multiple transitions for the same status code (e.g., two 200s gated by different conditions), check whether the consumer distinguishes between them. If the consumer has a single 200 branch with no sub-case conditions, emit a warning per conditional provider transition.

This catches the class of failure where "200 means success" is too coarse — the provider returns 200 in semantically different situations that the consumer collapses.

### Level 2: Field-presence comparison (done)

For each consumer transition with `expectedInput`, compare the set of fields the consumer reads against the provider's body shape for the matching status code. A missing field is a definite mismatch.

Consumer field tracking works by tracing property accesses on the response variable within each branch (e.g., `result.body.name`, `result.body.email`). These are collected into a `TypeShape` on `Transition.expectedInput` during extraction, flowing through `RawBranch` → `assembleSummary` → `Transition`.

### Level 3: Consumer vs declared contract (done)

Compare the consumer's `expectedInput` against the *declared* contract's body schema, not just the provider's actual output. If the consumer reads `body.role` but the declared 200 schema only has `{ id, name, email }`, the consumer depends on an undeclared field — an implementation detail that the provider can remove without violating its contract.

This is the "contract leakage" check: the consumer assumes more than the contract guarantees. Emits `consumerContractViolation` with `warning` severity — it's not a current bug, but a fragility.

### Level 4: Subject resolution through intermediates (done)

`resolveSubject` follows non-call initializers (`const data = result.body` → recurse on the property access, `const alias = user` → recurse on the identifier). Depth-bounded at 8 hops. This means consumer conditions that go through intermediate variables maintain their chain back to the response variable.

### Level 5: Semantic condition bridging (north star)

The core insight: provider conditions and consumer conditions are about the *same semantic concept* but expressed in different domains. The provider's condition `user.deletedAt` (a database field) and the consumer's condition `result.body.status === "deleted"` (a response field) are correlated — the provider *puts* the data there, the consumer *reads* it.

The bridge between them is the **provider's output shape per transition**:

1. Provider transition: when `user.deletedAt` is truthy, produce body `{ ...user, status: "deleted" }`
2. The body shape for that transition includes `status` with value `"deleted"` (a literal)
3. Consumer condition: `result.body.status === "deleted"` — a comparison predicate testing a derived subject (response → body → status) against literal `"deleted"`

The checker can ask: **does the provider transition's output body contain a field whose value matches the consumer transition's comparison predicate?**

If the provider's body has `{ status: { type: "literal", value: "deleted" } }` and the consumer tests `body.status === "deleted"`, that's a semantic match — the consumer is distinguishing *this specific provider sub-case*. If the consumer doesn't test for it, it's collapsing sub-cases. If the consumer tests for a value the provider never produces (e.g., `body.status === "suspended"` but no provider transition puts `"suspended"` in `status`), that's a dead branch.

This is the level at which suss catches the motivating example end-to-end:

> A user endpoint starts returning `200` with `status: "deleted"` for soft-deleted accounts. Three services downstream break because they assumed `200` meant "the user exists and is usable."

At Level 5, suss reports: "Provider transition `getUser:response:200:a1b2c3d` produces body with `status: "deleted"` when `user.deletedAt` is truthy. Consumer `loadUser` handles status 200 but does not test `body.status` — this sub-case flows through without distinction."

Level 5 is implemented (`checkSemanticBridging`) with the following known limitations, each documented as an aspiration test in `semantic-bridging.aspirations.test.ts`:

1. ~~**Literal-only discrimination.**~~ **RESOLVED.** Field-presence discrimination now detects when sibling transitions have structurally different bodies (e.g., one has `deletedAt`, the other doesn't) even without literal value differences. A consumer truthiness check on the distinguishing field suppresses the finding. Literal discrimination takes priority when both are available.

2. ~~**Negated comparisons.**~~ **RESOLVED.** `!== "active"` is now recognized as covering any sub-case whose value isn't `"active"` (e.g., `"deleted"`). Both `comparison(neq)` and `negation(comparison(eq))` are handled, with double-negation cancellation.

3. ~~**Hardcoded `"body"` property accessor.**~~ **RESOLVED.** The checker now recognizes `res.json()` as a body accessor: properties accessed on a `.json()` call result are treated as body-relative paths. Other body accessor patterns (custom deserializers, `.text()` + `JSON.parse`) would need to be added.

4. ~~**Provider body shapes must be structurally visible.**~~ **RECLASSIFIED.** The extractor's three-pass strategy already handles the common cases: named interfaces expand to records (not refs), and single-return local functions are inlined by `resolveCall`, preserving literal narrowness. Ref shapes only appear for multi-return functions, method calls, and cross-module functions with no visible body. These are genuinely Level 6 (local function inlining) territory.

5. ~~**`as const` dependency for narrow literals.**~~ **RECLASSIFIED.** The extractor's syntactic pass (Pass 1) DOES preserve literals without `as const` for direct object literals, variable bindings, and single-return local functions. The type-checker fallback (Pass 3) only overrides when the body goes through a code path the AST resolver can't trace — the same Level 6 gap as aspiration 4. Verified by extractor-level tests in `shapes.test.ts`.

6. ~~**Truthiness checks invisible.**~~ **RESOLVED.** `truthinessCheck` predicates on body fields are now extracted as consumer field tests. A truthiness check on a path matches any distinguishing literal at that path — the consumer IS making a distinction on that field. Remaining gap: complement reasoning (the negated/default case isn't automatically inferred as covering the opposite sub-case).

### Level 6: Local function inlining (independent)

When a provider condition is a call to a local helper — `if (!isActive(user))` where `isActive` is `(u) => !u.deletedAt && !u.suspendedAt` — the current extractor records the condition as an opaque `call` predicate. Inlining the helper body would produce two structured truthiness-check predicates instead.

Boundary: **can we statically resolve the function body to a single expression with no side effects?** If yes, inline. If no, stay opaque. This improves confidence scores and makes Levels 1-5 more effective, but is independent of them.

## How the IR supports comparison

**Transitions are atomic.** Each transition is `(conditions → output, effects)` with a stable `id`. Matching happens at the transition level.

**Predicates are structural, not textual.** A predicate is `{ subject, test }`, not a source string. Structured predicates can be compared across boundaries where the same concept appears in different forms.

**Subjects have identity.** `ValueRef` records where a value came from (parameter, dependency call, derived property access) as a traversable DAG. On the provider side, `user.deletedAt` resolves to `derived(dependency("db.findById"), propertyAccess("deletedAt"))`. On the consumer side, `result.body.status` resolves to `derived(derived(dependency("client.getUser"), propertyAccess("body")), propertyAccess("status"))`. Semantic bridging (Level 5) works by matching the provider's *output body field paths* against the consumer's *subject derivation chains*.

**`expectedInput` captures what the consumer reads.** Each client transition has an optional `expectedInput: TypeShape` representing the response body fields the consumer accesses within that branch. This is inferred from property access chains on the response variable — no annotation needed.

**Opaque predicates surface uncertainty explicitly.** When decomposition fails, the checker emits `lowConfidence` rather than a false negative.

**Gaps carry forward.** Provider gaps (declared-but-not-produced, produced-but-not-declared) flow through the checker as `providerContractViolation` findings.

## Output: findings

```typescript
interface Finding {
  kind:
    | "unhandledProviderCase"      // provider coverage, sub-case, or body mismatch
    | "deadConsumerBranch"         // consumer satisfaction
    | "providerContractViolation"  // contract consistency, provider side
    | "consumerContractViolation"  // contract consistency, consumer side
    | "lowConfidence";             // opaque predicates prevented a decision
  boundary: BoundaryBinding;
  provider: { summary: string; transitionId?: string; location: SourceLocation };
  consumer: { summary: string; transitionId?: string; location: SourceLocation };
  description: string;
  severity: "error" | "warning" | "info";
}
```

Findings are JSON-serializable. The CLI exits non-zero when any `error`-severity finding exists (tunable via `--fail-on`).

**Accepted findings.** When a finding is true but intentionally tolerated (e.g. "this consumer genuinely doesn't need to handle 500"), a `.sussignore.yml` file at the project root can `mark`, `downgrade`, or `hide` it. `mark` keeps the finding visible but excludes it from exit-code; `downgrade` drops severity one level; `hide` removes it entirely. See [`suppressions.md`](suppressions.md) for the full format. The `Finding.suppressed` field on output carries the rule's reason and effect so downstream tools can distinguish accepted-and-known from silently-ignored.

**Cross-source contract agreement.** When multiple providers describe the same boundary (an OpenAPI stub + a CloudFormation stub for the same endpoint, say), they each carry their own declared contract. `checkContractAgreement` (invoked automatically by `checkAll`) compares those contracts to each other and emits `contractDisagreement` findings when they don't match — "sources disagree on whether status 500 exists at `GET /pet/:id`," for example. This runs at the contract level only (`{statusCode, body}` tuples), independent of transitions, so 3+ sources produce one finding per non-unanimous status rather than an N-way pairwise explosion. Layer 1 (`checkContractConsistency`) still answers the orthogonal "is each provider consistent with its own contract?" question; Layer 2 adds cross-source agreement on top of that without replacing it. The `declaredContract.provenance` field ("derived" vs "independent") tells Layer 1 whether a provider's transitions and contract share a source — OpenAPI stubs are "derived" (self-comparison skipped); CFN stubs and extracted handlers with authored contracts are "independent."

**Confidence is informational, not prescriptive.** Each summary carries `ConfidenceInfo` (high / medium / low, plus source) reflecting how well the extractor decomposed the source — how many opaque predicates it fell back to, whether wrapper-expansion inferred the summary indirectly, etc. The checker does **not** downgrade severities based on it; the `lowConfidence` finding kind is the per-finding mechanism for "I couldn't decide." Summary-level confidence is a different axis (analysis quality on one side) and conflating it with finding certainty would hide both. The human `suss check` output appends `(confidence: medium|low)` after a provider or consumer side whose confidence is below `high`, so reviewers can weigh findings themselves; downstream tools (dashboards, docs generators) can read `summary.confidence` from the JSON output and apply their own policy if they want one.

## Scope

### In scope (OSS)

- The `suss check <provider.json> <consumer.json>` command — pairwise, local, stateless.
- Deterministic findings output (JSON or human-readable).
- All six analysis levels described above (Levels 0-2 are done; 3-6 are in progress).
- Library API so other tools can call the checker programmatically.

### Beyond pairwise

The checker compares two summaries at a time. Every analysis layer above that — aggregating summaries across a whole organization, tracking boundaries over commits, alerting on behavioral regressions, answering "which PRs break which consumers" — is a separate concern. Those layers consume `BehavioralSummary[]` and pairwise findings as their input.

The OSS scope stops at producing summaries and running local checks. It's designed so aggregation layers are straightforward to build on top (summaries are stable JSON, findings are structured), but this repository does not include them.
