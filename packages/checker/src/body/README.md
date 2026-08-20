# body/

The body checks compare request and response body shapes between providers and consumers, and against declared contracts.

## Place in the pipeline

The `coverage/`, `contract/`, and `consumer/` checkers call these checks after they have grouped summaries into pairs by status code. The checks flag fields the consumer depends on that the provider declares optional, and report where a comparison could not be finished. A read of a field a body provably lacks is `checkResponseMisread`'s finding, over in `coverage/`, which decides on its own which responses a consumer path runs on.

## Key files

- `bodyCompatibility.ts:checkBodyCompatibility` is the main cross-boundary check. It walks (provider, consumer, status) tuples and, for each one, asks whether the provider covers the set of fields the consumer accesses.
- `bodyCompatibility.ts:providerCoversConsumerFields` compares field presence in three states: `match` / `nomatch` / `unknown`.
- `bodyCompatibility.ts:findOptionalAccesses` flags fields the consumer reads that the provider declares optional (the consumer should null-guard them).
- `bodyMatch.ts:bodyShapesMatch` checks whether one body type can be assigned to another. `contract/` uses it to match a declared body against the actual one.

## Non-obvious things

- **Consumer leaves are usually `unknown`.** The IR captured which fields the consumer read, not their declared types. To compare against the provider's body, the code unwraps `expectedInput` through the consumer's body accessors (`bodyAccessorsFor`) to get the body shape. Most leaves end up as `{ type: "unknown" }`, because the consumer never told us what it expected.
- **Spreads short-circuit to `unknown`.** A provider record with unresolved spreads (`{ ...user, ...partial }`) can't guarantee a closed key set. The match result becomes `unknown` to avoid false negatives.
- **Optional fields produce info-level findings.** When a consumer reads `user.email` and the provider declares `email?: string`, that is a "you might want to null-guard this" signal rather than a contract violation. The field is still present, so the field-presence match succeeds.
- **Status-code filtering happens upstream.** `coverage/responseMatch.ts` produces the (provider, consumer, status) tuples, and the body checks work on tuples that have already been filtered. The body code never pulls the status out again.
- **Null bodies skip silently.** A provider transition with `output.body === null` (no body extracted) never enters the comparison. The checker treats it as "no body to compare against" rather than as a mismatch.

## Sibling modules

- `coverage/responseMatch.ts` produces the (provider, consumer, status) tuples the body checks consume.
- `contract/contractConsistency.ts` uses `bodyShapesMatch` to compare a provider's actual body against its declared contract.
- `consumer/consumerContract.ts` uses `providerCoversConsumerFields` to check what the consumer depends on among the declared schema fields.
