# body/

Compares request and response body shapes between providers and consumers, and against declared contracts.

## Place in the pipeline

Called by `coverage/`, `contract/`, and `consumer/` checkers after they've grouped summaries into pairs by status code. Verifies the provider sends every field the consumer reads, and flags optional-field dependencies the consumer hasn't accounted for.

## Key files

- `bodyCompatibility.ts:checkBodyCompatibility` — main cross-boundary check. Walks (provider, consumer, status) tuples; for each, asks whether the provider covers the consumer's accessed field set.
- `bodyCompatibility.ts:providerCoversConsumerFields` — three-state field-presence comparison: `match` / `nomatch` / `unknown`.
- `bodyCompatibility.ts:findOptionalAccesses` — flags fields the consumer reads that the provider declares optional (consumer should null-guard).
- `bodyMatch.ts:bodyShapesMatch` — structural type assignability check. Used by `contract/` for declared-vs-actual matching.

## Non-obvious things

- **Consumer leaves are usually `unknown`.** The IR captured which fields the consumer read, not their declared types. To compare against the provider's body, unwrap `expectedInput` through the consumer's body accessors (`bodyAccessorsFor`) to get the body shape — most leaves end up as `{ type: "unknown" }` because the consumer never told us what it expected.
- **Spreads short-circuit to `unknown`.** A provider record with unresolved spreads (`{ ...user, ...partial }`) can't guarantee a closed key set. The match result becomes `unknown` to avoid false negatives.
- **Optional fields produce info-level findings.** A consumer reading `user.email` where the provider declares `email?: string` is a "you might want to null-guard this" signal, not a contract violation. Match on field presence still succeeds.
- **Status-code filtering happens upstream.** `coverage/responseMatch.ts` produces (provider, consumer, status) tuples; body checks operate on already-filtered tuples. Body code never re-extracts status.
- **Null bodies skip silently.** A provider transition with `output.body === null` (no body extracted) doesn't enter the comparison. Treated as "no shape to compare," not as a mismatch.

## Sibling modules

- `coverage/responseMatch.ts` — produces the (provider, consumer, status) tuples body checks consume.
- `contract/contractConsistency.ts` — uses `bodyShapesMatch` to compare a provider's actual body against its declared contract.
- `consumer/consumerContract.ts` — uses `providerCoversConsumerFields` to check consumer dependence on declared schema fields.
