# Contract shapes

What "contract" means in suss, why there's more than one shape, and how the taxonomy anchors downstream decisions about stubs, checking, and new domain coverage.

Related: [`contract-sources.md`](contract-sources.md) (the readers that produce contract-derived summaries — OpenAPI, CloudFormation, AppSync, Storybook, Prisma), [`boundary-semantics.md`](boundary-semantics.md) (how boundaries themselves vary), [`internal/roadmap-react.md`](internal/roadmap-react.md) (first multi-shape domain we're tackling).

## The problem with treating "contract" as one thing

Suss started with HTTP, where the dominant contract shape is a schema — OpenAPI, ts-rest `responses`, CFN `MethodResponses`. All three describe the interface: what types flow across the boundary, with status codes and body schemas as the enumeration. Suss's earliest checkers compared inferred behaviour against a declared schema, end of story.

That framing quietly assumes the schema is the whole contract. It isn't, even for HTTP — a Pact recording and an OpenAPI spec say different things, and teams use both for different purposes. When we look at other domains, the assumption breaks outright:

- A React component's full contract is never "the props interface." It's some combination of snapshots, Storybook scenarios, Playwright tests, Figma mocks, and accessibility specs. Each captures a different slice.
- A database boundary's contract lives in a schema file *and* in migrations, *and* in seed data representing canonical states, *and* possibly in ER diagrams.
- A queue boundary's contract is a message schema *plus* an ordering / retry / DLQ policy that schema alone doesn't express.

Suss positions itself as a "behavioral understanding platform." To honor that, we need to name contracts in their plurality and design for it.

## The taxonomy

Five contract shapes. Any substantive domain tends to use several.

### 1. Schema — "what types flow across?"

Structural declarations of the interface. Types, cardinality, required-ness, enumerated values.

- OpenAPI 3.x, ts-rest `responses`, CFN `MethodResponses`, GraphQL SDL (partly)
- Prisma schemas, TypeScript interfaces for props
- Message schemas (Avro, Protobuf, JSON Schema)
- Database DDL

**Epistemic character:** specification. Declares what's *allowed* to cross.

**Limits:** says nothing about *when* each case fires, under what conditions. A schema for HTTP responses doesn't tell you which status the handler produces when `user.deletedAt` is set.

### 2. Examples — "what's one concrete instance of a valid interaction?"

Recorded concrete pairs of input/output or request/response.

- Pact contracts (consumer-recorded request/response pairs)
- HAR files (browser-recorded network captures)
- Fixture files (hand-authored canonical shapes)
- API documentation with curl examples

**Epistemic character:** observation. Captures what happened *once*, somewhere.

**Limits:** point-samples of a larger space. Coverage is as good as the example set, never better. Teams often write two or three examples per endpoint and call it done.

### 3. Tests — "what should be true when X happens?"

Behavioral assertions, usually expressed as interaction sequences.

- Playwright specs: `page.click('submit'); expect(page).toHaveText(...)`
- Cypress, WebDriverIO, Puppeteer scripts
- RTL component tests, enzyme
- REST-assured / supertest integration tests
- Spock / RSpec behavioral style

**Epistemic character:** observation (of asserted behavior under specific inputs). Similar to Examples but focused on behavior chains rather than single data shapes.

**Limits:** same coverage problem as Examples — tested cases only. Test authors pick the cases.

### 4. Snapshots — "what did the output look like?"

Serialized captures of output for specific inputs.

- Jest / Vitest `__snapshots__/*.snap`
- Visual regression baselines (Percy, Chromatic, Playwright screenshots)
- Database "golden" query result captures
- Schema diff baselines

**Epistemic character:** observation + regression anchor. Says "this output is what we agreed to yesterday; alert on change."

**Limits:** structural-only (usually). Often misses event handlers, timing, state transitions. The snapshot says "the tree looked like this" — not "these handlers fired when clicked." And like Examples and Tests, tested inputs only.

### 5. Design — "what should this look like / do, by intent?"

Design-source-of-truth artifacts, upstream of code.

- Figma / Sketch / Adobe XD files
- Design tokens (style primitives, tokenized spacing / color / typography)
- Prototypes (Figma prototype links, Principle animations)
- Accessibility specifications (ARIA patterns, WCAG conformance targets)

**Epistemic character:** intent. Declares what the output *should* be independent of whether any code exists.

**Limits:** visual / interactive axis only, typically. Business logic and server-side behavior are invisible in design files.

## Epistemic character matters more than shape

The shape table above sorts by artifact type, but what actually matters for checker logic is the **epistemic character** — what kind of truth does this shape assert?

Three broad characters:

**Specifications** assert what *should* be the case. Schema and Design both declare intent. Inferred summaries derived from code can be compared against specs; drift means code isn't meeting spec. The tradeoff is that specs are often under-specified (OpenAPI doesn't say which status fires when; Figma doesn't say which events are handled).

**Observations** record what *was* the case, once, somewhere. Examples, Tests, Snapshots all capture concrete firings. Coverage is the fundamental limit: an observation says nothing about cases you didn't test. They're great regression anchors but weak contracts on their own — hence Pact's recurring criticism "your contracts are only as complete as your interactions."

**Derivations** compute what the code *does* across all paths. The inferred `BehavioralSummary` is this category, and it's the only shape suss produces itself. Derivations are complete in a way observations aren't — they enumerate every branch — but they're only as trustworthy as the analysis (opaque predicates, un-resolvable dependencies, cross-module jumps that defeat the extractor all reduce coverage).

The most interesting findings come from cross-character comparison:

- **Derivation ⊄ Specification** → code has a path the spec doesn't declare ("handler produces status 500 that OpenAPI doesn't mention")
- **Specification ⊄ Derivation** → spec declares a case code can't reach ("OpenAPI declares 404 but no handler branch produces it")
- **Observation ⊄ Derivation** → something happened that the code shouldn't be able to produce (rare but high-signal; usually a bug)
- **Derivation ⊄ Observation** → code reaches paths no test has covered; coverage signal, not a finding per se

### Connection to concept design

Daniel Jackson's concept-design framework (MIT) describes software as concepts (self-contained units with state + actions + purpose) linked by synchronizations (explicit rules of the form "when action A₁ fires in concept C₁, action A₂ fires in concept C₂"). Synchronizations can only restrict behavior, never enable new behavior. Primary references: Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021); Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Meng & Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025).

The epistemic split above maps closely. A specification names a concept's *purpose and declared actions*; an observation records a single *synchronization firing*; a derivation enumerates the full *action space reachable from code*. Suss's `contractDisagreement` findings, fired when sources disagree about what actions exist at a boundary, are the closest proxy we have for "purpose violated" without requiring users to author intent declarations. See [`roadmap-react.md`](roadmap-react.md#react-components-are-n-code-units-not-one) for how this framing informs the React multi-code-unit decision, and [`internal/concept-design.md`](internal/concept-design.md) for the long-form mapping (audience indexing, failure modes of bottom-up derivation, and how PRDs / intent specs fit the concept-declaration shape).

## How suss absorbs contracts today

Two of the five shapes — **schema** and **spec** — ship today across HTTP, GraphQL, AppSync, message-bus, storage-relational, and component domains. The contract reader pipeline (`suss contract --from <source>`) covers seven sources:

- `@suss/contract-openapi` — OpenAPI 3.x (schema, HTTP)
- `@suss/contract-cloudformation` — CFN / SAM templates with API Gateway resources (schema, HTTP), built on the internal `@suss/contract-aws-apigateway` shared library
- `@suss/contract-appsync` — CFN templates with `AWS::AppSync::*` resources (schema, GraphQL)
- `@suss/contract-graphql` — plain GraphQL SDL files (schema, GraphQL)
- `@suss/contract-prisma` — `schema.prisma` files (schema, storage-relational)
- `@suss/contract-storybook` — CSF3 `.stories.tsx` files (spec, component domain)
- (aws-apigateway is internal to the cloudformation / appsync readers)

Framework packs also derive contract declarations directly from source: ts-rest's `responses`, Apollo / NestJS GraphQL `typeDefs`, and ts-rest-zod schemas all populate per-protocol contract metadata at extraction time.

Comparison checkers in `@suss/checker` operate per-protocol:

- `checkContractAgreement` / `checkContractConsistency` — HTTP schema declarations vs derived handler / consumer transitions
- `checkGraphqlContractAgreement` — GraphQL `metadata.graphql.declaredContract` cross-pair check
- `checkMessageBus` — producer / consumer pairing on named queues; orphan / unused channel reporting
- `checkRelationalStorage` — Prisma schema entity vs handler `interaction(class: "storage-access")` effects
- `checkRuntimeConfig` — env-var declarations vs handler reads
- `checkComponentStoryAgreement` — Storybook stories vs the React component they target

What's still missing from the taxonomy:

- **Observation shapes.** No reader ingests Jest snapshots, Playwright traces, or production observability data yet. The IR shape that would carry these (`confidence.source: "observation"`) exists; the reader pipeline doesn't.
- **Test shapes.** Same gap — RSpec / supertest / RTL test assertions aren't yet a source.
- **Intent shapes.** Team-authored intent specs are scoped in [`proposals/intent-specs.md`](internal/proposals/intent-specs.md) as the next major direction. Third-party schemas (OpenAPI, GraphQL SDL) cover some intent today, but they were authored as specs, not as team intent.
- **Design shapes.** Figma / design-token integration is deliberately deferred — design files rarely live in the repo, and the Figma REST API integration is expensive relative to the signal. The taxonomy keeps design-as-contract listed because the *epistemic character* (intent) is distinct; the *artifact pipeline* isn't planned.

## Metadata namespacing as shipped

The metadata layout follows a protocol-first convention rather than the original shape-first sketch: declarations live under the protocol they describe, regardless of which artifact pipeline produced them. This means a GraphQL contract derived from an SDL file and a GraphQL contract derived from Apollo's `typeDefs` populate the same `metadata.graphql.declaredContract` field, so the checker doesn't care about the source.

Namespaces in use:

- `metadata.http.*` — declaredContract, statusAccessors, bodyAccessors, statusRange (HTTP protocol)
- `metadata.graphql.*` — declaredContract, document, schemaSdl (GraphQL protocol)
- `metadata.appsync.*` — kind (AppSync resolver type: UNIT vs PIPELINE)
- `metadata.storybook.*` — story-level metadata (component spec)
- `metadata.component.*` — Storybook-bound component context

New domains add their own protocol namespace (`metadata.<protocol>.*`) rather than nesting by source. The checker reads the namespace it understands; downstream tooling ignores what it doesn't.

## What the checker shape will look as new sources ship

Two extension axes that are now visible after a year of shipping:

- **New source for an existing protocol.** A jest-snapshots reader emits the same component-shaped summaries the storybook reader emits, but with `confidence.source: "observation"` instead of `specification`. Existing component-level checkers stay the same; severity differs by character (per [Epistemic character matters more than shape](#epistemic-character-matters-more-than-shape) above).
- **New protocol entirely.** Message-bus / storage-relational / runtime-config were added by introducing a new `BoundarySemantics` variant, the corresponding `metadata.<protocol>.*` namespace, and a per-protocol checker. The path is documented in [boundary-semantics.md](boundary-semantics.md).

Severity follows epistemic character, not source:

- Derivation violates a Specification → `error` (code has drifted from what it promised)
- Observation violates a Specification → `warning` (something happened that the spec said couldn't)
- Observation absent for a Specification case → `info` (gap in coverage, not a bug)
- Two Specifications disagree → `warning` (reconcile needed; existing `contractDisagreement`)

These heuristics refine as more shapes ship. Not all combinations are meaningful; not all need the same severity.

## How new domains get added

Adding a new domain (React, Postgres, Kafka) is four shape-and-direction questions:

1. **What's the boundary?** Component ↔ DOM; code ↔ database; producer ↔ queue.
2. **What's the observable channel?** DOM tree + events; SQL query + result set; message envelope.
3. **What contract shapes exist in this domain?** List them from the five categories; assess which are commonly used and which are gaps.
4. **Which shapes feed a meaningful check against which other shapes?** Not all combinations are useful; designed per-domain.

For each domain we ship:
- An extractor (pattern pack + adapter support) that produces inferred summaries from source code
- One or more stub readers covering the dominant contract shapes
- Checker extensions for the meaningful cross-shape checks

Shipping all three in one go isn't required. React's plan ([`roadmap-react.md`](roadmap-react.md)) stages the extractor first, then Storybook, then Figma, then cross-shape checking — each phase answers design questions the next one depends on.

## What this doc commits us to

- No new checker logic is added under the assumption that contracts are schema-shaped. Every check cites which shape(s) it operates on.
- The `@suss/contract-*` naming pattern stays as the surface for new readers; one package per source.
- Metadata namespacing follows the protocol-first convention shipped to date (`metadata.<protocol>.*`). New protocols add their own namespace.
- The five-shape taxonomy is the working vocabulary. When a concrete artifact doesn't fit, the taxonomy is updated rather than the artifact forced into a slot.
- Future contract-related design docs cite epistemic character explicitly when discussing checker behaviour.

## What this doc does *not* commit us to

- Reading every shape in every domain. Pragmatic coverage first; comprehensive later.
- A universal cross-shape comparison framework. The interesting comparisons are protocol-specific (HTTP OpenAPI vs Pact doesn't share machinery with React Storybook vs Figma). Generalisation is bottom-up.
- A fixed finding taxonomy. `contractDisagreement` was added when cross-source HTTP contracts shipped; protocol-specific kinds (`unhandledProviderCase`, `consumerFieldMismatch`, `providerContractViolation`, GraphQL agreement findings) followed. Additional kinds ship as domains demand them.
