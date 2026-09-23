# Dogfooding the intent layer on suss's own surface

suss now checks its own public API against intent the team wrote. Six
boundary intents under `intent/` describe the exports of the two
checker packages. `npm run check:self` extracts the export surfaces of
those packages and runs `suss check --dir … --intent intent/` against
them, and the run passes. `checkAll` and `checkIntentAgreement` pair by
`fn:<package>::<exportPath>` and satisfy their declared return shapes.
Three more exports with keys pass. One intent is deliberately about a
module-level function, and it comes back as `unkeyableBoundary`. That
is the keying gap we already know about, and it is marked in
`intent/self.sussignore.yml`.

This was the first long stretch of writing intent by hand, and finding
the friction below was the reason for doing it. Each entry is tagged
`fix-now` (a clear, bounded bug) or `needs-design` (we haven't settled
what it should look like).

## What shipped

- `intent/*.intent.yaml`: boundary intents for `@suss/checker` and
  `@suss/checker-intent` (checkAll, checkPair, dedupeFindings,
  checkIntentAgreement, applyIntentSuppressions), plus one internal
  helper (describeBinding) that exercises the unkeyable case.
- `intent/self.sussignore.yml` marks the accepted keying gap.
- `scripts/checkSelf.mjs` drives extraction and then runs the CLI check.
- The `check:self` npm script (root → turbo → `@suss/cli`) is a turbo
  task that does not gate the build (`cache: false`,
  `dependsOn: ["build"]`).

## How to run

```
npm run check:self
```

It builds every package through turbo, extracts the export surfaces of
the two checker packages to `.self-check/summaries/` (gitignored), and
runs the CLI check with `--fail-on none`. Read the `Intent:` section at
the end of the output.

## Friction

### 1. No CLI path to extract a package's export surface (`needs-design`)

`suss extract` requires `-f <framework>`. The CLI has no way to reach
the `packageExports` discovery variant, which is what produces
`library` summaries with keys. So `check:self` drives the adapter
directly with a `packageExports` pack it builds itself.
`scripts/dogfood.mjs` already does the same thing, so this is the
second caller to build that pack by hand. If extraction could produce
an export surface directly (`suss extract --package-exports
<package.json>`, or a framework that reads `package.json`), the intent
workflow would run without any one-off glue code. Until then, every
team that points intent at a library boundary has to write the same
driver.

### 2. `suss check --dir` can't point at a committed .sussignore (`resolved`)

`CheckDirOptions` has `sussignore` and `noSuppressions`, but the
argument parser in `runCheck` (packages/cli/src/run.ts) doesn't expose
them. suss only finds suppressions by itself in the summaries
directory. `check:self` generates that directory, so the driver copies
`intent/self.sussignore.yml` into it as `.sussignore.yml`. The function
already supports the options, so adding `--sussignore` and
`--no-suppressions` to the `check` command removes the copy step.

**Resolved.** `check` now parses `--sussignore <path>` and
`--no-suppressions`, and passes them to both the two-file path and the
`--dir` path.

### 3. Intent body vocabulary can't describe function return shapes (`resolved`)

`BodyShapeSchema` (packages/intent-ir/src/schema.ts) is an object whose
properties have primitive types. The task asks for "declared outcomes =
return shapes," but:

- `checkAll` returns `{ findings: Finding[], pairs: […], unmatched: {…} }`.
  You can only express the three top-level keys, and their values have
  to be declared `unknown`, because the vocabulary has no arrays or
  nested records.
- `checkPair`, `dedupeFindings` and `applyIntentSuppressions` return a
  bare array (`Finding[]` or `IntentFinding[]`). There is no way to
  express a top-level array, so these outcomes are declared without a
  body, and the intent only claims that a value is returned.

The top-level declaration still catches something. If you drop or
rename a declared key, the code's return shape no longer satisfies the
intent and `outcomeShapeMismatch` fires. We verified this against
`checkAll` with a made-up property. If we extended the vocabulary to
arrays, nested objects and named `TypeShape` references, intent about a
function call could describe the actual return value and not only its
outer keys.

**Resolved.** The authoring vocabulary is now recursive. `type: array`
(with optional `items`) and `type: object` (with nested `properties`)
combine with the primitives, and a top-level body can be a bare array
or object shape. The record shorthand (`properties:` with no `type:`)
still loads. The first run with the richer declarations caught a
mistake in the intent itself: `checkAll`'s `unmatched` was declared as
an array, but it is an object of `providers` and `consumers` arrays.
Named `TypeShape` references are still open.

### 4. A body-less return must be written `returns: {}`, not `returns:` (`resolved`)

A bare `returns:` parses as YAML null and fails Zod with
`expected object, received null` at `transitions.0.returns`. Nothing
tells the author that `{}` is the empty form we meant. The fix is to
accept null as an empty returns outcome, or to special-case the message
("write `returns: {}` for a body-less return").

**Resolved.** The three outcome fields (`response`, `returns`, `throws`)
now turn a null value into `{}`, so `returns:` and `returns: {}` mean
the same outcome with no body.

### 5. The proposal's worked examples don't match the shipped schema (`fix-now`)

`design/proposals/intent-layer-examples/fastify-users/users-lookup.system.yaml`
uses `output:` under each transition. The shipped schema uses
`response:`, `returns:` or `throws:`, so the file fails the "exactly one
outcome" refinement and won't load. The file next to it,
`user-profile-lookup.prd.yaml`, uses `then:` where the schema now
expects `expect:` for the outcome a person reads and `link:` for the
structured reference. It parses, because unknown keys are stripped, but
it drops the `then` text without a warning and labels the structured
ref wrongly. An author copying either file for the first time gets a
hard failure or a meaning that silently changed. We did not fix it
here, because the examples belong to the intent layer feature. It is
flagged for that feature's owner (see the last section).

### 6. The export-surface self-check buries its signal (`needs-design`)

Extracting `@suss/checker` produces about 150 summaries. 26 are exports
with keys, and about 124 are internal helpers that the reachable-closure
pass finds (they have no key, and their recognition is `reachable`).
The check output lists every helper without a key under "no boundary
binding", before the `Intent:` section. Nothing is dropped, and listing
them is the correct behavior, but it makes the export surface hard to
pick out. The backlog already has an item for collapsing this output in
inspect and check, and the intent self-check is a concrete reason to
show the no-binding list as a collapsed count by default. The driver
does not filter out any summaries to hide the problem.

### 7. Module-level function-call boundaries can't be keyed (`needs-design`, accepted gap)

`describeBinding` is an internal `@suss/checker` helper that can only
be addressed by `module` + `exportName`.
`boundaryKey` (packages/ir-core/src/boundaryKey.ts) returns null without
`package` + `exportPath`, so the intent is reported as
`unkeyableBoundary` (a warning) and listed under `unchecked`. We marked
it in `intent/self.sussignore.yml` with the reason, and did not work
around it with a made-up package export. Keying at the module level (a
`fn:` key built from the file path, for functions inside one repo)
would let internal boundaries have intent that can be checked.

## Needs a human decision

- Friction 5 (the stale worked examples) is a fix to the intent layer
  feature's own files. The feature owner decides whether to correct
  them in place, and how the PRD's `then` should map onto `expect` and
  `link`. It is written down here instead of being changed without
  them.
