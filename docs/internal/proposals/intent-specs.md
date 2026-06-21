# Intent specifications as a comparable artifact — design proposal

A plan for making intent specs (PRDs, product descriptions, engineering
intent docs) into a structured artifact the same checker compares
against derived summaries. The framing already exists in
[concept-design](../concept-design.md#prds-and-intent-specifications)
and as a [backlog item](../backlog.md#intent-specs); this proposal
turns it into a sequenced delivery plan with a demo scenario, schema,
and integration path.

## Why this exists

Suss derives behavioural summaries from code. The summary answers
"what does the code do?" — but only one half of the loop. The other
half is "what was the code supposed to do?" Until that intent is in a
structured shape the checker can read, suss can pair providers with
consumers and consumers with each other, but it can't tell you the
deeper drift: the code agrees with itself and disagrees with what you
meant.

Today the only intent artifacts suss reads are *third-party* specs
(OpenAPI, CloudFormation, GraphQL SDL) — schemas that happen to
declare structural truth about an API. They were never written as
intent. The team's own intent — what the PR was supposed to ship,
what the PM meant by "deleted users 404," what the engineering doc
said about the failure mode — lives in Notion and markdown and
nobody's loop closes back on it.

Charity Majors and the operability lineage argue that the future of
software comprehension is closing the intent → outcome loop with
production observation. Suss is positioned for the *static* half of
that loop: a structured intent spec compared against the derived
summary tells you, at PR-author time, whether the code shipped what
the team declared. The dynamic half (observation) can land later in
the same shape — see [observation adapters](../backlog.md#observation-adapters).

Two costs of staying where we are:

1. Every project ships derived summaries that have no top-down ground
   truth to anchor them. Drift detection across implementations is
   strong; drift between *intent and implementation* is invisible.
2. Outside review of the project named this as the single sharpest
   unrealized idea — the PRD-as-typed-concept framing is novel and
   immediately useful even before the tool catches up to it.

## Scope — v0

A minimum shipped surface that closes the forward loop (intent →
implementation) for HTTP boundaries. Lateral and backward comparison
follow once the v0 schema is in production use.

### 1. Intent spec format

A YAML / JSON document the team commits alongside the code. One spec
per declared boundary, parallel in shape to a `BehavioralSummary` so
the checker can pair them directly:

```yaml
# intent/users-get.intent.yaml
boundary:
  transport: http
  semantics: rest
  method: GET
  path: /users/:id
purpose: "Look up a single user by id."
audience: web-client
transitions:
  - when: "user exists"
    output:
      status: 200
      body:
        properties:
          id: { type: string }
          fullName: { type: string }
  - when: "user not found"
    output:
      status: 404
      body:
        properties:
          error: { type: string }
  - when: "user is soft-deleted"
    output:
      status: 410
      body:
        properties:
          error: { type: string }
```

Fields parallel the IR: `boundary` → `BoundaryBinding`, `transitions`
→ summary transitions, `body.properties` → `TypeShape`. The natural-
language `when` field is captured as an opaque predicate (the same
shape as derived opaque predicates) and pairs by terminal kind +
status code, not by predicate equality.

`purpose` and `audience` come from the
[concept-design](../concept-design.md#prds-and-intent-specifications)
framing — they're how the checker validates spec well-formedness
(missing purpose / missing audience → spec is malformed, flag
separately from comparison findings).

### 2. Contract reader

`@suss/contract-intent` reads `*.intent.yaml` (or `.json`) and
produces `BehavioralSummary[]` with `confidence: { source: "specification", level: "high" }`.

CLI: `suss contract --from intent path/to/intents/` — accepts a
single file, a directory, or (per the URL support from #48) a hosted
URL.

### 3. Forward comparison

A new checker, `checkIntentAgreement`, pairs intent summaries with
derived summaries on `(method, normalizedPath)` (same pairing key as
the existing OpenAPI / handler agreement) and reports:

- `intentUnimplemented` — intent declares a transition the
  derivation doesn't produce. Status the spec promised but the
  handler never emits.
- `intentExceeded` — derivation produces a transition the intent
  doesn't declare. Status the handler emits that the spec doesn't
  mention. (Distinct from `providerContractViolation`: the contract
  is intent, not OpenAPI.)
- `intentFieldMismatch` — body shape declared by intent disagrees
  with body shape produced by code. Reuses the existing field-level
  comparison the OpenAPI checker uses.

### 4. The demo

**Setting**: a small team adds a "soft-delete users" feature to a
TypeScript backend.

**Beneficiary**: the PM (writes intent), the implementing engineer
(reads findings), the reviewer (sees what changed at intent vs code
levels).

**Walkthrough**:

1. PM writes `intent/users-get.intent.yaml` declaring three
   transitions — 200, 404, and (new) 410 for soft-deleted users.
2. Engineer implements the soft-delete path; suss extracts the
   handler and runs `suss check --dir intents/ summaries/`.
3. If the engineer forgot the 410 branch:
   `[ERROR] intentUnimplemented — intent declares 410 for soft-deleted users; no handler transition produces it.`
4. If the engineer returns `{ id, name }` instead of `{ id, fullName }`:
   `[ERROR] intentFieldMismatch — intent body declares { id, fullName }; handler returns { id, name }.`
5. CI gate fails on the missing case until intent and code agree.

This is the same shape as the existing pair-frontend-backend
tutorial, but with the spec authored by the team rather than supplied
by a third party. The checker mechanics and the finding catalog are
unchanged; only the source of ground truth changes.

## Out of scope, deferred

- **Backward comparison (concept-shape audit).** "Is there a coherent
  concept here, or did we ship fused / smeared / phantom code?" Needs
  the [failure-mode detection](../backlog.md#failure-modes) work
  shipped first. The opportunity is concrete but it builds on the
  forward comparison being trusted.
- **Lateral comparison (spec vs spec).** Two intent specs from
  different audiences disagree. Requires the audience-tagging work
  ([backlog](../backlog.md#audience-annotation)) before the
  disagreement has a structured form to surface in.
- **Quality specifications (latency, error budget, observability
  obligations).** Per [quality.md](../quality.md), full intent
  carries quality alongside capability. Defer until capability-only
  intent is in production use — quality spec needs its own taxonomy.
- **Arazzo workflows as multi-step intent.** An
  [Arazzo workflow](../backlog.md#arazzo-workflows) is a multi-
  endpoint intent. The single-boundary intent shape ships first; the
  multi-step shape lands once sync-chain pairing exists.
- **Generated intent stubs from existing code.** Reverse mode — emit
  a starter intent spec from a derived summary so teams can adopt
  intent specs on an existing codebase. Mechanically follows from v0
  shipping the same shape in both directions, but it's not the demo.
- **Production-observation half of the loop.** Charity's framing
  closes the loop with runtime observation. Static intent vs derived
  summary is the half suss owns; observation adapters
  ([backlog](../backlog.md#observation-adapters)) are the bridge.

## Mechanics

### Schema

The intent-spec shape is a structural subset of `BehavioralSummary`
plus a small set of intent-only fields (`purpose`, `audience`,
`when`). Defined in `@suss/contract-intent/src/schema.ts` as a Zod
schema, parallel to the OpenAPI schema. Validation errors surface as
load-time errors, not as comparison findings — a malformed intent
spec doesn't pair with anything.

### Reader

`@suss/contract-intent` exports:

- `intentSpecToSummaries(spec, options)` — pure parse + transform.
- `intentSpecFileToSummaries(path, options)` — convenience wrapper.
- `intentSpecDirectoryToSummaries(dir, options)` — walks `*.intent.yaml`
  / `*.intent.json` under `dir`, returns flattened summaries.

CLI integration: `suss contract --from intent` plugs into the
existing `CONTRACT_LOADERS` registry. URL support is automatic via
the resolver shipped in #48.

### Comparison

`checkIntentAgreement` lives next to the existing
`checkContractAgreement` (OpenAPI) and `checkGraphqlContractAgreement`
(GraphQL) checkers. Same pairing mechanism, same finding-emission
machinery. The finding kinds (`intentUnimplemented`,
`intentExceeded`, `intentFieldMismatch`) are new entries in
`@suss/findings`.

### Well-formedness checks

Independent of pairing, the checker validates that each loaded intent
spec has:

- A `purpose` (non-empty).
- An `audience` (must match one of the declared audience names — to
  be defined; v0 accepts any non-empty string and warns when an
  unknown audience appears).
- At least one transition.

Malformed intent specs surface `intentMalformed` findings before
pairing runs.

## Confidence

Intent summaries carry `confidence: { source: "specification", level: "high" }`
— the same shape as OpenAPI-derived summaries. The opaque predicates
on intent transitions (the natural-language `when` field) match
opaque-confidence treatment derived predicates already have; the
checker pairs by terminal shape, not by predicate equivalence.

Comparison findings inherit confidence from the *derived* side: a
high-confidence handler that disagrees with intent produces a
high-confidence finding; a low-confidence handler produces a
warning-not-error finding (same pattern as `lowConfidence` today).

## Interactions with other packs and checkers

- **OpenAPI**: an intent spec and an OpenAPI spec for the same
  boundary are both ground-truth declarations. Today they'd both run
  through `checkContractAgreement` against the handler and could
  disagree with each other. v0 doesn't introduce intent-vs-OpenAPI
  comparison; that's lateral and follows once the intent shape is
  trusted.
- **GraphQL contract**: same structure works for GraphQL boundaries
  once the intent schema gains a `graphql-resolver` semantics
  variant. Defer.
- **Existing handler packs**: no changes. Intent specs pair via
  boundary key; handler-side extraction is unchanged.

## Open questions

- **Audience taxonomy.** The concept-design framing requires
  audience indexing to be sharp, but the v0 schema accepts any
  string. The right model is probably a project-local
  `intent.config.yaml` that declares audience names; the checker
  warns on unknown audiences and errors on missing-audience specs.
  Decide during implementation.
- **Inline intent in code comments?** Some teams prefer
  `@suss-intent` JSDoc / TSDoc blocks on the handler itself, not a
  separate file. v0 ships file-based; comment-based intent could
  follow as a second reader. Question: does it become noisy on
  large handlers, or does co-location win?
- **Intent versioning.** When intent and code drift intentionally
  (intent changed for the new release, code hasn't caught up), there
  needs to be a way to express "this finding is expected for the
  next sprint." Suppression mechanism already exists
  ([suppressions](../../suppressions.md)) — verify it composes with
  intent findings without new work.
- **Multi-audience purpose**. One boundary, two intent specs (one
  per audience). Same handler, two truth comparisons. Schema needs
  to support either N files per boundary or one file with N
  `audience` blocks. Defer to the audience-annotation work.
- **PR-diff mode.** Charity's framing emphasizes the loop. One
  natural follow-on: `suss check --intent intents/ --diff main`
  reports only findings introduced by the current PR. Out of scope
  for v0 but worth keeping the interface open to it.

## Validation

1. Unit tests for `@suss/contract-intent`: schema validation,
   single-file load, directory walk, malformed-spec error surfacing.
2. Integration test in `@suss/cli` against a small fixture: a
   handler that's missing one declared transition, and one whose
   body shape disagrees with intent. Verify the two finding kinds
   fire.
3. The pair-frontend-backend tutorial (`docs/tutorial/pair-frontend-backend.md`)
   gets a second variant: same scenario, but with an intent spec
   instead of an OpenAPI document as the ground truth. Demonstrates
   the same checker working on team-authored intent.
4. Dogfood: write intent specs for two or three boundaries in suss
   itself (e.g. the `suss extract` command surface, the `suss check`
   output shape). Run intent checking against the actual code and
   confirm the findings are sensible.

## Doc impact

- New: `docs/guides/author-intent-specs.md` — how-to for the v0
  authoring workflow.
- New: `docs/reference/intent-schema.md` — schema reference.
- Updated: `docs/contracts.md` — adds "intent" as a fourth source
  alongside specification / observation / derivation, framed as
  *team-authored* specification distinct from third-party schemas.
- Updated: `docs/internal/concept-design.md` — the PRD section gets
  a "see proposals/intent-specs.md" link and a brief shipped-state
  note once v0 lands.
- Updated: `docs/internal/backlog.md` — `#intent-specs` entry moves
  to the "in flight" section.

## Cost estimate

- Schema + Zod definition: half a day.
- `@suss/contract-intent` reader (single-file + directory + CLI
  loader): 1 day.
- `checkIntentAgreement` + finding kinds: 1 day.
- Well-formedness validator + load-time error surfacing: half a day.
- Tests + integration test + tutorial variant: 1 day.
- Doc updates: 1 day.

Total: ~5 days for v0 with the demo scenario passing end-to-end.

## Sequencing

- **Lands after** the adapter ECMAScript ownership work ([proposal](adapter-ecmascript-spec.md))
  so the demo's frontend / consumer side actually produces
  field-level findings. Without that, the intent-vs-code comparison
  is shallower than the demo suggests.
- **Independent of** runtime-node implementation, the
  `framework-process-env` merge, and the React root-walk work.
- **Precedes** sync-chain identification, audience annotation,
  quality specs, and observation adapters — those are the next
  layer of the same arc and all benefit from the intent shape
  being in production use first.
