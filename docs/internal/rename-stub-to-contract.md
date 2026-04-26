# Rename: @suss/stub-* → @suss/contract-*

## Why

The current `@suss/stub-*` naming has drifted from what the packages
actually do. **Three artifact types matter; suss has names for two
and conflates them:**

| Layer | What it is | Authorship | Today in suss |
|---|---|---|---|
| **Stub** | Interface-level declaration of a boundary's shape, like a `.d.ts`. Small (~10 lines per boundary). | Hand-written | Doesn't exist. |
| **Derived contract** | Full BehavioralSummary parsed from a declarative source (OpenAPI, CFN, Storybook, Prisma schema). | Generated from spec | What `@suss/stub-*` packages produce. |
| **Inferred contract** | Full BehavioralSummary extracted from code. | Generated from source | What the adapter produces. |

What we currently call "stub" is the middle row — full contracts
derived from a spec source. That's not a stub in the test-double or
RPC-stub sense; it's a contract derivation. The misnomer also blocks
the namespace: we *want* a hand-authorable stub format eventually,
and "stub" has to mean something more specific to leave room.

## What changes

**Package renames** (5 published-shape packages today, +1 planned):

| Before | After |
|---|---|
| `@suss/stub-openapi` | `@suss/contract-openapi` |
| `@suss/stub-cloudformation` | `@suss/contract-cloudformation` |
| `@suss/stub-aws-apigateway` | `@suss/contract-aws-apigateway` |
| `@suss/stub-storybook` | `@suss/contract-storybook` |
| `@suss/stub-appsync` | `@suss/contract-appsync` |
| `@suss/stub-prisma` (planned, Phase 6) | `@suss/contract-prisma` |
| `@suss/stub-drizzle` (planned, Phase 6) | `@suss/contract-drizzle` |

**Directory renames**:
```
packages/stub/openapi/         → packages/contract/openapi/
packages/stub/cloudformation/  → packages/contract/cloudformation/
…etc
```

**CLI verb**:
```
suss stub --from openapi   →   suss contract --from openapi
```
(Or rename to a neutral verb like `suss read --from X` and let
"contract" be domain vocabulary. My read: `suss contract` is more
descriptive; `suss read` is neutral but also vague. Slight preference
for `suss contract`.)

**Doc rewrites**: ~10 doc pages reference "stub" — `behavioral-summary-format.md`,
`stubs.md`, `pipelines.md`, `cross-boundary-checking.md`,
`reference/cli.md`, `tutorial/get-started.md`, `guides/*`,
`internal/dogfooding.md`, plus the two design docs I just wrote
(`env-var-pairing.md`, `storage-pairing.md`).

**Code touchpoints**: every import of `@suss/stub-*`, every use of
`stub` as a CLI subcommand or in test fixtures.

## Cost

Rough count:
- 5 (soon 7) package directory renames
- ~50 import statement updates across the workspace
- ~10 doc files
- 1 CLI verb rename + tests for the new verb name
- `package.json` workspace entries
- `.changeset` entries / version bumps

Mechanical ~half-day. The risk is missing a stale reference; a
single grep at the end will catch it.

## Compatibility

- Internal: nothing released externally yet — no published npm
  versions to deprecate. This is the cheap window; renaming after
  publication means a deprecation cycle.
- External (CLI users): `suss stub --from X` becomes `suss contract
  --from X`. Could ship a deprecation alias for one minor version
  if we ever publish first.

## After the rename: what "stub" becomes

A future, separate work stream — NOT part of the rename PR:

A real stub format, hand-authorable, smaller than BehavioralSummary
by ~10×:

```yaml
# users-api.suss.stub.yaml
boundary:
  semantics: rest
  method: POST
  path: /users
inputs:
  body:
    email: string
    name: string
responses:
  201: { id: string, email: string }
  400: { error: string }
```

Use cases:
1. **Library author publishes API surface** — "consume my package's
   public boundary without re-extracting my source." Smaller and
   more durable than shipping the inferred contract.
2. **Manual override for too-dynamic code** — "the extractor can't
   figure this out; here's what it actually does."
3. **Service registry** — "here's the boundary my service offers,"
   no internal logic needed.

Implementation would be: a stub schema, a `stub-to-summary`
expander in the checker (or treat stubs as a first-class input
type), and a `suss publish my.stub.yaml` command. Probably the
right work after Phase 6 (storage) lands — by then we'll have
enough boundary kinds to pressure-test what a stub schema needs
to cover.

## Publishing the inferred contract — already works

While we're here, worth noting: `scripts/dogfood.mjs` already writes
`dist/suss-summaries.json` per `@suss/*` package. That IS the
inferred contract being published. Anyone consuming the package
gets the structured behavior alongside the code.

What's missing for users:
- A `suss publish` CLI wrapper (extracts + writes to dist + adds
  to `package.json#files`)
- A doc page on "Publishing your package's behavior contract"

Zero new code; just productizing what already runs in dogfood.
Could land alongside the rename or just after.

## Sequencing

Recommend:
1. **Rename PR.** Mechanical, single PR, no design changes.
2. **`suss publish` + publishing guide.** Productize the existing
   dogfood plumbing.
3. **Storage Phase 6.** Lands `@suss/contract-prisma`,
   `@suss/contract-drizzle` against the renamed namespace.
4. **(Future)** Stub schema + expander + `suss publish` for stubs.

## Status

Plan: drafted, awaiting review.
Work: not started.
Owner: TBD; ideally lands before Phase 6 to avoid double-rename of
new packages.
