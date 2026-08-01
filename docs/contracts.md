# Contracts

"Contract" is the most overloaded word in suss. This is its one home. Three questions get answered here: what kinds of *truth* an artifact about code can carry, what three contracts sit at every boundary, and what artifact *shapes* those contracts take. The checker's finding semantics fall out of the first.

Related: [`cross-boundary-checking.md`](cross-boundary-checking.md) (the checker mechanics that consume this framing), [`contract-sources.md`](contract-sources.md) (the readers that produce contract-derived summaries), [`boundary-semantics.md`](boundary-semantics.md) (how boundaries themselves vary).

## Three kinds of truth

A distinction that shapes everything downstream: artifacts about code have different *epistemic characters*, different kinds of truth.

| Character | Answers | Examples | Completeness |
|---|---|---|---|
| **Specification** | *what should happen* | OpenAPI, TypeScript interfaces, Storybook stories, Prisma schemas, CloudFormation templates | Under-specified, declares what's allowed, rarely when each case fires |
| **Observation** | *what did happen, once* | Snapshots, Pact recordings, Playwright tests, production logs | Point-samples, covers only what was tested |
| **Derivation** | *what the code does, across all paths* | A suss `BehavioralSummary` | Complete over paths; limited by analyzer fidelity |

The `BehavioralSummary` is the only artifact suss produces itself, and it's the derivation column. Everything else, every declared contract, every contract source, is a specification or an observation that suss reads and compares against derivation.

Interesting findings are cross-character:

- **Derivation ⊄ Specification** → code has a path the spec doesn't declare ("handler produces a 500 that OpenAPI doesn't mention").
- **Specification ⊄ Derivation** → spec declares a case code can't reach ("OpenAPI declares 404 but no handler branch produces it").
- **Observation ⊄ Derivation** → something happened the code shouldn't be able to produce (rare, high-signal, usually a bug).
- **Derivation ⊄ Observation** → code reaches paths no test covered (coverage signal, not a finding per se).

