# The intent layer — design proposal

A plan for closing the loop between *what the code does* and *what the
team meant to ship*. The first half (derived behavioural summaries
from code) ships today. This proposal designs the second half — a
structured intent layer that pairs against the derived side — and
sequences its delivery as `v0.1` … `v0.4`.

Worked examples live under
`docs/internal/proposals/intent-layer-examples/`. The Fastify
`users-lookup` example exercises v0.1; the aws-sqs `order-intake`
example exercises v0.2. Both target fixtures that today's checkers
already analyse.

## Why this exists

The argument cuts across several voices in different traditions — the
observability lineage (Charity Majors et al.), concept design (Jackson),
the formal-methods / lightweight-spec writers (Hillel Wayne and
others), and the AI-codegen commentary (Willison, Larson) that's
sharpened the question over the last two years. The shared claim: as
code becomes cheaper to generate, the bottleneck moves from coding to
verifying. Verification needs a structured statement of *what was
meant*, in the same shape as *what shipped* and (eventually) *what
production does*. AI codegen makes this acute — when humans aren't
the bottleneck on producing code, the question shifts to "is what we
got what we meant," and ad-hoc PRDs in disparate tools don't answer
it at PR-review time.

Suss today has derived summaries from code (one side of that loop)
plus third-party schemas (OpenAPI, GraphQL SDL, Prisma) that
happen to declare structural truth about an API. None of these were
authored as *team intent* — they were authored as wire contracts,
data-model definitions, or vendor-supplied descriptions. The team's
own intent — what the PR was supposed to ship, what the product
description meant by "order is acknowledged and queued," what the
engineering doc said about the failure mode — lives in markdown PRDs,
Notion pages, Confluence spaces, Linear / Jira ticket descriptions,
chat threads. Each tool is structured for its own purpose and none
of those structures are comparable against running code.

Two costs of staying where we are:

1. Every project ships derived summaries that have no top-down ground
   truth to anchor them. Drift between implementations is caught;
   drift between *intent and implementation* isn't.
2. AI codegen amplifies that drift specifically. A natural-language
   PRD in Notion can't gate generation; the code that comes back
   matches the prompt's phrasing without anyone able to check it
   against a structured statement of what was wanted.
3. Outside review of the project named the PRD-as-typed-concept
   framing as the single sharpest unrealised idea — useful immediately
   as a vocabulary, more useful once the tool catches up to it.

## Two citizens, one layer

