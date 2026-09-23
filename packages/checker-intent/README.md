# @suss/checker-intent

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Pairs the intent a team wrote with the summaries derived from code, and
reports where the code does not do what the team declared.

## What this package is

This package does the intent half of suss's checking. It is kept
separate from `@suss/checker`, the behavioral peer checker, on purpose,
because the inputs differ. One side is an `IntentSummary` (from
`@suss/contract-intent`) and the other is a `BehavioralSummary`. The
output differs too. An `IntentFinding` is one-sided coverage: "the team
declared X; does the code do it?" A behavioral finding is a symmetric
provider↔consumer mismatch.

```ts
import { checkIntentAgreement } from "@suss/checker-intent";

const findings = checkIntentAgreement(intentSummaries, codeSummaries);
```

For each boundary intent, it pairs with the code summaries that share
the same boundary key, and emits:

- `unimplementedBoundary`: the intent declares a boundary no code produces.
- `uncoveredOutcome`: a declared outcome (response / return / throw), or a declared effect, that the code never produces.
- `outcomeShapeMismatch`: a matched outcome whose body shape disagrees with intent.
- `undeclaredOutcome`: code produces a REST status, or reaches a boundary, that the intent doesn't declare (info; intent under-specifies).
- `unkeyableBoundary`: the intent's boundary has no key to pair on, so nothing was compared (warning).
- `undescribedOutcome`: a declared outcome no PRD scenario links to (info).
- `renamedBoundary`: a declared store the unit never touches, paired with an undeclared store of the same system that the unit does touch, with the same verbs on the same outcomes.

v0 checks system intent (`kind: boundary`). PRD outcome intent
(`kind: prd`), which covers scenarios and links, is a separate pass.

## How a declared effect is compared

An outcome can declare its effects, written the same way `suss ask` asks about one:

```yaml
results:
  - writes: aws.dynamodb:Invoices
  - invokes: unit:lambda ArchiveWorker
```

The pass checks both directions, and both resolve the boundary with `namesBoundary` in `@suss/ir-core`. That is the same matcher `suss ask` uses for what somebody types. So `writes: Invoices` and `writes: aws.dynamodb:Invoices` both pick out the table, as the two spellings do at the command line, and this package has no second parser that could drift from that one.

For each declared effect, the pass walks what the matching code transitions reached. Each of those is a verb from `relationsOf` plus the binding it reached. When none of them matches the intent, the pass reports `uncoveredOutcome`. An outcome that declares an ending narrows to the transitions that end that way. An outcome that declares only effects is checked against every transition of the unit.

In the other direction, the pass walks every boundary the unit's transitions reach, and reports `undeclaredOutcome` for each one that no outcome declares. If an intent lists three writes on a unit that does four, one write was never written down. The finding is info, for the same reason an undeclared status is: an intent doc declares a minimum and is not a closed list, so code that goes beyond it usually means somebody has not documented that part yet.

When the code cannot settle an access's container, as with a wrapper that receives its table as an argument, the access's name has a hole in it and matches nothing here. Grounding that name is the storage pass's job, and this pass does not load contracts. An invoke that reads its callee out of an env var is in the same position. The code writes it as `unit:lambda {ARCHIVE_WORKER_FUNCTION}`, and resolving that chain is the unit-invocation pass's job. For the two to match, a document has to write the callee the same way the code does.

## How a declared condition is compared

When a `when` clause states which boundary the branch read, the pass compares that too. This is what makes `when` more than prose.

For each branch of the code, `boundaryGuardsOf` in `@suss/behavioral-ir` returns which boundary its guards depended on, and whether the guard passed because something was there. A declared outcome then narrows to the branches whose guards match every boundary clause the intent stated. `uncoveredOutcome` reports an outcome whose ending the code produces under a different condition. So an intent saying "404 when a read of `aws.dynamodb:Invoices` finds nothing" fails when the code's 404 depends on the row being present. When the unit has no effect against that boundary in any transition, the message points at the boundary as the cause instead.

The boundary resolves through `namesBoundary` again, and when the clause states `finds`, it has to agree. A clause about an input, and a clause left as a sentence, are treated as prose and not compared, because the summary has nothing that corresponds to those paths or words.

## When a store was renamed

When a store is renamed in code and the intent doc is not updated, one cause produces a pile of findings. The old name is declared and never touched, and the new one is touched and never declared. An `uncoveredOutcome` for the store that vanished and an `undeclaredOutcome` for the one that appeared fire for every verb and every outcome that used it. `renamedBoundary` folds all of those into one finding when the pairing is unambiguous. That requires four things: the two boundaries share a system prefix, their verbs match exactly, the new one satisfies every declared use the old one had, and each side has exactly one candidate on the other. The folded finding is still an error, like the findings it replaces. The document and the code still disagree, and folding is only a guess about the cause. It does not change whether the disagreement matters.

Pairing only considers reads and writes. A queue channel or a deployed unit is addressed by name, so a different callee produces its own uncoveredOutcome and undeclaredOutcome findings, and they are not folded.

## The coverage question, both ways

The three scenario kinds check whether a scenario points at an outcome that exists. `undescribedOutcome` checks the reverse: which declared behaviour has no written reason. A product reader asks that question, and the same two documents answer it.

The check stays quiet until at least one PRD is loaded, because before that every outcome would be reported. `suss infer prd` writes a scenario per outcome, so a fresh set of drafts starts with no such findings. They appear as the boundary documents gain outcomes that the PRDs do not cover.

## Which summaries count as the code

Two rules narrow the summaries an intent doc is compared against. Both keep suss from reporting a document for something the document was never meant to cover.

A consumer at the same key is a caller. A client calling `GET /users/{id}` shares the key with the route but provides nothing, so comparing outcomes against its returns would report every declared outcome as uncovered.

A summary produced from a manifest is a declaration. A CloudFormation queue resource declares that the channel exists and nothing more, so it has no transition that could satisfy an outcome. The handler in the same run is the code that satisfies it. So summaries with `confidence.source: "declared"` are left out. A boundary with nothing else behind it still reports `unimplementedBoundary`, which matches its state: declared and not written yet.

The handler behind a queue still needs the declaration for its identity. A SAM template decides which queue delivers to it, and its own summary has no channel. `withDeclaredDelivery` in `@suss/behavioral-ir` combines the two through the deployable unit they both record. Both this pass and `suss infer intent` call it before they index anything by boundary key. It fills in only what a summary left null, and only from a declaration, so a channel the code stated for itself stays as it is.

## Which boundaries can be paired

`whatWouldKeyIt` returns, for each protocol, what an intent doc needs before it can be paired. The message on an `unkeyableBoundary` finding comes from it, and so does the reason `suss infer intent` gives for a boundary it skipped.

A store is the case to know about. By design in `@suss/ir-core` it has no identity key at all, so you can write a `kind: boundary` doc for one, but it can never be paired. What pairs today is naming the store as the target of an effect on the boundary that touches it.

## Where it fits in suss

This package depends on `@suss/intent-ir` (the intent shapes and
`IntentFinding`), `@suss/behavioral-ir` (the code summaries), and
`@suss/ir-core` for the shared comparison primitives (`boundaryKey`,
`bodyShapesMatch`) that it has to agree on with the behavioral checker.
It does **not** depend on
`@suss/checker`. The full design is in
[`design/proposals/intent-specs.md`](../../design/proposals/intent-specs.md).

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-checker-intent.svg)

## License

Apache-2.0
