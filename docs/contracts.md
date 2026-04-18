# Contract shapes

What "contract" means in suss, why there's more than one shape, and how the taxonomy anchors downstream decisions about stubs, checking, and new domain coverage.

Related: [`stubs.md`](stubs.md) (schema-shaped stubs, the one shape shipped today), [`boundary-semantics.md`](boundary-semantics.md) (how boundaries themselves vary), [`roadmap-react.md`](roadmap-react.md) (first multi-shape domain we're tackling).

## The problem with treating "contract" as one thing

Suss started with HTTP, where the dominant contract shape is a schema — OpenAPI, ts-rest `responses`, CFN `MethodResponses`. All three describe the interface: what types flow across the boundary, with status codes and body schemas as the enumeration. Cross-boundary checking in suss today compares inferred behavior against a declared schema, end of story.

That framing quietly assumes the schema is the whole contract. It isn't, even for HTTP — a Pact recording and an OpenAPI spec say different things, and teams use both for different purposes. When we look at other domains, the assumption breaks obviously:

- A React component's full contract is never "the props interface." It's some combination of snapshots, Storybook scenarios, Playwright tests, Figma mocks, and accessibility specs. Each captures a different slice.
- A database boundary's contract lives in a schema file *and* in migrations, *and* in seed data representing canonical states, *and* possibly in ER diagrams.
- A queue boundary's contract is a message schema *plus* an ordering / retry / DLQ policy that schema alone doesn't express.

Suss positions itself as a "behavioral understanding platform." To honor that, we need to name contracts in their plurality and design for it.

## The taxonomy

Five contract shapes. Any real domain tends to use several.

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

## How suss absorbs contracts today, and the gap

The only shape suss reads today is **schema**, and only three variants: OpenAPI, ts-rest `responses`, and CFN `MethodResponses`. Each is emitted as `metadata.http.declaredContract` on a summary. The checker's `checkContractConsistency` and `checkContractAgreement` both operate on this single shape.

The machinery isn't secretly HTTP-specific — it operates on `{ statusCode, body }` tuples, not HTTP — but it *is* schema-specific. It doesn't know how to read a snapshot, a story, or a Figma file. Expanding the set of contract shapes is a structural change, not a configuration one.

## What expanding the set requires

Two parallel pieces of infrastructure:

### Stub readers per shape

Each new shape needs a package that reads artifacts in that shape and produces `BehavioralSummary[]` in the same unified IR. Pattern:

- `@suss/stub-openapi` reads OpenAPI (schema shape)
- `@suss/stub-cloudformation` reads CFN (schema shape, via the aws-apigateway resource-semantics layer)
- *`@suss/stub-storybook`* — reads `.stories.ts[x]` (spec shape, component domain)
- *`@suss/stub-jest-snapshots`* — reads `__snapshots__` (observation shape, component domain)
- *`@suss/stub-figma`* — reads Figma files (design shape, visual domain)
- *`@suss/stub-playwright`* — reads spec files (observation/test shape, cross-domain)
- *`@suss/stub-prisma`* — reads `.prisma` files (schema shape, database domain)

(Italics = planned, not shipped.)

Each reader emits summaries tagged with a `provenance` (derived / independent / observed / intent — to be refined as implementation demands) so the checker can apply appropriate comparison logic.

### Shape-aware metadata

HTTP-scoped metadata lives under `metadata.http.*` today (see `docs/behavioral-summary-format.md`). Each new contract shape-domain combination gets its own namespace:

- `metadata.http.declaredContract` — HTTP schema (existing)
- `metadata.component.storybook.*` — Storybook spec for a component
- `metadata.component.snapshot.*` — snapshot observation for a component
- `metadata.component.figma.*` — Figma design intent for a component
- `metadata.database.schema.*` — Prisma / SQL schema
- `metadata.test.playwright.*` — Playwright behavioral observation
- ... and so on

The checker reads the namespaces it cares about; downstream tools ignore what they don't understand.

### Checker extensions

`checkContractConsistency` (Layer 1) and `checkContractAgreement` (Layer 2) generalize from "schema vs transitions" and "schema vs schema" respectively to cross-character comparisons. Specifically:

- **Consistency checks** — inferred derivation against any specification or observation shape at the same boundary.
- **Agreement checks** — any two specifications of the same boundary, or a specification and a canonical observation, compared for mutual consistency.

Epistemic character determines severity:

- Derivation violates a Specification → `error` (code has drifted from what it promised)
- Observation violates a Specification → `warning` (something happened that the spec said couldn't)
- Observation absent for a Specification case → `info` (gap in coverage, not a bug)
- Two Specifications disagree → `warning` (reconcile needed; existing `contractDisagreement`)

These heuristics refine as we ship more shapes. Not all combinations are meaningful; not all need the same severity.

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

- No new checker logic will be added under the assumption that contracts are schema-shaped. Every non-trivial check will cite which shape(s) it operates on.
- Shape-specific stub packages are expected to multiply. The `@suss/stub-*` naming pattern is explicit about this.
- Metadata namespacing under `metadata.<domain>.<shape>.*` becomes the rule, not the exception.
- The five-shape taxonomy is the working vocabulary. When a real artifact doesn't fit, we update the taxonomy rather than force it.
- Future contract-related design docs cite epistemic character explicitly when discussing checker behavior.

## What this doc does *not* commit us to

- Reading every shape in every domain. Pragmatic coverage first; comprehensive later.
- A universal cross-shape comparison framework. The interesting comparisons are domain-specific (an HTTP OpenAPI ⊕ Pact combination doesn't look the same as a React Storybook ⊕ Figma combination). We generalize bottom-up.
- A fixed finding taxonomy. `contractDisagreement` was added when cross-source HTTP contracts landed; additional kinds will follow as domains demand them.
