# Cross-Boundary Checking

Given behavioral summaries for two sides of a boundary — a provider (the handler producing a response) and a consumer (the call site reading it) — is their behavior compatible?

This document specifies the *pairwise* check: one provider summary, one consumer summary, a list of findings. It describes the algorithm `suss check` uses, the kinds of mismatches it surfaces, and how the IR supports cross-boundary reasoning. For the design of `BehavioralSummary` itself, see [`ir-reference.md`](ir-reference.md); for the extraction story, see [`architecture.md`](architecture.md).

> **Status:** consumer-side discovery has landed. Both sides of a boundary can now be extracted from real code: providers via handler registration (ts-rest, Express, React Router) and consumers via client call sites (ts-rest `initClient`, `fetch`). `suss check` compares provider and consumer summaries for status-code coverage, dead branches, and contract consistency (including body shapes). Pairwise body comparison across provider/consumer summaries is still TODO. See [`status.md`](status.md). Broader analysis layers (cross-service graphs, historical tracking, continuous checking) are deliberately **out of scope** for this repository; see [§ Beyond pairwise](#beyond-pairwise).

## What the check answers

Given two summaries that share a boundary, the checker answers three questions:

1. **Does the consumer handle every case the provider can produce?** (*provider coverage*)
2. **Does the provider actually produce every case the consumer expects?** (*consumer satisfaction*)
3. **If a declared contract exists, does each side agree with it?** (*contract consistency*)

Each failed question becomes a **finding** — a structured record naming the mismatched transitions, source locations on both sides, and a human-readable description.

## The three checks

### 1. Provider coverage

For every transition the provider produces, the consumer must handle it.

```
for each providerTransition in provider.transitions:
  if no consumerTransition matches providerTransition:
    emit finding { kind: "unhandledProviderCase", providerTransition, ... }
```

"Matches" is not output-equality — it's *the consumer reads this response and does something with it*. In practice, matching a provider's `response { status: 404 }` means finding a consumer transition whose conditions include something like "status equals 404" applied to this call site's result.

**Example finding.** Provider returns `200` with `body: { ...user, status: "deleted" }` when `user.deletedAt` is truthy. Consumer only handles the shape `{ id, email, ... }` — never tests `body.status`. Uncovered case: the soft-delete response flows through as if the user were active.

### 2. Consumer satisfaction

For every case the consumer handles, the provider must be able to produce it. Branches the consumer reserves for responses that never arrive are dead code — or, worse, stale assumptions about what the provider used to do.

```
for each consumerTransition in consumer.transitions:
  if consumerTransition reads a provider response that no provider transition produces:
    emit finding { kind: "deadConsumerBranch", consumerTransition, ... }
```

**Example finding.** Consumer has a branch that fires on `status === 410`. Provider's summary contains no `410` response. Either the provider used to return 410 and the consumer hasn't been updated, or the consumer was written speculatively.

### 3. Contract consistency

If a declared contract exists at the boundary (ts-rest `responses`, an OpenAPI spec, a GraphQL schema), each side is checked independently:

- **Provider vs contract** — does the provider produce every response the contract declares? Does it produce any response the contract doesn't declare? These are the same gap categories that `@suss/extractor`'s `detectGaps` already emits; the checker reformats each entry in `provider.gaps` into a `providerContractViolation` finding (severity `error`). The gap data stays on the summary so other consumers still see it. When the contract declares a body shape for a status code, each matching provider transition's body is compared to the declared shape via `bodyShapesMatch` — incompatible shapes raise `providerContractViolation` (severity `error`); indeterminate comparisons (record spreads, unresolved refs) surface as `lowConfidence` (severity `info`) instead of false positives.
- **Consumer vs contract** — does the consumer handle every declared response? Branches for undeclared responses are a contract violation in the consumer (severity `error`); unhandled declared responses are uncovered risk (severity `warning`). A consumer default branch implicitly covers declared 2xx statuses, mirroring the provider-coverage rule.

Contract consistency can catch mismatches that `1`/`2` miss. If both provider and consumer have drifted away from the contract in the same direction, they'll agree with each other but disagree with the declared truth.

## How summaries support comparison

The checker does the same work at a boundary that a human would — but it can only do so because the IR was designed to make comparison tractable.

**Transitions are atomic.** Each transition is `(conditions → output, effects)` with a stable `id`. Matching provider outputs to consumer expectations happens at the transition level, not by diffing free-form code.

**Predicates are structural, not textual.** A predicate is `{ subject, test }`, not a source string. The provider's `user.deletedAt` (a `truthinessCheck` on a `derived` subject whose origin is `db.findById`) and the consumer's `user.status === "deleted"` (a `comparison` on the same shape) can be compared as structured objects. Two predicates on different sides of a boundary that test the same thing should be recognizable as such.

**Subjects have identity.** `ValueRef` records where a value came from (parameter, dependency call, derived property access) as a traversable DAG. A response body field on the provider side and the same field read on the consumer side share a subject path — the checker walks both to decide whether they refer to the same value.

**Opaque predicates are honest.** When decomposition failed on either side, the checker can't assert compatibility. It emits a `lowConfidence` finding rather than a false negative. Matching against opaque predicates is treated as *unknown*, not *compatible*.

**Gaps carry forward.** `BehavioralSummary.gaps` (populated by `detectGaps`) is already structured — gaps detected during extraction flow through the checker unchanged, with the boundary adding the context that makes them actionable.

## Output: findings

A finding is the checker's unit of output, analogous to a compiler diagnostic. The planned shape:

```typescript
interface Finding {
  kind:
    | "unhandledProviderCase"      // provider coverage
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

Findings are JSON-serializable and render to human-readable text via `suss inspect`-style formatting. The CLI exits non-zero when any `error`-severity findings exist, so the check composes into CI as a standard check step.

## Scope

### In scope (OSS)

- The `suss check <provider.json> <consumer.json>` command — pairwise, local, stateless.
- Deterministic findings output (JSON or human-readable).
- Subject/predicate/transition matching as described above.
- Integration of `detectGaps`-style contract checks into the pairwise finding stream.
- Library API so other tools can call the checker programmatically.

### Beyond pairwise

The checker compares two summaries at a time. Every analysis layer above that — aggregating summaries across a whole organization, tracking boundaries over commits, alerting on behavioral regressions, answering "which PRs break which consumers" — is a separate concern. Those layers consume `BehavioralSummary[]` and pairwise findings as their input.

The OSS scope stops at producing summaries and running local checks. It's designed so aggregation layers are straightforward to build on top (summaries are stable JSON, findings are structured), but this repository does not include them.
