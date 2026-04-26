# consumer/

Verifies consumer behavior against what the provider produces and against the declared contract.

## Place in the pipeline

Runs as two independent checks in `checkAll()`:

1. **Satisfaction** — every consumer-expected status (from predicates like `if (res.status === 404)`) is one the provider can produce.
2. **Contract conformance** — every consumer field expectation matches the declared contract (not just the provider's actual behavior).

Both consume paired (provider, consumer) summaries and emit findings when consumer branches are unreachable or read undeclared fields.

## Key files

- `consumerContract.ts:checkConsumerContract` — compares consumer field expectations against the declared contract. Skips pairs where the contract is null.
- `consumerSatisfaction.ts:checkConsumerSatisfaction` — checks that consumer-expected statuses are produced by the provider.

## Non-obvious things

- **Default branches absorb 2xx.** A consumer with an `isDefault` transition implicitly covers all 2xx statuses, even ones not explicitly tested. This avoids false `deadConsumerBranch` findings on `if (res.status === 200) ... else { /* default handles 201, 204, etc. */ }`.
- **Status accessors are consumer-specific.** Some consumers use `.statusCode`, others use `.status`. Pairing reads `statusAccessorsFor(consumer)` from declared contract metadata; equality checks on those property names count as status guards.
- **Opaque status codes downgrade, don't error.** A consumer testing `res.status === someComputedValue` emits `lowConfidence`, not `deadConsumerBranch` — we can't prove the branch is unreachable.
- **`consumerContract` reads the consumer's own accessors.** Body field unwrapping uses `bodyAccessorsFor(consumer)`, not the provider's. The IR captures the consumer's access pattern; that's the ground truth for what the consumer reads.

## Sibling modules

- `body/bodyCompatibility.ts` — `consumerContract` calls `providerCoversConsumerFields` to compare field sets.
- `coverage/responseMatch.ts` — supplies status-code extraction and the `statusAccessorsFor` helper.
- `contract/declaredContract.ts` — supplies the declared contract and accessor metadata.
