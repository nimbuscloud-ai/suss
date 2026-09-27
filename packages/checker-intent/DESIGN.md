# How intent findings are graded

The reference for `@suss/checker-intent`: which severity each finding kind gets, and where the PRD pass stops. The [README](./README.md) says what the package is for.

## Severity

Each finding kind has a fixed severity.

An error means the code does not do something the team wrote down: `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch`, `renamedBoundary`, `pathWithoutEffect` and `valueFromElsewhere`. Somebody wrote the intent doc on purpose, so code that does not satisfy it is a bug.

A warning means the intent could not be checked, or a document points at something that is not there: `unkeyableBoundary`, `danglingScenarioLink`, `ambiguousScenarioLink`, `unlinkedScenario`, `missingCoveringTest`, `testMissesSubject` and `coveringTestSkipped`. A dangling or ambiguous link is a planning gap the author has to fix, and so is a scenario that neither a link nor a running test backs. `unreadInputField` is a warning when the author marked the field as required, and info when they did not.

Info means the code goes further than the document: `undeclaredOutcome`, `undeclaredInputRead` and `undescribedOutcome`. An intent doc states a minimum, so these are expected while the documents catch up with the code.

`unlinkedScenario` was info while a link was the only way to back a scenario, since a promise about which values come back had no way to be linked. A scenario can list its covering test now, so one with neither is the same kind of gap as a link to nothing. A scenario still being written is recorded with a `.sussignore` rule that gives its title under `scenario`, so the gap is on record and a scenario added to the same PRD later is still reported.

## Effects on every path

A `results` line on an outcome passes when some transition producing that outcome has the effect. An `always` line passes only when every transition producing a declared outcome has it, so the check walks the unit's transitions one at a time and reports `pathWithoutEffect` for each one that lacks the effect.

A transition produces an outcome when it ends the way the outcome says and its branch turns on every boundary the outcome's `when` clauses mention, the same test the outcome check uses. An outcome that states only its effects has no ending to narrow by, so every transition produces it. The schema refuses an `except` entry for one of those, since exempting it would exempt the whole unit.

A transition can match two outcomes at once. A throw with a type the summary does not know matches both a declared `ForbiddenError` throw and a declared throw with no type. When either outcome is listed under `except`, the transition is exempt. The checker cannot tell which of the two the code meant, and a finding would be a guess.

The check reads the transitions and effects the outcome check has already computed, so it adds one pass over them per `always` line.

## Where a value came from

A `results` line with `from` says where the value of a column under `fields` or `by` comes from. The summary records, for each slot of each access, where the walk from the value ended, as value references. The check reads the slots of the effects the line already matched, so it costs nothing on a line without `from`.

An `input` reference is spelled the way a `from` source is, through `boundarySourcePathOf`, which spells a guard's read the same way the `receives` check does, and a path off the request outside its four parts as the path off the request. The line passes when one matched effect takes the column from the given source, since a `results` line is satisfied by one transition. A header name compares without its case, as it does in the `receives` check.

When no matched effect takes the column from the given source, the check needs something it can name before it says so. An input path or a literal is a `valueFromElsewhere` finding. A walk that stopped at a call it cannot follow could still have started at the source the document gives, so the claim goes under `unchecked` as `unreadValue`, with the source text the walk stopped at. The same happens when the summary doesn't record a source for the column.

## Inferred intent

A finding against intent whose `source` is `"inferred"` drops one level, from error to warning and from warning to info. `suss infer intent` wrote that intent from what the code did at the time, so a difference most likely means the code changed since. Once someone curates the draft and marks it `"inferred, curated"`, its findings go back to full severity.

## Where the PRD pass stops

A PRD scenario has `when` and `expect` in plain language, and an optional `link`: a list of `<intent-name>.<outcome-id>` references into the loaded boundary intents. The PRD pass resolves each reference against those intents and goes no further.

Whether the code implements a linked outcome is a question for the boundary pass, which reports it as `uncoveredOutcome` or `unimplementedBoundary`. Keeping the two apart means a PRD can be checked before any code exists.

## Covering tests

A scenario can list tests under `coveredBy` instead of, or beside, a link. The check asks three things of each: that a test unit with that file and title path is in the summaries, that it is not marked skip or todo, and that its calls reach the scenario's subject. The subject is `about` when the scenario gives it, and otherwise any boundary the PRD's links resolve to, so a test that reaches one of them covers every scenario in the PRD that leaves `about` out. The schema requires `about` in a PRD with no link at all.

Reach is the forward question over `@suss/checker`'s call facts, asked for every test in one fixpoint. The facts include the mocks a test pack recorded on each test, and the rule refuses a hop into a module or member the test mocks. A test that misses its subject is asked again without that refusal, which tells a test that never reaches its subject from one that reaches it only through a mock, and the message says which. When the test's own body makes a call with the subject's name that suss could not follow, the message says that too, since it is the likeliest reason.

Spelling a test or a subject is resolved by the caller, through a `CoveringTestLookup`, because the resolver for a spelled file or unit lives with the commands. The check does not read assertions and runs nothing, so a failing test that calls its subject counts as covering it; the runner's own exit code already fails the build.
