# How intent findings are graded

The reference for `@suss/checker-intent`: which severity each finding kind gets, and where the PRD pass stops. The [README](./README.md) says what the package is for.

## Severity

Each finding kind has a fixed severity.

An error means the code does not do something the team wrote down: `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch` and `renamedBoundary`. Somebody wrote the intent doc on purpose, so code that does not satisfy it is a bug.

A warning means the intent could not be checked, or a document points at something that is not there: `unkeyableBoundary`, `danglingScenarioLink` and `ambiguousScenarioLink`. A dangling or ambiguous link is a planning gap the author has to fix. `unreadInputField` is a warning when the author marked the field as required, and info when they did not.

Info means the code goes further than the document, or the document is not finished yet: `undeclaredOutcome`, `undeclaredInputRead`, `unlinkedScenario` and `undescribedOutcome`. An intent doc states a minimum, so these are expected while the documents catch up with the code.

## Inferred intent

A finding against intent whose `source` is `"inferred"` drops one level, from error to warning and from warning to info. `suss infer intent` wrote that intent from what the code did at the time, so a difference most likely means the code changed since. Once someone curates the draft and marks it `"inferred, curated"`, its findings go back to full severity.

## Where the PRD pass stops

A PRD scenario has `when` and `expect` in plain language, and an optional `link`: a list of `<intent-name>.<outcome-id>` references into the loaded boundary intents. The PRD pass resolves each reference against those intents and goes no further.

Whether the code implements a linked outcome is a question for the boundary pass, which reports it as `uncoveredOutcome` or `unimplementedBoundary`. Keeping the two apart means a PRD can be checked before any code exists.
