# coverage/

Verifies that consumer branches handle every status the provider can produce, including sub-cases where the provider distinguishes outcomes within the same status code.

## Place in the pipeline

Runs in `checkAll()` after pairing. Walks paired (provider, consumer) summaries, groups provider transitions by status code, and asks: does the consumer have a branch for each status, and (when the provider has multiple branches per status) does the consumer distinguish them by matching predicates?

Emits `unhandledProviderCase` and `lowConfidence` findings.

## Key files

- `providerCoverage.ts:checkProviderCoverage` — main entry. Sub-case analysis runs when multiple provider branches share a status code.
- `responseMatch.ts:extractResponseStatus` — pulls a literal status code from a transition's response output.
- `responseMatch.ts:consumerExpectedStatuses` — collects literal status numbers from consumer predicates.
- `responseMatch.ts:refLooksLikeStatus` — heuristic for whether a ValueRef names something that resembles a status property.

## Non-obvious things

- **Literals only.** Status comparisons run on literal numeric values. Variables, function calls, and expressions emit `lowConfidence` instead of error — we can't prove unreachability without knowing the runtime value.
- **Sub-case discrimination is one-sided.** Provider conditions describe server-side state; consumer conditions describe response fields. The two aren't compared for equivalence — it's the body checker's job to flag content mismatches. Sub-case findings fire when the provider has multiple branches for one status and the consumer has a single catch-all for that status (consumer ignored the distinction).
- **Default branches absorb 2xx silently.** A consumer with an `isDefault` transition is treated as covering all 2xx statuses. Even unusual cases (provider returns 207 Multi-Status) get covered if the default exists.
- **Predicate matching is three-state.** `predicatesMatch` returns `match` / `nomatch` / `unknown`. `unknown` (opaque or unresolved predicates) flows to `lowConfidence` rather than committing in either direction.

## Sibling modules

- `contract/declaredContract.ts` — supplies the status-accessor names used to read consumer predicates.
- `pairing/pairing.ts` — supplies the SummaryPair tuples coverage runs against.
- `body/bodyCompatibility.ts` — runs after coverage on the same status-grouped tuples.
