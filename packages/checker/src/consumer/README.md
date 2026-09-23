# consumer/

These checks compare what a consumer does with what the provider produces and with the declared contract.

## Place in the pipeline

`checkAll()` runs two independent checks here:

1. **Satisfaction**: every status the consumer expects (from predicates like `if (res.status === 404)`) is one the provider can produce.
2. **Contract conformance**: every field the consumer expects matches the declared contract as well as the provider's actual behavior.

Both take paired (provider, consumer) summaries. They emit findings when a consumer branch is unreachable or when the consumer reads a field the contract does not declare.

## Key files

- `consumerContract.ts:checkConsumerContract` compares what the consumer expects of the body with the declared contract. It skips pairs where the contract is null.
- `consumerSatisfaction.ts:checkConsumerSatisfaction` checks that the provider produces every status the consumer expects.

## Gotchas

- **Default branches absorb 2xx.** A consumer with an `isDefault` transition counts as covering all 2xx statuses, including ones it never tests explicitly. Without this the checker would raise a false `deadConsumerBranch` finding on `if (res.status === 200) ... else { /* default handles 201, 204, etc. */ }`.
- **Status accessors depend on the consumer.** Some consumers use `.statusCode`, others use `.status`. Pairing reads `statusAccessorsFor(consumer)` from the declared contract metadata, and an equality check on one of those property names counts as a status guard.
- **An opaque status code lowers confidence and does not raise an error.** A consumer testing `res.status === someComputedValue` gets `lowConfidence` in place of `deadConsumerBranch`, because the checker can't prove the branch is unreachable.
- **`consumerContract` reads the consumer's own accessors.** It unwraps body fields with `bodyAccessorsFor(consumer)` and ignores the provider's accessors. The IR records how the consumer reaches into the body, and that record is the ground truth for what the consumer reads.

## Sibling modules

- `body/bodyCompatibility.ts` provides `providerCoversConsumerFields`, which `consumerContract` calls to compare field sets.
- `coverage/responseMatch.ts` supplies status-code extraction and the `statusAccessorsFor` helper.
- `contract/declaredContract.ts` supplies the declared contract and the accessor metadata.
