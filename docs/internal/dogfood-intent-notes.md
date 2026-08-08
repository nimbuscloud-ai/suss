# Dogfooding the intent layer on suss's own surface

suss now checks its own public API against team-authored intent. Six
boundary intents under `intent/` describe the two checker packages'
exports. `npm run check:self` extracts those packages' export surfaces
and runs `suss check --dir … --intent intent/` against them. The run is
green. `checkAll` and `checkIntentAgreement` pair by
`fn:<package>::<exportPath>` and satisfy their declared return shapes,
three more keyable exports pass, and one intent that is deliberately
module-level comes back as `unkeyableBoundary` (the keying gap we
already know about, marked in `intent/self.sussignore.yml`).

This was the first sustained authoring pass over the intent layer. The
friction below is what we were after. Each entry is tagged `fix-now` (a
clear, bounded defect) or `needs-design` (we haven't settled what it
should look like).

## What shipped

- `intent/*.intent.yaml`: boundary intents for `@suss/checker` and
  `@suss/checker-intent` (checkAll, checkPair, dedupeFindings,
  checkIntentAgreement, applyIntentSuppressions), plus one internal
  helper (describeBinding) that exercises the unkeyable case.
- `intent/self.sussignore.yml`: marks the accepted keying gap.
- `scripts/checkSelf.mjs`: extraction driver + CLI check.
- `check:self` npm script (root → turbo → `@suss/cli`), a non-gating
  turbo task (`cache: false`, `dependsOn: ["build"]`).

## How to run

```
npm run check:self
```

It builds every package (turbo), extracts the two checker packages'
export surfaces to `.self-check/summaries/` (gitignored), and runs the
CLI check with `--fail-on none`. The part to read is the `Intent:`
section at the end.

## Friction

### 1. No CLI path to extract a package's export surface (`needs-design`)

`suss extract` requires `-f <framework>`. The `packageExports` discovery
variant that produces keyable `library` summaries isn't reachable from
the CLI, so `check:self` drives the adapter directly with a synthesized
`packageExports` pack. This duplicates what `scripts/dogfood.mjs` already
does, which makes it the second caller to hand-roll the same pack. If
extraction could produce an export surface itself (`suss extract
--package-exports <package.json>`, or a framework that reads
`package.json`), the intent workflow would run without any glue written
for the occasion. Until then, any team pointing intent at a library
boundary has to write the same driver.

### 2. `suss check --dir` can't point at a committed .sussignore (`resolved`)

`CheckDirOptions` has `sussignore` and `noSuppressions`, but
`runCheck`'s arg parser (packages/cli/src/run.ts) doesn't expose them.
suss only finds suppressions on its own in the summaries directory.
Because `check:self` generates that directory, the driver copies
`intent/self.sussignore.yml` into it as `.sussignore.yml`. The function
can already do this, so wiring `--sussignore` and `--no-suppressions`
onto the `check` command removes the copy step.

**Resolved.** `check` now parses `--sussignore <path>` and
`--no-suppressions`, and passes them to both the two-file and `--dir`
paths.

### 3. Intent body vocabulary can't describe function return shapes (`resolved`)

`BodyShapeSchema` (packages/intent-ir/src/schema.ts) is an object of
primitive-typed properties. The task asks for "declared outcomes = return
shapes," but:

- `checkAll` returns `{ findings: Finding[], pairs: […], unmatched: {…} }`.
  You can only express the three top-level keys, and their values have
  to be declared `unknown`, because the vocabulary has no arrays or
  nested records.
- `checkPair`, `dedupeFindings`, `applyIntentSuppressions` return a bare
  array (`Finding[]` / `IntentFinding[]`). You cannot express a
  top-level array at all, so these outcomes are declared body-less, and
  the intent claims only that a value is returned.

The top-level declaration still bites. If you drop or rename a declared
key, the code's return shape stops satisfying the intent and
`outcomeShapeMismatch` fires (verified against `checkAll` with a
fabricated property). If we extend the vocabulary to arrays, nested
objects, and named `TypeShape` references, intent about a function call
could describe the actual return value instead of stopping at the outer
keys.

**Resolved.** The authoring vocabulary is now recursive: `type: array`
(optional `items`) and `type: object` (nested `properties`) compose with
the primitives, and a top-level body can be a bare array or object shape.
The record shorthand (`properties:` with no `type:`) still loads. The
first run with the richer declarations caught an authoring error:
`checkAll`'s `unmatched` was declared an array but is an object of
`providers` / `consumers` arrays. Named `TypeShape` references remain
open.

### 4. A body-less return must be written `returns: {}`, not `returns:` (`resolved`)

Bare `returns:` parses as YAML null and fails Zod with
`expected object, received null` at `transitions.0.returns`. Nothing tells
the author that `{}` is the empty form we meant. Either accept null as an
empty returns outcome, or special-case the message ("write `returns: {}`
for a body-less return").

**Resolved.** The three outcome fields (`response`, `returns`, `throws`)
now coerce a null value to `{}`, so `returns:` and `returns: {}` mean the
same body-less outcome.

### 5. The proposal's worked examples don't match the shipped schema (`fix-now`)

`docs/internal/proposals/intent-layer-examples/fastify-users/users-lookup.system.yaml`
uses `output:` under each transition; the shipped schema uses `response:` /
`returns:` / `throws:`, so the file fails the "exactly one outcome" refine
and won't load. The sibling `user-profile-lookup.prd.yaml` uses `then:`
where the schema now expects `expect:` for the human outcome and `link:`
for the structured reference; it parses (unknown keys are stripped) but
silently drops the `then` text and mislabels the structured ref. A
first-time author copying either file hits a hard failure or a silent
semantic mismatch. Not fixed here, because the examples belong to the
intent-layer feature set. Flagged for that owner (see needs-alignment).

### 6. The export-surface self-check buries its signal (`needs-design`)

Extracting `@suss/checker` yields ~150 summaries: 26 keyed exports plus
~124 internal helpers the reachable-closure pass discovers (keyless,
recognition `reachable`). The check output lists every keyless helper
under "no boundary binding" before the `Intent:` section. Nothing is
dropped (that is the correct surfacing behavior), but it is hard to read
the export surface out of all that. This is the inspect and check
collapse UX already on the backlog, and the intent self-check is a
concrete reason to default the no-binding list to a collapsed count. The
driver filters no summaries to make this go away.

### 7. Module-level function-call boundaries can't be keyed (`needs-design`, accepted gap)

`describeBinding` is an internal `@suss/checker` helper, addressable only
by `module` + `exportName`. `boundaryKey` (packages/ir-core/src/boundaryKey.ts)
returns null without `package` + `exportPath`, so the intent is reported
as `unkeyableBoundary` (warning) and listed under `unchecked`. It is
marked in `intent/self.sussignore.yml` with the reason, rather than
worked around with a fabricated package export. Module-level keying (a
`fn:` key based on the file path, for functions inside one repo) would
let internal boundaries have checkable intent.

## Needs a human decision

- Friction 5 (stale worked examples) is a fix to the intent-layer feature's
  own artifacts. The feature owner decides whether to correct them in
  place and how the PRD's `then` / `expect` / `link` remap should read.
  It is recorded here rather than changed unilaterally.
