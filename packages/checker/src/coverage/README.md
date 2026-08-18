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
- `statusRanges.ts:consumerHandlesStatus` says whether any consumer branch handles one status, by the number or by a range.

## Ranges, and why they are read apart from numbers

`if (!res.ok) { toast.error(...); return }` handles every non-2xx status. The extractor records `res.ok` as `status >= 200 && status <= 299`, so a check that reads only `status === N` sees a consumer that handles nothing, and reports every status the provider can send. That one shape produced 23 of the 68 error-severity `unhandledProviderCase` findings measured over the public corpora, all of them false.

`statusRanges.ts` describes a branch as a set of status codes and combines predicates as sets: `and` intersects, `or` unions, a negation complements. Complementing needs both ends of the space, so the set is bounded at 100 and 599.

Two rules keep this from covering more than it should:

- **A predicate that says nothing about the status gives null**, and stays out of the intersection rather than counting as "any status". Without that, a consumer with no status check at all (`.then((r) => r.json())`, then a branch on a body field) would admit every status and no finding could ever fire.
- **An `or` with any null operand is null as a whole.** That operand can be true for any status, so the union cannot be trusted.

Comparisons against a single number stay with `consumerExpectedStatuses` and are read polarity-insensitively, the way they always were. Feeding them through the range algebra would make `if (res.status === 200)` with no else cover 404 through the complement, which is a fall-through the consumer does nothing with.

`consumerExpectedStatuses` also settles a second, different question: which statuses does the consumer *name*. `deadConsumerBranch` and the contract check's "consumer expects a status the contract does not declare" both ask it. A range must not feed those, because `if (res.ok)` does not mean the consumer expects 203.

## Non-obvious things

- **Literal values only.** Status comparisons run on literal numeric values. Variables, function calls, and expressions emit `lowConfidence` instead of an error, because we can't prove a branch is unreachable without knowing the runtime value.
- **Sub-case discrimination is one-sided.** Provider conditions describe server-side state, and consumer conditions describe response fields. The check does not compare the two for equivalence, since flagging content mismatches is the body checker's job. A sub-case finding fires when the provider has several branches for one status and the consumer has a single catch-all for that status, meaning the consumer ignored the distinction.
- **Default branches absorb 2xx silently.** The check treats a consumer with an `isDefault` transition as covering all 2xx statuses. Even unusual cases (the provider returns 207 Multi-Status) come out covered when the default is there.
- **Predicate matching is three-state.** `predicatesMatch` returns `match` / `nomatch` / `unknown`. An `unknown` result (an opaque or unresolved predicate) turns into `lowConfidence` rather than committing in either direction.

## Sibling modules

- `contract/declaredContract.ts` supplies the status-accessor and success-accessor names used to read consumer predicates.
- `pairing/pairing.ts` supplies the SummaryPair tuples coverage runs against.
- `body/bodyCompatibility.ts` runs after coverage on the same status-grouped tuples.
