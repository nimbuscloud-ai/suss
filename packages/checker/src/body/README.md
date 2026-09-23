# body/

The body checks compare request and response body shapes between providers and consumers, and against declared contracts.

## Place in the pipeline

The `coverage/`, `contract/`, and `consumer/` checkers call these checks once they have grouped summaries into pairs by status code. The body checks flag fields the consumer depends on that the provider declares optional, and report where a comparison could not be finished. When a consumer reads a field that a body provably lacks, `checkResponseMisread` in `coverage/` reports it. That check works out for itself which responses a consumer path runs on.

## Key files

- `bodyCompatibility.ts:checkBodyCompatibility` is the main cross-boundary check. It walks (provider, consumer, status) tuples and, for each one, checks whether the provider covers the set of fields the consumer accesses.
- `bodyCompatibility.ts:providerCoversConsumerFields` compares field presence and returns one of three states: `match` / `nomatch` / `unknown`.
- `bodyCompatibility.ts:findOptionalAccesses` flags fields the consumer reads that the provider declares optional, so the consumer should null-guard them.
- `bodyMatch.ts:bodyShapesMatch` checks whether one body type can be assigned to another. `contract/` uses it to match a declared body against the actual one.

## Gotchas

- **Consumer leaves are usually `unknown`.** The IR records which fields the consumer read, but not their declared types. To compare against the provider's body, the code unwraps `expectedInput` through the consumer's body accessors (`bodyAccessorsFor`) to get the body shape. Most leaves end up as `{ type: "unknown" }`, because the consumer never declared what it expected.
- **Spreads short-circuit to `unknown`.** A provider record with unresolved spreads (`{ ...user, ...partial }`) can't guarantee a closed key set. The match result becomes `unknown` so that the check does not report a false negative.
- **Optional fields produce info-level findings.** When a consumer reads `user.email` and the provider declares `email?: string`, the finding suggests a null guard. The field is still present, so the field-presence match succeeds and nothing is reported as a contract violation.
- **Status-code filtering happens upstream.** `coverage/responseMatch.ts` produces the (provider, consumer, status) tuples, and the body checks work on tuples that are already filtered. The body code never extracts the status again.
- **Null bodies are skipped without a finding.** A provider transition with `output.body === null` (no body extracted) never enters the comparison. The checker treats it as having no body to compare against, and does not report a mismatch.

## Sibling modules

- `coverage/responseMatch.ts` produces the (provider, consumer, status) tuples the body checks consume.
- `contract/contractConsistency.ts` uses `bodyShapesMatch` to compare a provider's actual body against its declared contract.
- `consumer/consumerContract.ts` uses `providerCoversConsumerFields` to check which of the declared schema fields the consumer depends on.
