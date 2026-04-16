# Cross-Boundary Checking

Given behavioral summaries for two sides of a boundary — a provider (the handler producing a response) and a consumer (the call site reading it) — is their behavior compatible?

This document is the canonical reference for how suss behavioral analysis works: the conceptual model, the analysis levels, what the checker does today, and where it's heading. For the design of `BehavioralSummary` itself, see [`ir-reference.md`](ir-reference.md); for the extraction story, see [`architecture.md`](architecture.md).

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
| Consumer inferred vs declared | Consumer reads `body.role` but the declared 200 schema doesn't include `role`. Consumer depends on an undeclared implementation detail. | Not yet |
| Provider output ↔ consumer conditions (semantic bridging) | Provider's `user.deletedAt` transition produces body with `status: "deleted"`. Consumer tests `body.status === "deleted"`. These are the same behavioral case expressed in different domains. | Not yet — north star |

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

### Level 3: Consumer vs declared contract (not yet)

Compare the consumer's `expectedInput` against the *declared* contract's body schema, not just the provider's actual output. If the consumer reads `body.role` but the declared 200 schema only has `{ id, name, email }`, the consumer depends on an undeclared field — an implementation detail that the provider can remove without violating its contract.

This is the "contract leakage" check: the consumer assumes more than the contract guarantees.

### Level 4: Subject resolution improvement (not yet)

The current `resolveSubject` in the TypeScript adapter handles identifiers whose declaration initializer is a call expression (`const user = await db.findById(id)`) but falls through to `unresolved` when the initializer is a property access (`const data = result.body`) or another identifier (`const x = y`).

This means consumer conditions that go through intermediate variables — `const data = result.body; if (data.status === "deleted")` — lose their chain back to the response. Fixing this is a targeted change: when a variable's initializer is a property access or identifier, recurse into it.

This level unlocks Level 5.

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

1. **Literal-only discrimination.** Only `TypeShape.literal` values trigger bridging. When the provider distinguishes sub-cases by field presence (body has `deletedAt` vs doesn't) or by non-literal type differences, the check doesn't fire. Field-presence discrimination needs a separate structural-diff mode comparing key sets of sibling transition body shapes.

2. **Equality-only consumer matching.** The checker extracts consumer field tests from `comparison` predicates with `op: "eq"`. Negated comparisons (`!== "active"` as a proxy for `"deleted"`), truthiness checks (`if (data.deletedAt)`), range comparisons, and method-call predicates (`includes`, `startsWith`) are invisible. Truthiness checks are the most tractable next step — extend consumer field test extraction to recognize `truthinessCheck` predicates on body fields.

3. **Hardcoded `"body"` property accessor.** The checker looks for `"body"` in the consumer's property chain to compute the body-relative path. This works for ts-rest (`result.body.status`) but fails for fetch (where the consumer calls `result.json()` and accesses the returned object directly). Framework-aware body accessor configuration is needed.

4. **Provider body shapes must be structurally visible.** When the response body is constructed by a helper function (`buildResponse(user, "deleted")`), the shape extractor resolves it as a `ref` (opaque type name) rather than a record with literal fields. Improving this requires either local function inlining (Level 6) or ref resolution against structural type definitions.

5. **`as const` dependency for narrow literals.** Without `as const`, TypeScript's type checker widens string literals to `string`. The extractor's syntactic pass should preserve the literal from the AST node, but the type-checker fallback pass may override it. Investigation needed.

### Level 6: Local function inlining (independent)

When a provider condition is a call to a local helper — `if (!isActive(user))` where `isActive` is `(u) => !u.deletedAt && !u.suspendedAt` — the current extractor records the condition as an opaque `call` predicate. Inlining the helper body would produce two structured truthiness-check predicates instead.

Boundary: **can we statically resolve the function body to a single expression with no side effects?** If yes, inline. If no, stay opaque. This improves confidence scores and makes Levels 1-5 more effective, but is independent of them.

## How the IR supports comparison

**Transitions are atomic.** Each transition is `(conditions → output, effects)` with a stable `id`. Matching happens at the transition level.

**Predicates are structural, not textual.** A predicate is `{ subject, test }`, not a source string. Structured predicates can be compared across boundaries where the same concept appears in different forms.

**Subjects have identity.** `ValueRef` records where a value came from (parameter, dependency call, derived property access) as a traversable DAG. On the provider side, `user.deletedAt` resolves to `derived(dependency("db.findById"), propertyAccess("deletedAt"))`. On the consumer side, `result.body.status` resolves to `derived(derived(dependency("client.getUser"), propertyAccess("body")), propertyAccess("status"))`. Semantic bridging (Level 5) works by matching the provider's *output body field paths* against the consumer's *subject derivation chains*.

**`expectedInput` captures what the consumer reads.** Each client transition has an optional `expectedInput: TypeShape` representing the response body fields the consumer accesses within that branch. This is inferred from property access chains on the response variable — no annotation needed.

**Opaque predicates are honest.** When decomposition fails, the checker emits `lowConfidence` rather than a false negative.

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

Findings are JSON-serializable. The CLI exits non-zero when any `error`-severity finding exists.

## Scope

### In scope (OSS)

- The `suss check <provider.json> <consumer.json>` command — pairwise, local, stateless.
- Deterministic findings output (JSON or human-readable).
- All six analysis levels described above (Levels 0-2 are done; 3-6 are in progress).
- Library API so other tools can call the checker programmatically.

### Beyond pairwise

The checker compares two summaries at a time. Every analysis layer above that — aggregating summaries across a whole organization, tracking boundaries over commits, alerting on behavioral regressions, answering "which PRs break which consumers" — is a separate concern. Those layers consume `BehavioralSummary[]` and pairwise findings as their input.

The OSS scope stops at producing summaries and running local checks. It's designed so aggregation layers are straightforward to build on top (summaries are stable JSON, findings are structured), but this repository does not include them.
