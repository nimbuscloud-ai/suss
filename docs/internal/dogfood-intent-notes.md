# Dogfooding the intent layer on suss's own surface

suss now checks its own public API against team-authored intent. Six
boundary intents under `intent/` describe the two checker packages'
exports; `npm run check:self` extracts those packages' export surfaces
and runs `suss check --dir … --intent intent/` against them. The run is
green: `checkAll` and `checkIntentAgreement` pair by
`fn:<package>::<exportPath>` and satisfy their declared return shapes,
three more keyable exports pass, and one deliberately module-level intent
surfaces as `unkeyableBoundary` (the named keying gap, marked in
`intent/self.sussignore.yml`).

This was the first sustained authoring pass over the intent layer. The
friction below is the payload; each entry is tagged `fix-now` (a clear,
bounded defect) or `needs-design` (the shape isn't settled).

## What shipped

- `intent/*.intent.yaml` — boundary intents for `@suss/checker` and
  `@suss/checker-intent` (checkAll, checkPair, dedupeFindings,
  checkIntentAgreement, applyIntentSuppressions), plus one internal
  helper (describeBinding) that exercises the unkeyable case.
- `intent/self.sussignore.yml` — marks the accepted keying gap.
- `scripts/checkSelf.mjs` — extraction driver + CLI check.
- `check:self` npm script (root → turbo → `@suss/cli`), a non-gating
  turbo task (`cache: false`, `dependsOn: ["build"]`).

## How to run

```
npm run check:self
```

Builds every package (turbo), extracts the two checker packages' export
surfaces to `.self-check/summaries/` (gitignored), and runs the CLI check
with `--fail-on none`. The signal is the `Intent:` section at the end.

## Friction

### 1. No CLI path to extract a package's export surface — `needs-design`

`suss extract` requires `-f <framework>`. The `packageExports` discovery
variant that produces keyable `library` summaries isn't reachable from
the CLI, so `check:self` drives the adapter directly with a synthesized
`packageExports` pack. This duplicates what `scripts/dogfood.mjs` already
does — the second consumer to hand-roll the same pack. A first-class
export-surface extraction (`suss extract --package-exports <package.json>`,
or a framework that reads `package.json`) would let the intent workflow
run without bespoke glue. Until then, any team pointing intent at a
library boundary has to write the same driver.

### 2. `suss check --dir` can't point at a committed .sussignore — `fix-now`

`CheckDirOptions` carries `sussignore` and `noSuppressions`, but
`runCheck`'s arg parser (packages/cli/src/run.ts) doesn't expose them.
Suppressions are only auto-discovered from the summaries directory.
Because `check:self` generates that directory, the driver copies
`intent/self.sussignore.yml` into it as `.sussignore.yml`. The capability
exists in the function; wiring `--sussignore` / `--no-suppressions` onto
the `check` command removes the copy step.

### 3. Intent body vocabulary can't describe function return shapes — `needs-design`

`BodyShapeSchema` (packages/intent-ir/src/schema.ts) is an object of
primitive-typed properties. The task asks for "declared outcomes = return
shapes," but:

- `checkAll` returns `{ findings: Finding[], pairs: […], unmatched: {…} }`.
  Only the three top-level keys are expressible; their values must be
  declared `unknown` because arrays and nested records aren't in the
  vocabulary.
- `checkPair`, `dedupeFindings`, `applyIntentSuppressions` return a bare
  array (`Finding[]` / `IntentFinding[]`). A top-level array isn't
  expressible at all, so these outcomes are declared body-less — the
  intent asserts only "a value is returned."

The top-level declaration still bites: dropping or renaming a declared
key makes the code's return shape stop satisfying the intent and fires
`outcomeShapeMismatch` (verified against `checkAll` with a fabricated
property). Extending the vocabulary to arrays, nested objects, and named
`TypeShape` references would let function-call intent describe real return
values instead of stopping at the outer keys.

### 4. A body-less return must be written `returns: {}`, not `returns:` — `fix-now`

Bare `returns:` parses as YAML null and fails Zod with
`expected object, received null` at `transitions.0.returns`. Nothing tells
the author that `{}` is the intended empty form. Either accept null as an
empty returns outcome, or special-case the message ("write `returns: {}`
for a body-less return").

### 5. The proposal's worked examples don't match the shipped schema — `fix-now`

`docs/internal/proposals/intent-layer-examples/fastify-users/users-lookup.system.yaml`
uses `output:` under each transition; the shipped schema uses `response:` /
`returns:` / `throws:`, so the file fails the "exactly one outcome" refine
and won't load. The sibling `user-profile-lookup.prd.yaml` uses `then:`
where the schema now expects `expect:` for the human outcome and `link:`
for the structured reference — it parses (unknown keys are stripped) but
silently drops the `then` text and mislabels the structured ref. A
first-time author copying either file hits a hard failure or a silent
semantic mismatch. Left unfixed here — the examples belong to the
intent-layer feature set; flagged for that owner (see needs-alignment).

### 6. The export-surface self-check buries its signal — `needs-design`

Extracting `@suss/checker` yields ~150 summaries: 26 keyed exports plus
~124 internal helpers the reachable-closure pass discovers (keyless,
recognition `reachable`). The check render lists every keyless helper
under "no boundary binding" before the `Intent:` section. Nothing is
dropped — that is the correct surfacing behavior — but the export-surface
signal is hard to read. This is the inspect/check-collapse UX already on
the backlog; the intent self-check is a concrete motivator for defaulting
the no-binding list to a collapsed count. No summaries were filtered in
the driver to make this go away.

### 7. Module-level function-call boundaries can't be keyed — `needs-design` (accepted gap)

`describeBinding` is an internal `@suss/checker` helper, addressable only
by `module` + `exportName`. `boundaryKey` (packages/ir-core/src/boundaryKey.ts)
returns null without `package` + `exportPath`, so the intent is reported
as `unkeyableBoundary` (warning) and listed under `unchecked`. It is
marked in `intent/self.sussignore.yml` with the reason, not hacked around
with a fabricated package export. Module-level keying (a file-path-based
`fn:` key for intra-repo functions) would let internal boundaries carry
checkable intent.

## Needs a human decision

- Friction 5 (stale worked examples) is a fix to the intent-layer feature's
  own artifacts. Whether to correct them in place, and how the PRD's
  `then` / `expect` / `link` remap should read, is the feature owner's
  call — recorded here rather than changed unilaterally.
