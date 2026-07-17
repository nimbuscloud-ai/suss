# @suss/checker-intent

Pair team-authored intent against derived code and report where the code
fails to satisfy what the team declared.

## What this package is

The intent half of suss's checking, separate from `@suss/checker` (the
behavioural peer checker) by design. The inputs differ — `IntentSummary`
(from `@suss/contract-intent`) on one side, `BehavioralSummary` on the
other — and so does the output: an `IntentFinding` is one-sided coverage
("the team declared X; does the code do it?"), not a symmetric
provider↔consumer mismatch.

```ts
import { checkIntentAgreement } from "@suss/checker-intent";

const findings = checkIntentAgreement(intentSummaries, codeSummaries);
```

For each boundary intent, it pairs against the code summaries sharing the
same boundary key and emits:

- `unimplementedBoundary` — the intent declares a boundary no code produces.
- `uncoveredOutcome` — a declared outcome (response / return / throw) the code never produces.
- `outcomeShapeMismatch` — a matched outcome whose body shape disagrees with intent.
- `undeclaredOutcome` — code produces a REST status the intent doesn't declare (info; intent under-specifies).

v0 checks system intent (`kind: boundary`). PRD outcome intent
(`kind: prd`) — scenario / link coverage — is a separate pass.

## Where it sits in suss

Depends on `@suss/intent-ir` (intent shapes + `IntentFinding`),
`@suss/behavioral-ir` (code summaries), and `@suss/ir-core` for the
shared comparison primitives (`boundaryKey`, `bodyShapesMatch`) it must
agree on with the behavioural checker. It does **not** depend on
`@suss/checker`. The full design is in
[`docs/internal/proposals/intent-specs.md`](../../docs/internal/proposals/intent-specs.md).

## Coverage

![coverage](../../.github/badges/coverage-checker-intent.svg)

## License

Apache-2.0