Each pair has its own severity and its own owner. Severity follows epistemic character, not the source format, see [Severity follows character](#severity-follows-character) below.

## The three contracts at a boundary

Every API boundary has three behavioral contracts, whether anyone writes them down or not. The checker's job is to compare them pairwise; each comparison catches a different class of failure. (The mechanics, which checker function fires for which comparison, live in [`cross-boundary-checking.md`](cross-boundary-checking.md).)

### 1. The declared contract (authored, optional)

ts-rest `responses`, OpenAPI schema, GraphQL SDL. Says what statuses and shapes are *supposed* to exist. This is a **specification**. It's what most tools check against. Authored by a human, so it can be wrong, incomplete, or out of date, but when it exists, it's the shared source of truth between provider and consumer teams.

### 2. The provider's inferred contract (a derivation)

The actual set of transitions the provider produces: under condition A, output X; under condition B, output Y. Richer than the declared contract because it captures:

- **Sub-cases within a status code.** A declared contract says "200 returns User." The derivation says "200 returns `{ ...user }` when `!user.deletedAt`, and `{ ...user, status: "deleted" }` when `user.deletedAt`", two behavioral cases the declaration collapses into one.
- **Body shape variation per condition.** Each transition has its own `Output.body` shape.
- **Gaps.** The declared contract says 500 is possible; the implementation never produces it. Or the implementation returns 418, which the contract doesn't declare.

### 3. The consumer's inferred contract (a derivation)

What the consumer actually *depends on*: which status codes it branches on, which body fields it reads, what conditions it tests on the response. This contract is never explicitly written down, not in OpenAPI, not in types, not in a Pact test unless someone thinks to write the exact example. It's the invisible contract that causes production incidents when violated. suss derives it from the consumer's source:

- Status branching: `if (result.status === 404)` → consumer expects status 404 as a case.
- Field access: `result.body.name`, `result.body.email` → consumer depends on these fields existing.
- Response conditions: `if (result.body.status === "deleted")` → consumer distinguishes a sub-case by testing a response field.

## Contract shapes

The three contracts above are HTTP-flavoured. Across domains, contracts show up in more artifact shapes than "schema." Any substantive domain tends to use several. Each shape maps to one of the three epistemic characters.

### 1. Schema: "what types flow across?"

Structural declarations of the interface: types, cardinality, required-ness, enumerated values.

- OpenAPI 3.x, ts-rest `responses`, CFN `MethodResponses`, GraphQL SDL (partly)
- Prisma schemas, TypeScript interfaces for props
- Message schemas (Avro, Protobuf, JSON Schema), database DDL

**Character:** specification. Declares what's *allowed* to cross. Says nothing about *when* each case fires.

### 2. Examples: "what's one concrete instance of a valid interaction?"

Recorded concrete pairs of input/output or request/response: Pact contracts, HAR captures, fixture files, API docs with curl examples.

**Character:** observation. Captures what happened *once*. Point-samples of a larger space; coverage is as good as the example set, never better.

### 3. Tests: "what should be true when X happens?"

Behavioral assertions, usually interaction sequences: Playwright / Cypress specs, RTL component tests, supertest integration tests.

**Character:** observation of asserted behavior under specific inputs. Same coverage limit as Examples, tested cases only.

### 4. Snapshots: "what did the output look like?"

Serialized captures of output for specific inputs: Jest / Vitest `.snap` files, visual-regression baselines, golden query results.

**Character:** observation plus regression anchor. "This output is what we agreed to yesterday; alert on change." Structural-only, tested inputs only.

### 5. Design: "what should this look like / do, by intent?"

Design-source-of-truth artifacts upstream of code: Figma / Sketch files, design tokens, prototypes, accessibility specifications.

**Character:** intent. Declares what the output *should* be independent of whether any code exists. Visual / interactive axis only, typically, business logic is invisible in design files.

## How suss absorbs contracts today

Two of the five shapes, **schema** and **spec**, ship today across HTTP, GraphQL, AppSync, message-bus, storage-relational, and component domains. `suss contract --from <source>` takes seven values, from six reader packages:

- `@suss/contract-openapi`, OpenAPI 3.x (schema, HTTP)
- `@suss/contract-cloudformation`, CFN / SAM templates with API Gateway resources (schema, HTTP), built on the internal `@suss/contract-aws-apigateway` shared library
- `@suss/contract-appsync`, CFN templates with `AWS::AppSync::*` resources and the SAM `AWS::Serverless::GraphQLApi` shorthand (schema, GraphQL)
- `@suss/contract-graphql`: plain GraphQL SDL files (schema, GraphQL), plus committed `.graphql`/`.gql` operation documents via `--from graphql-documents` (spec, GraphQL): each query/mutation/subscription becomes a client-kind summary that pairs against resolver summaries without any call-site tracing
- `@suss/contract-prisma`, `schema.prisma` files (schema, storage-relational)
- `@suss/contract-storybook`, CSF3 `.stories.tsx` files (spec, component domain)

Framework packs also derive contract declarations directly from source: ts-rest's `responses`, Apollo / NestJS GraphQL `typeDefs`, and ts-rest-zod schemas all populate per-protocol contract metadata at extraction time.

Comparison checkers in `@suss/checker` operate per-protocol, HTTP schema vs. derived transitions, GraphQL contract agreement, message-bus producer/consumer pairing, storage-access vs. Prisma schema, env-var config, Storybook stories vs. the React component. The mechanics are in [`cross-boundary-checking.md`](cross-boundary-checking.md).

What's still missing from the taxonomy:

- **Observation shapes.** No reader ingests Jest snapshots, Playwright traces, or production observability data yet. The IR shape that would carry them (`confidence.source: "observation"`) exists; the reader pipeline doesn't.
- **Test shapes.** Same gap, RSpec / supertest / RTL assertions aren't yet a source.
- **Design shapes.** Figma / design-token integration is deliberately deferred, design files rarely live in the repo, and the API integration is expensive relative to the signal. The taxonomy keeps design listed because its epistemic character (intent) is distinct; the artifact pipeline isn't planned.

## Intent

Intent is partially shipped and is its own artifact stream, distinct from the schema/spec contract sources above.

Team-authored intent specs (`*.intent` / `*.prd`, read by `@suss/contract-intent`) parse to `IntentSummary`, not `BehavioralSummary`, and `@suss/checker-intent` pairs them against derived code (`suss check --dir summaries/ --intent intent/`). Two kinds:

- **System intent** (`*.intent`), the contract a boundary should satisfy, structural and machine-comparable ("`POST /auth/login` returns 429 with `{ error, retryAfter }`").
- **Outcome intent** (`*.prd`), what should happen for the user, scenario-shaped ("a rate-limited request gets a friendly rejection"), with scenarios that optionally link to system-intent outcomes.

Third-party schemas (OpenAPI, GraphQL SDL, Prisma) carry *some* intent, but they were authored as wire contracts and data-model definitions, not as team intent. That difference is why intent docs are **open** specifications: they declare what *must* exist (the floor), not a closed enumeration. Code that exceeds intent is possibly-missing intent, reported as info, not a violation. Boundary-level intent checks ship today; PRD scenario coverage ships alongside.

## Severity follows character

Severity is assigned from epistemic character, not from which source format produced the contract:

- Derivation violates a Specification → `error` (code has drifted from what it promised).
- Observation violates a Specification → `warning` (something happened the spec said couldn't).
- Observation absent for a Specification case → `info` (coverage gap, not a bug).
- Two Specifications disagree → `warning` (reconcile needed; the existing `contractDisagreement` finding).

The same rule assigns intent-finding severities: a derivation violating declared system intent is an error; a derivation *exceeding* open intent is info. These heuristics refine as more shapes ship; not all combinations are meaningful, and not all need the same severity.

## Metadata namespacing

Declarations live under the protocol they describe, regardless of which artifact pipeline produced them. A GraphQL contract derived from an SDL file and one derived from Apollo's `typeDefs` populate the same `metadata.graphql.declaredContract`, so the checker doesn't care about the source. Namespaces in use:

- `metadata.http.*`: declaredContract, statusAccessors, bodyAccessors, statusRange
- `metadata.graphql.*`: declaredContract, document, schemaSdl
- `metadata.appsync.*`: kind (UNIT vs PIPELINE)
- `metadata.storybook.*` / `metadata.component.*`, story-level and component-context metadata

New protocols add their own `metadata.<protocol>.*` namespace rather than nesting by source. The checker reads the namespace it understands; downstream tooling ignores what it doesn't.

## How new domains get added

Adding a domain (React, Postgres, Kafka) is four questions:

1. **What's the boundary?** Component ↔ DOM; code ↔ database; producer ↔ queue.
2. **What's the observable channel?** DOM tree + events; SQL query + result set; message envelope.
3. **What contract shapes exist in this domain?** List them from the five above; assess which are common and which are gaps.
4. **Which shapes feed a meaningful check against which other shapes?** Not all combinations are useful; designed per-domain.

For each domain, suss ships an extractor (pattern pack + adapter support), one or more contract-source readers covering the dominant shapes, and the checker extensions for the meaningful cross-shape checks. Shipping all three in one go isn't required.

## What this doc commits us to

- No checker logic assumes contracts are schema-shaped. Every check cites which shape(s) it operates on.
- The `@suss/contract-*` naming stays as the surface for new readers; one package per source.
- Metadata namespacing follows the protocol-first convention (`metadata.<protocol>.*`).
- The five-shape taxonomy is the working vocabulary. When a concrete artifact doesn't fit, the taxonomy is updated rather than the artifact forced into a slot.
- The interesting cross-shape comparisons are protocol-specific; generalisation is bottom-up, not a universal framework designed upfront.
