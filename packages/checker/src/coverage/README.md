# coverage/

This check verifies that consumer branches handle every status the provider can produce, including sub-cases where the provider distinguishes outcomes within the same status code.

## Place in the pipeline

`checkAll()` runs it after pairing. It walks paired (provider, consumer) summaries, groups provider transitions by status code, and asks: does the consumer have a branch for each status, and (when the provider has several branches for one status) does the consumer tell them apart with matching predicates?

It emits `unhandledProviderCase` and `lowConfidence` findings.

## Key files

- `providerCoverage.ts:checkProviderCoverage` is the main entry point. It analyzes sub-cases when several provider branches share a status code.
- `responseMatch.ts:extractResponseStatus` pulls a literal status code out of a transition's response output.
- `responseMatch.ts:consumerExpectedStatuses` collects literal status numbers from consumer predicates.
- `responseMatch.ts:refLooksLikeStatus` is the heuristic for whether a ValueRef points at something that looks like a status property.

## Non-obvious things

- **Literals only.** Status comparisons run on literal numeric values. Variables, function calls, and expressions emit `lowConfidence` instead of an error, because we can't prove a branch is unreachable without knowing the runtime value.
- **Sub-case discrimination is one-sided.** Provider conditions describe server-side state, and consumer conditions describe response fields. The check does not compare the two for equivalence, since flagging content mismatches is the body checker's job. A sub-case finding fires when the provider has several branches for one status and the consumer has a single catch-all for that status, meaning the consumer ignored the distinction.
- **Default branches absorb 2xx silently.** The check treats a consumer with an `isDefault` transition as covering all 2xx statuses. Even unusual cases (the provider returns 207 Multi-Status) come out covered when the default is there.
- **Predicate matching is three-state.** `predicatesMatch` returns `match` / `nomatch` / `unknown`. An `unknown` result (an opaque or unresolved predicate) turns into `lowConfidence` rather than committing in either direction.

## Sibling modules

- `contract/declaredContract.ts` supplies the status-accessor names used to read consumer predicates.
- `pairing/pairing.ts` supplies the SummaryPair tuples coverage runs against.
- `body/bodyCompatibility.ts` runs after coverage on the same status-grouped tuples.
