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
- `undescribedOutcome`: a declared outcome no PRD scenario links to (info).
- `renamedBoundary`: a declared store the unit never touches, paired with an undeclared store of the same system it touches with the same verbs on the same outcomes instead.

v0 checks system intent (`kind: boundary`). PRD outcome intent
(`kind: prd`), which covers scenarios and links, is a separate pass.

## How a declared effect is compared

An outcome can declare the effects it has, written the way `suss ask` asks about one:

```yaml
results:
  - writes: aws.dynamodb:Invoices
  - invokes: unit:lambda ArchiveWorker
```

Both directions are checked, and both resolve the boundary with `namesBoundary` in `@suss/ir-core`, the same matcher that settles what somebody types at `suss ask`. So `writes: Invoices` and `writes: aws.dynamodb:Invoices` both pick out the table, exactly as the two spellings do at the command line, and there is no second parser here to drift from that one.

For each declared effect, the pass walks what the matching code transitions reached, each a verb from `relationsOf` and the binding it reached, and reports `uncoveredOutcome` when nothing there matches what the intent said. An outcome that declares an ending narrows to the transitions that end that way; an outcome that declares only effects is checked against every transition of the unit.

For the other direction, the pass walks every boundary the unit's transitions reach and reports `undeclaredOutcome` for each one no outcome declares. An intent listing three writes on a unit doing four has one nobody wrote down. It is info rather than an error for the same reason an undeclared status is: an intent doc declares the floor rather than a closed list, so code beyond it usually means somebody has not written that part down yet.

An access whose container the code cannot settle (a wrapper handed its table as an argument) spells a name with a hole in it and matches nothing here, because grounding that name is the storage pass's job and this pass loads no contracts. An invoke that reads its callee out of an env var is in the same position: the code spells it `unit:lambda {ARCHIVE_WORKER_FUNCTION}`, collapsing that chain is the unit-invocation pass's job, and a document has to spell the callee the way the code does for the two to line up.

## How a declared condition is compared

A `when` clause that says which boundary the branch read is compared too, which is what makes `when` more than prose.

`boundaryGuardsOf` in `@suss/behavioral-ir` says, for each branch of the code, which boundary its guards turned on and whether the guard passed because something was there. A declared outcome then narrows to the branches whose guards match every boundary clause the intent stated, and `uncoveredOutcome` reports one that produces the ending on a different condition. So an intent saying "404 when a read of `aws.dynamodb:Invoices` finds nothing" fails when the code's 404 turns on the row being present. When the unit makes no effect against that boundary anywhere, in any transition, the message points at the boundary as the cause instead.

The boundary resolves through `namesBoundary` again, and `finds` has to agree when the clause states it. A clause about an input, and a clause left as a sentence, are prose to this pass and are not compared: the paths and the words have no counterpart in the summary to check against.

## When a store was renamed

A store that gets renamed in code without the intent doc catching up produces a pile of findings from one cause: the old name is declared and never touched, the new one is touched and never declared, and both an `uncoveredOutcome` (for the vanished store) and an `undeclaredOutcome` (for the one that appeared) fire for every verb and every outcome that used it. `renamedBoundary` folds all of those into one finding when the pairing is unambiguous: the two boundaries share a system prefix, their verbs match exactly, the new one satisfies every declared use the old one had, and each side has exactly one candidate on the other. It stays an error, same as the findings it replaces: the document and the code still disagree, and folding is a guess about the cause rather than a change in whether that disagreement matters.

Pairing only considers reads and writes. A queue channel or a deployed unit is addressed by name, so a different callee produces its own uncoveredOutcome and undeclaredOutcome findings without folding.

## The coverage question, both ways

The three scenario kinds ask whether a scenario points at an outcome that exists. `undescribedOutcome` asks it the other way: which declared behaviour has nobody written down a reason for. That is the question a product reader has, and the two artifacts to answer it from are the same two.

It stays quiet until at least one PRD is loaded, since before that the answer is every outcome. `suss infer prd` writes a scenario per outcome, so a fresh set of drafts starts with none of these and they appear as the boundary documents grow outcomes past what the PRDs cover.

## Which summaries count as the code

Two rules narrow the summaries an intent doc is compared against, and both are about not arguing with a document over something that was never its job.

A consumer at the same key is a caller. A client calling `GET /users/{id}` shares the key with the route and provides nothing, so comparing outcomes against its returns would report every declared outcome as uncovered.

A summary a manifest produced is a declaration. A CloudFormation queue resource says the channel exists and stops there, so it has no transition that could satisfy an outcome, and the code that does is the handler in the same run. Summaries with `confidence.source: "declared"` are left out for that reason. A boundary with nothing else behind it still reports `unimplementedBoundary`, which is the state it is in: declared and not written yet.

The handler behind a queue needs the declaration for its identity even so, because a SAM template decides which queue delivers to it and its own summary has no channel. `withDeclaredDelivery` in `@suss/behavioral-ir` puts the two together by the deployable unit they both give, and both this pass and `suss infer intent` call it before they index anything by boundary key. It fills in only what a summary left null, and only from a declaration, so a channel the code stated for itself stays as it is.

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
