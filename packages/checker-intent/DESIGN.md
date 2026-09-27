# How intent findings are graded

The reference for `@suss/checker-intent`: which severity each finding kind gets, and where the PRD pass stops. The [README](./README.md) says what the package is for.

## Severity

Each finding kind has a fixed severity.

An error means the code does not do something the team wrote down: `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch`, `renamedBoundary` and `pathWithoutEffect`. Somebody wrote the intent doc on purpose, so code that does not satisfy it is a bug.

A warning means the intent could not be checked, or a document points at something that is not there: `unkeyableBoundary`, `danglingScenarioLink` and `ambiguousScenarioLink`. A dangling or ambiguous link is a planning gap the author has to fix. `unreadInputField` is a warning when the author marked the field as required, and info when they did not.

Info means the code goes further than the document, or the document is not finished yet: `undeclaredOutcome`, `undeclaredInputRead`, `unlinkedScenario` and `undescribedOutcome`. An intent doc states a minimum, so these are expected while the documents catch up with the code.

## Effects on every path

A `results` line on an outcome passes when some transition producing that outcome has the effect. An `always` line passes only when every transition producing a declared outcome has it, so the check walks the unit's transitions one at a time and reports `pathWithoutEffect` for each one that lacks the effect.

A transition produces an outcome when it ends the way the outcome says and its branch turns on every boundary the outcome's `when` clauses mention, the same test the outcome check uses. An outcome that states only its effects has no ending to narrow by, so every transition produces it. The schema refuses an `except` entry for one of those, since exempting it would exempt the whole unit.

A transition can match two outcomes at once. A throw with a type the summary does not know matches both a declared `ForbiddenError` throw and a declared throw with no type. When either outcome is listed under `except`, the transition is exempt. The checker cannot tell which of the two the code meant, and a finding would be a guess.

The check reads the transitions and effects the outcome check has already computed, so it adds one pass over them per `always` line.

## Inferred intent

A finding against intent whose `source` is `"inferred"` drops one level, from error to warning and from warning to info. `suss infer intent` wrote that intent from what the code did at the time, so a difference most likely means the code changed since. Once someone curates the draft and marks it `"inferred, curated"`, its findings go back to full severity.

## Where the PRD pass stops

A PRD scenario has `when` and `expect` in plain language, and an optional `link`: a list of `<intent-name>.<outcome-id>` references into the loaded boundary intents. The PRD pass resolves each reference against those intents and goes no further.

Whether the code implements a linked outcome is a question for the boundary pass, which reports it as `uncoveredOutcome` or `unimplementedBoundary`. Keeping the two apart means a PRD can be checked before any code exists.
