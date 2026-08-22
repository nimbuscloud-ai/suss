# @suss/checker-intent

Pairs team-authored intent against derived code and reports where the
code fails to satisfy what the team declared.

## What this package is

This is the intent half of suss's checking, and it is deliberately
separate from `@suss/checker` (the behavioral peer checker). The inputs
differ: an `IntentSummary` (from `@suss/contract-intent`) on one side, a
`BehavioralSummary` on the other. So does the output. An `IntentFinding`
is one-sided coverage ("the team declared X; does the code do it?"),
rather than a symmetric provider↔consumer mismatch.

```ts
import { checkIntentAgreement } from "@suss/checker-intent";

const findings = checkIntentAgreement(intentSummaries, codeSummaries);
```

For each boundary intent, it pairs against the code summaries that share
the same boundary key, and emits:

- `unimplementedBoundary`: the intent declares a boundary no code produces.
- `uncoveredOutcome`: a declared outcome (response / return / throw) the code never produces.
- `outcomeShapeMismatch`: a matched outcome whose body shape disagrees with intent.
- `undeclaredOutcome`: code produces a REST status the intent doesn't declare (info; intent under-specifies).

v0 checks system intent (`kind: boundary`). PRD outcome intent
(`kind: prd`), which covers scenarios and links, is a separate pass.

## Where it fits in suss

This package depends on `@suss/intent-ir` (the intent shapes and
`IntentFinding`), `@suss/behavioral-ir` (the code summaries), and
`@suss/ir-core` for the shared comparison primitives (`boundaryKey`,
`bodyShapesMatch`) that it has to agree on with the behavioral checker.
It does **not** depend on
`@suss/checker`. The full design is in
[`design/proposals/intent-specs.md`](../../design/proposals/intent-specs.md).

## Coverage

![coverage](../../.github/badges/coverage-checker-intent.svg)

## License

Apache-2.0
