# consumer/

These checks verify consumer behavior against what the provider produces and against the declared contract.

## Place in the pipeline

`checkAll()` runs two independent checks here:

1. **Satisfaction**: every status the consumer expects (from predicates like `if (res.status === 404)`) is one the provider can produce.
2. **Contract conformance**: every field the consumer expects matches the declared contract, not only the provider's actual behavior.

Both take paired (provider, consumer) summaries and emit findings when consumer branches are unreachable or read undeclared fields.

## Key files

- `consumerContract.ts:checkConsumerContract` compares what the consumer expects of the body against the declared contract. It skips pairs where the contract is null.
- `consumerSatisfaction.ts:checkConsumerSatisfaction` checks that the provider produces every status the consumer expects.

## Non-obvious things

- **Default branches absorb 2xx.** A consumer with an `isDefault` transition counts as covering all 2xx statuses, even ones it never tests explicitly. That keeps the checker from raising a false `deadConsumerBranch` finding on `if (res.status === 200) ... else { /* default handles 201, 204, etc. */ }`.
- **Status accessors are consumer-specific.** Some consumers use `.statusCode`, others use `.status`. Pairing reads `statusAccessorsFor(consumer)` from the declared contract metadata, and an equality check on one of those property names counts as a status guard.
- **Opaque status codes downgrade, don't error.** A consumer testing `res.status === someComputedValue` emits `lowConfidence` rather than `deadConsumerBranch`, because we can't prove the branch is unreachable.
- **`consumerContract` reads the consumer's own accessors.** It unwraps body fields with `bodyAccessorsFor(consumer)`, not with the provider's. The IR captures how the consumer reaches into the body, and that is the ground truth for what the consumer reads.

## Sibling modules

- `body/bodyCompatibility.ts` gives `consumerContract` the `providerCoversConsumerFields` call it uses to compare field sets.
- `coverage/responseMatch.ts` supplies status-code extraction and the `statusAccessorsFor` helper.
- `contract/declaredContract.ts` supplies the declared contract and the accessor metadata.
