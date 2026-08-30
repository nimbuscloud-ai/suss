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
- `uncoveredOutcome`: a declared outcome (response / return / throw), or a declared effect, that the code never produces.
- `outcomeShapeMismatch`: a matched outcome whose body shape disagrees with intent.
- `undeclaredOutcome`: code produces a REST status, or reaches a boundary, that the intent doesn't declare (info; intent under-specifies).
- `unkeyableBoundary`: the intent's boundary has no key to pair on, so nothing was compared (warning).

v0 checks system intent (`kind: boundary`). PRD outcome intent
(`kind: prd`), which covers scenarios and links, is a separate pass.

## How a declared effect is compared

An outcome can declare the effects it has, in the verbs `suss ask` asks with: `does: writes` at a boundary. Both directions are checked.

For each declared effect, the pass collects what the matching code transitions reached, as `<verb> <boundary label>` pairs built from `relationsOf` and `displayLabel`, and reports `uncoveredOutcome` when the pair the intent stated is not among them. An outcome that declares an ending narrows to the transitions that end that way; an outcome that declares only effects is checked against every transition of the unit.

For the other direction, the pass collects every pair the unit's transitions reach and reports `undeclaredOutcome` for each one no outcome declares. An intent listing three writes on a unit doing four has one nobody wrote down. It is info rather than an error for the same reason an undeclared status is: an intent doc declares the floor rather than a closed list, so code beyond it usually means somebody has not written that part down yet.

Both sides read one spelling of a boundary, the protocol's own `displayLabel` in `@suss/ir-core`, which is the same string `suss ask` and the storage pass print. An access whose container the code cannot settle (a wrapper handed its table as an argument) spells a name with a hole in it and matches nothing here, because grounding that name is the storage pass's job and this pass loads no contracts.

## Which boundaries can be paired

`whatWouldKeyIt` says, per protocol, what an intent doc needs before it can be paired, and the message on an `unkeyableBoundary` finding and the reason `suss infer intent` reports for a boundary it skipped both come from it.

A store is the case worth knowing: it has no identity key at all, by design in `@suss/ir-core`, so a `kind: boundary` doc for one is authorable and always unkeyable. Naming the store as the target of an effect on the boundary that touches it is what pairs today.

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