Intent splits into two distinct artifacts that serve different
purposes. The two are framed not by who writes them (any team
member can author either, depending on the team's working style) but
by what they're for:

| | Outcome intent | System intent |
|---|---|---|
| **Purpose** | Describe what should happen for the user / consumer in terms they care about. | Specify how the system should behave — the contract a downstream tool can compare to running code. |
| **Register** | Descriptive, human-readable, scenario-shaped. | Structural, machine-comparable, contract-shaped. |
| **Where it lives today (without suss)** | Notion / Confluence pages, Linear / Jira tickets, markdown PRDs in the repo. | OpenAPI files, Prisma schemas, code comments, sometimes nowhere. |
| **What changes with suss** | Same authoring shape, but committed to the repo alongside code and machine-checkable for coverage. | A first-class team-authored artifact that pairs against derived code summaries. |
| **Typical authors** | Whoever writes PRDs today (PM, designer, founder, eng lead). | Whoever owns the contract surface (engineer, architect). |
| **Specificity** | User-observable ("rate-limited request gets a friendly rejection"). | Contract-level ("POST /auth/login returns 429 with `{error, retryAfter}`"). |
| **File suffix** | `*.prd.yaml` | `*.system.yaml` (or `*.intent.yaml` — v0.1's existing suffix) |
| **Static check** | Coverage: is there a system intent that claims to implement each scenario? | Pairing: does the code match the declared structural behaviour? |
| **Runtime check (future)** | Runtime observability: did users actually experience the declared outcomes? | Runtime observability: does the system actually behave as declared? |

The descriptive and structural shapes carry their own benefits and
limits. Descriptive PRDs are cheap to write and stay readable as the
team grows, but resolving them against running code requires the link
to system intent. Structural system intent is precise enough to compare
field-by-field but loses the user-framing that makes a PRD
intelligible to anyone outside the team that authored it. The intent
layer keeps both as first-class citizens so neither pays the other's
cost.

A team can adopt either side independently — outcome intent first to
make planning gaps visible, system intent first to formalise contracts
the OpenAPI / Prisma readers don't already cover.

## Author-facing surface vs structural model

The PRD shape is one of the two author-facing surfaces. Anyone
writing a PRD types purpose, audience, and scenarios; the structural
internal vocabulary (boundary, workflow, concept) is what the reader
walks and what findings reference, not what the author has to learn.

```yaml
# author-facing PRD — what a PM writes
kind: prd
title: User profile lookup
purpose: Fetch a user's profile information by id.
audience: web-client
scenarios:
  - title: Successful lookup
    when: A request comes in with a known user id
    expect: users-lookup.found
  - title: Missing id
    when: The request omits the id parameter
    expect: users-lookup.missing-id
```

The structural vocabulary appears in two places, both optional:

- **Findings** reference the concrete endpoint or function, not
  abstractions: `intentUnimplemented at GET /users/:id`.
- **Engineers** who want fine-grained precision over sync chains can
  author at the workflow level directly. Otherwise, the structural
  model is the reader's job.

## System intent has three kinds

System intent comes in three kinds, each comparable to the level above
and below it. Drift between adjacent levels is a finding.

1. **Boundary intent** — a contract for one endpoint or function
   call. Self-contained, no composition. v0.1 ships this.
2. **Workflow intent** — a sequence across boundaries: ordered
   effects (message sends, storage writes, function calls), input
   sources (queue reads, scheduled triggers), and the success
   criteria that tie them together. v0.2 ships this.
3. **Concept declaration** — what a unit of user-visible value does:
   the purpose it serves, the state it owns, the actions it exposes,
   and the canonical scenario that demonstrates the purpose. The
   long-form mapping to Daniel Jackson's concept-design vocabulary
   lives in [`concept-design.md`](../concept-design.md); this
   proposal points there rather than re-litigating it. v0.3 ships this.

Outcome intent (PRDs) sits above all three — a PRD's scenarios link to
outcomes declared at any system-intent kind.

A fourth axis, **outcome / SLO**, is cross-cutting rather than a
layer. SLOs can attach to a concept, a workflow, a boundary, or even a
specific transition. Out of scope until runtime observability adapters
ship in v0.4.

## Arazzo as inspiration for the workflow layer

[Arazzo](https://spec.openapis.org/arazzo/latest.html) (Linux
Foundation, late 2024) describes multi-step API workflows in YAML —
ordered operations with success criteria and output forwarding
between steps. It's the closest existing standard to what v0.2
workflow intent needs for the HTTP slice and worth borrowing
mechanics from. Arazzo only covers HTTP-to-HTTP workflows though, so
the v0.2 schema extends the shape to non-HTTP boundaries (function
calls, queue sends, storage writes) and adds the purpose / audience
wrapper that places a workflow inside a concept.

## Linking: outcome ids

Every transition and effect in a system intent carries an `id`. PRDs
reference outcomes by qualified id: `<system-intent-name>.<outcome-id>`.

```yaml
# in a PRD
expect: users-lookup.found-admin

# resolves to:
#   system intent with name: users-lookup
#   transition with id: found-admin
```

The dotted form keeps PRDs decoupled from the underlying API surface.
An endpoint rename (`GET /users/:id` → `GET /accounts/:id`) doesn't
touch the PRD as long as the system intent's name and outcome ids stay
stable. If outcome ids haven't been declared yet, the PRD can fall
back to raw `(operationId, status)` or `(method, path, status)` refs;
the migration path is to add outcome ids to the system intent and
update PRD references.

When the reference is ambiguous (two system intents named
`users-lookup` exist), the checker emits `intentScenarioAmbiguous`.
When it's dangling (no matching name, or matching name but unknown
outcome id), the checker emits `intentScenarioUnmatched`. The id
syntax is structured enough to make renames a tracked operation rather
than a grep-and-replace.

## Worked example #1 — Fastify `/users/:id` (v0.1 territory)

See `intent-layer-examples/fastify-users/` for the full files.

The Fastify fixture's `/users/:id` handler has four transitions:
`!id` → 400, `!user` → 404, `user.role === "admin"` → 200 enriched,
default → 200 plain. The system intent declares all four with
matching outcome ids; the PRD references each as a scenario.

Static checks that fire:

- **PRD → system intent (coverage).** Each PRD scenario's `expect`
  resolves to an outcome id in the system intent. No findings when
  intent matches.
- **System intent → derived code (pairing).** Each system intent
  transition pairs against a derived handler transition. No findings
  when shapes match.

Drift demos:

- PRD adds a scenario `users-lookup.deleted` and no system intent
  declares it → `intentScenarioUnmatched`.
- System intent declares `found-admin` but the handler drops the
  admin branch → `intentUnimplemented`.
- Handler adds a 410 branch (soft-delete) that no system intent
  declares → `intentExceeded`.
- System intent declares body `{ id, fullName }` but the handler
  returns `{ id, name }` → `intentFieldMismatch`.

The first three of those drift findings are already wired
end-to-end in the shipped checker (`@suss/checker`); the fourth
field-level case relies on the existing body-shape comparison.
The PRD-coverage finding is the v0.1 addition.

## Worked example #2 — aws-sqs Orders (v0.2 territory)

See `intent-layer-examples/aws-sqs-orders/` for the full files.

The aws-sqs fixture's `OrderProducer` accepts an order, publishes
`{ id, total }` to `OrdersQueue`, and returns `{ ok: true }`.
`OrderConsumer` reads from the queue and destructures `{ id,
totalAmount }` — an intentional field-name mismatch.

The intent layer expresses this with two `kind: workflow` files plus
one PRD:

- `order-intake.system.yaml` declares one transition
  (`acknowledged`) and one effect (`queued-for-processing` →
  message-send to `OrdersQueue` with `{ id, total }`).
- `order-processing.system.yaml` declares one input (queue source
  `OrdersQueue` with `{ id, total }`) and one transition
  (`processed`).
- `order-intake.prd.yaml` declares two scenarios, one referencing
  both `order-intake.acknowledged` and `order-intake.queued-for-processing`,
  the other referencing `order-processing.processed`.

Drift demos:

- The producer changes its emitted body from `{ id, total }` to
  `{ id, totalAmount }` without updating `order-intake.system.yaml`
  → `intentFieldMismatch` at the system-intent ↔ code layer.
- A team removes the `total` field from the system intent's effect
  body but the PRD still expects `queued-for-processing` to carry the
  order amount → caught by the PRD coverage check (the scenario
  resolves to an outcome whose body no longer matches the PRD's
  stated intent — flagged as `intentScenarioBodyDrift`).

These are the integration-bug failure modes the
[anatomy-of-an-integration-bug](https://nimbusai.dev/blog/the-anatomy-of-an-integration-bug-its-not-just-your-apis)
demo exists to illustrate: a single-service refactor that silently
breaks a cross-service consumer. The intent layer catches them before
the PR ships rather than after the production incident.

## Checking pipeline

```
PRD (scenarios, audience, purpose)
   │
   │  Coverage check (per scenario):
   │  - resolve `expect` outcome ref against loaded system intents
   │  - emit intentScenarioUnmatched / intentScenarioAmbiguous /
   │    intentScenarioBodyDrift as appropriate
   ▼
System intent (boundary / workflow / concept)
   │
   │  Pairing check (existing machinery, slightly extended):
   │  - pair by boundary key against derived code summaries
   │  - emit intentUnimplemented / intentExceeded / intentFieldMismatch
   ▼
Derived code summary
```

Two hops, each independently useful. A team can author either side
first; coverage and pairing fire on whatever's loaded.

## Authoring paths: writing intent and generating it from code

Intent docs reach the repo two ways, both treated equally:

**Writing intent (greenfield).** The team writes intent declaratively,
alongside code or in front of it. PRD first, then implementation; or
both together as the feature is scoped. This is the natural path on
new features and on small projects where writing intent against every
boundary is tractable.

**Generating intent from code (brownfield).** Treat the current code
as a stand-in for intent — extract derived summaries, transform them
into starter system intent docs, then have the team curate the result
into team intent. Lower barrier on a project with thousands of
existing endpoints. Different tradeoff: the starter describes what
the code does today, not necessarily what was meant.

Both paths produce the same shape. The reader doesn't distinguish a
doc the team wrote directly from one the generator produced and the
team then curated — they're the same YAML on disk.

What does differ is **provenance**, and the design has to carry it
through to make brownfield adoption work:

- Each system intent and PRD carries an optional `source` field with
  values like `"author"` (default; the team wrote this), `"inferred"`
  (straight output of `suss infer`, not yet curated), or
  `"inferred, curated"` (inferred then edited by a person).
- Findings against `inferred` intent that hasn't been curated yet
  are downgraded — the intent describes what the code did when the
  inference ran, so any "intent says X, code does Y" finding is most
  likely a code change since the inference, not an authoring error.
  The team's curation step is what moves intent from `inferred` to
  `inferred, curated`, signalling that drift findings should now fire
  at full severity.
- Inferred intent that's been curated drifts from re-inferred intent
  the same way any spec drifts from code. The refresh workflow
  (re-infer, then merge against curation) is its own scope, sketched
  below.

### `suss infer` (v0.1.1)

`suss infer` walks derived summaries from `suss extract`, picks the
boundaries the team scopes (filter by file glob, by framework, by
boundary kind), and emits one boundary system intent per boundary
with `source: "inferred"`. Outcome ids derive from status codes
(e.g. `200-ok`, `404-not-found`) with a rename step expected during
curation.

```bash
# Greenfield workflow
$ # Team writes intent/users-lookup.intent.yaml by hand.

# Brownfield workflow
$ suss extract -p tsconfig.json -f express -o summaries/code.json
$ suss infer --from summaries/code.json --out intent/
# Produces one intent/<endpoint>.intent.yaml per boundary,
# with source: "inferred" and placeholder outcome ids.
$ # Team reviews, renames outcome ids, adds purpose/audience,
$ # changes source to "inferred, curated" in each file.
```

The implementation mostly reshapes fields — derived summary on one
side, boundary intent on the other. The harder design question is the
**refresh** flow when code changes after inference:

1. Naive: re-infer over the existing intent files. Loses curation
   edits.
2. Merge against a baseline: track an `inferred-baseline.yaml`
   snapshot next to each curated intent file. Re-inference produces a
   new baseline; the diff against the previous baseline shows code
   changes; the diff against the curated file shows team edits; the
   tool merges where it can and reports conflicts where it can't. The
   right shape, but not v0.1.1 work — its own ~3-day arc.

For v0.1.1, ship naive re-inference with a clear warning:
"re-inferring over curated intent will overwrite your edits; use
`--into <new-dir>` to write the re-inferred output to a separate
directory for manual reconciliation." Merging against a baseline is
a v0.1.2 / v0.2 follow-on.

### Subset selection

Teams adopting the layer rarely want to generate over the whole
repo. Selection comes from existing filtering at extract time
(`--files`, `-f <framework>`, etc.) — `suss infer` reads
the summaries file the team filtered into, so boundary selection
happens before generation.

### Implications for the v0.1 schema

The `source` field needs to be in the schema from v0.1 — `suss infer`
is v0.1.1, but if the schema doesn't carry `source` from the start,
curated intent files written in v0.1 can't be told apart from inferred
ones once `suss infer` ships. Adding a default `source: "author"` to
the boundary intent schema in v0.1 keeps the migration path clear.

## Sequencing

| Stage | Adds | Demo fixture | Status |
|---|---|---|---|
| **v0.1** | Boundary system intent + PRD shape + coverage checker + outcome ids on transitions + `source` provenance field | Express `/users/:id` | Schema shipped (commit `fa19f1d`); PRD coverage checker + provenance field is the remaining v0.1 work |
| **v0.1.1** | `suss infer` (infers intent from code for brownfield adoption) | Same Express fixture, inferred then curated | ~2 days |
| **v0.2** | Workflow shape (effects, inputs, queue references); non-HTTP boundary semantics; three-way merge for generator refresh | aws-sqs Orders | Pending; ~5 days |
| **v0.3** | Concept declarations with state + actions + failure-mode predicates | TBD | Gated on workflow shape shipping |
| **v0.4** | Runtime observability adapters; SLO declarations | Gated on runtime observability adapters | Gated |

v0.1 is what the current session targets. The shipped
`@suss/contract-intent` reader (commit `a7fced4`) handles half of
v0.1 — the system intent boundary form. The remaining v0.1 work:

1. Add `id` field to each transition in the boundary-intent schema
2. Add `kind: prd` to the contract-intent schema with `scenarios[]`
3. Build a coverage checker that walks PRDs, resolves outcome refs
   against system intents, emits the four new finding kinds:
   - `intentScenarioUnmatched` (no matching outcome id)
   - `intentScenarioAmbiguous` (multiple matching outcome ids)
   - `intentScenarioBodyDrift` (PRD's expect carries body
     expectations that disagree with the resolved outcome)
   - `intentSpecMalformed` (load-time validation failure)
4. Integration test: run the Fastify worked-example through the
   pipeline, assert each drift case fires as expected
5. CLI: `suss contract --from intent` already handles the directory
   walk; verify it picks up `.prd.yaml` files alongside
   `.intent.yaml` files

## Out of scope, deferred

- **Backward comparison (concept-shape audit).** "Did we ship a
  fused / smeared / phantom concept?" Needs failure-mode detection
  from the existing backlog; lands with v0.3.
- **Lateral comparison (intent vs intent for different audiences).**
  Same concept's PRD for end-users vs admins disagrees. Requires
  audience tagging; defer.
- **Quality specifications (latency, error budget, observability
  obligations).** Per `internal/quality.md`, full intent carries
  quality alongside capability. Defer until capability-only intent is
  in production use.
- **Diff mode** (`suss check --intent intents/ --diff main` →
  findings introduced by the current PR). Worth holding the CLI
  interface open to.
- **Generated intent stubs from existing code.** Reverse mode that
  emits a starter intent spec from a derived summary so teams can
  adopt intent on an existing codebase. Mechanically falls out of v0.2
  once the shape is in production use.
- **LLM-mediated authoring help.** An LLM can suggest outcome ids or
  boundary refs from a PRD's prose at write time; the suggestion is
  committed and reviewed. The LLM stays out of the verification path.
  Out of scope for the v0.1 schema; relevant once teams are authoring
  PRDs at volume.

## Mechanics

### Schema (v0.1 completion)

The contract-intent schema gains a top-level `kind` discriminator:

```ts
const IntentDocSchema = z.discriminatedUnion("kind", [
  BoundaryIntentSchema,   // existing — `kind: boundary`
  PrdIntentSchema,        // new       — `kind: prd`
]);
```

`BoundaryIntentSchema` gains an `id` field on each transition (the
outcome id PRDs reference). The existing reader keeps producing
`BehavioralSummary[]` for boundary intent; the new PRD path produces a
new metadata-carrying summary or a separate PRD-summary type the
coverage checker consumes.

The PRD-summary shape:

```ts
interface PrdSummary {
  title: string;
  purpose: string;
  audience: string;
  scenarios: Array<{
    title: string;
    when: string;
    expect: string | string[]; // qualified outcome ref(s)
  }>;
  source: SourceLocation;
}
```

### Reader

`@suss/contract-intent` exports stay the same name; the entry points
accept either kind. Directory walks pick up `*.intent.yaml`,
`*.prd.yaml`, `*.intent.json`, and `*.prd.json` files. The reader
dispatches on the top-level `kind` field.

### Coverage checker

New: `@suss/checker/intent/prdCoverage.ts`. Given all summaries
(derived code + boundary intent + PRD), for each PRD scenario:

1. Parse `expect` as `<name>.<outcome-id>` (string) or list of same.
2. Look up the system intent with that `name` in the summary set
   (intent summaries carry the name on `metadata.intent.name`).
3. If no match → `intentScenarioUnmatched`. If multiple →
   `intentScenarioAmbiguous`. If matched, check the outcome id
   exists on a transition or effect → same finding shapes.

Wired into `checkAll` alongside `checkIntentAgreement`.

### Finding kinds

Five new entries in `FindingKindSchema`:

- `intentScenarioUnmatched` (severity: warning — planning gap, not
  implementation defect)
- `intentScenarioAmbiguous` (severity: warning — author needs to
  qualify the reference)
- `intentScenarioBodyDrift` (severity: warning — body shape declared
  on a PRD scenario doesn't match the resolved outcome's body)
- `intentSpecMalformed` (severity: error — load-time validation
  failure)
- (Already shipped: `intentUnimplemented`, `intentExceeded`,
  `intentFieldMismatch` — these stay as the system-intent ↔ code
  layer; PRD-level findings are distinct.)

## Validation

The Fastify worked-example doubles as the v0.1 integration test:

1. Place the PRD + system intent files in
   `fixtures/fastify/intent/` (move from
   `docs/internal/proposals/intent-layer-examples/fastify-users/`).
2. Add `fastifyIntentIntegration.test.ts` to the CLI package that:
   - Extracts handler summaries from `fixtures/fastify/handlers.ts`
   - Reads the intent files via `@suss/contract-intent`
   - Runs `checkAll` over the union
   - Asserts the happy path produces zero intent findings
3. Add fixture variants for each drift case (PRD scenario without a
   system intent target, system intent transition the handler doesn't
   produce, handler transition no system intent declares) and assert
   the corresponding findings fire.

## Doc impact

- New: `docs/guides/author-intent-specs.md` — how-to for the v0.1
  authoring workflow (PRD + system intent file shapes).
- New: `docs/reference/intent-schema.md` — schema reference.
- Updated: `docs/contracts.md` — "intent" is now a fourth source
  alongside specification / observation / derivation, with the split
  between PM-authored and engineer-authored intent made visible.
- Updated: `docs/internal/concept-design.md` — the PRD section links
  to this proposal and notes the shipped state once v0.1 lands.
- Updated: `docs/internal/backlog.md` — `#intent-specs` moves to
  "in flight" with the v0.x sequencing.

## Cost estimate (v0.1 completion only)

- Schema discriminator + PRD shape + outcome-id field: half a day
- PRD reader path: half a day
- Coverage checker + finding kinds: 1 day
- Integration test against the Fastify fixture (happy + 3 drift
  cases): 1 day
- Doc updates: half a day

Total: ~3 days for v0.1 to be end-to-end shippable.

v0.2 (workflow grain, non-HTTP boundaries, aws-sqs worked example) is
a separate ~5 days. v0.3 / v0.4 are gated.

## Sequencing notes

- v0.1 is independent of `#46` (adapter ECMAScript ownership). The
  Fastify fixture's `/users/:id` handler extracts fully today.
- v0.2 partially depends on `#46` for any consumer-side workflow
  steps that need `.then` chain binding. The aws-sqs producer /
  consumer demo doesn't (Lambda handlers, no Promise chaining).
- v0.3 depends on the failure-mode detection backlog item.
- v0.4 depends on observation adapters from the backlog.
