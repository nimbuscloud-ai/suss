# suss

suss catches behavioral drift between what your TypeScript code says it does and what it does. The bugs it surfaces are the ones that compile cleanly, type-check, and pass their tests — code where a consumer reads a `200` whose shape the provider quietly changed, or a Prisma write touches a column the schema doesn't declare. The bug shows up at runtime; nothing in CI today catches it.

Mechanically, suss is static behavioral analysis: it derives what every function does on every execution path and pairs those derivations across boundaries — the points where two units of code meet, like the consumer and provider above, or the Prisma call and its schema. The drift falls out of the comparison without runtime instrumentation and without you having to write specs.

```
suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json
suss check summaries/
```

## What suss produces

For every function reachable from a recognized entry point — HTTP handlers, React components, GraphQL resolvers, queue consumers, client call sites, transitively-called helpers — suss emits a `BehavioralSummary`: a JSON object describing the function's transitions (one per execution path), the predicates that gate each transition, the outputs each transition produces, and the side effects on the way (HTTP calls, storage reads/writes, message sends, env-var reads, throws).

```
GET /users/:id
  ts-rest handler | handlers.ts:24
  Contract: 200, 404, 500

    -> 404 { error }  when  !params.id
    -> 404 { error }  when  params.id && !db.findById()
    -> 404 { error }  when  params.id && db.findById() && db.findById().deletedAt
    -> 200 { id, name, email }  (default)

    !! Declared response 500 is never produced by the handler
```

That's `suss inspect` rendering one summary. The same data as JSON is what `@suss/checker` and any downstream tool consumes.

The summary is the product. Checking is the most-developed use; others include reading what code does without reading source, generating documentation, enumerating test cases, feeding AI agents structured context, and tracking boundary drift across releases.

## How suss gets data into and out of the IR

Four CLI surfaces over the same `BehavioralSummary[]`:

- `suss extract` — derive summaries from TypeScript source.
- `suss contract` — derive summaries from declared contracts (OpenAPI, CloudFormation, AppSync, Storybook).
- `suss check` — pair providers with consumers and emit findings where they disagree.
- `suss inspect` — render summaries as readable text, or `--diff BEFORE AFTER` to see what a change added, removed, or altered.

`extract` and `contract` both produce the same shape, so a TypeScript handler and an OpenAPI spec for that handler are directly comparable. The same goes for a CloudFormation template and the Lambda code it deploys, or a Storybook CSF3 file and the React component it documents.

## What's modeled today

| Boundary kind | Frameworks | Clients | Contracts |
|---|---|---|---|
| HTTP | ts-rest, Express, Fastify, NestJS REST | fetch, axios | OpenAPI 3.x, AWS API Gateway (REST + HTTP API), AWS SAM |
| GraphQL | Apollo Server, NestJS GraphQL | Apollo Client | AWS AppSync |
| React | React (components + handlers + `useEffect`), React Router (loaders + actions) | — | Storybook CSF3 |
| Storage | Prisma (read / write / selector / fields) | — | Prisma schema |
| Message bus | AWS SQS (producer) | — | CloudFormation event-source mappings |
| Runtime config | `process.env` access | — | CloudFormation `Environment` blocks |

Each row is an additive pack. Adding a framework is one pack file (~100–300 lines of declarative `PatternPack` configuration); adding a contract source is one reader. The IR is protocol-agnostic, so new boundary kinds (gRPC, Kafka, EventBridge, hand-authored interface specs) slot in without architectural change.

## Three kinds of truth

A distinction that shapes everything: artifacts about code have different *epistemic characters*.

| Character | Answers | Examples | Completeness |
|---|---|---|---|
| **Specification** | *what should happen* | OpenAPI, TypeScript interfaces, Storybook stories, Prisma schemas, CloudFormation templates | Under-specified — declares what's allowed, rarely when each case fires |
| **Observation** | *what did happen, once* | Snapshots, Pact recordings, Playwright tests, production logs | Point-samples — covers only what was tested |
| **Derivation** | *what the code does, across all paths* | A suss `BehavioralSummary` | Complete over paths; limited by analyzer fidelity |

Interesting findings are cross-character: a derivation has a path no specification declares; a specification declares a case no derivation can reach; an observation shows something derivation says can't happen. Each pair has its own severity and its own owner.

See [`docs/contracts.md`](docs/contracts.md) for the full taxonomy and how it grounds the checker's finding semantics.

## Usage

### Install

suss ships as `@suss/cli` plus opt-in packs for the frameworks, runtimes, and contract sources you use:

```bash
npm install --save-dev \
  @suss/cli \
  @suss/framework-ts-rest \
  @suss/runtime-axios
```

You don't have to install everything. Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client through the contract).
- **Express + fetch:** `@suss/framework-express @suss/runtime-web`.
- **React + GraphQL:** `@suss/framework-react @suss/runtime-apollo-client`.
- **Lambda + SQS:** `@suss/framework-aws-sqs @suss/contract-cloudformation @suss/framework-process-env`.
- **App backed by Postgres:** add `@suss/framework-prisma @suss/contract-prisma` to any of the above.

The full pack list is in the [Packages](#packages) table. The [add-to-project guide](docs/guides/add-to-project.md) walks the integration end-to-end.

### Extract summaries from source

```bash
# Provider side: extract handlers using the ts-rest pack
suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json

# Consumer side: extract axios call sites
suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json
```

`-f` may be repeated: `-f ts-rest -f axios` runs both packs in one pass. Output is a JSON array of `BehavioralSummary` objects.

### Pair providers against consumers

```bash
suss check summaries/provider.json summaries/consumer.json
```

Emits findings — unhandled statuses, dead consumer branches, body-field mismatches, dead-promise contract violations, message-bus producer/consumer pairing gaps, storage-column read/write mismatches, env-var configuration drift. Exit code is non-zero when any `error`-severity finding exists; tune with `--fail-on error|warning|info|none`.

Whole-directory mode pairs every summary against every other by boundary key (e.g. `(GET, /users/:id)`):

```bash
suss check --dir summaries/
suss check --dir summaries/ --fail-on warning --json > findings.json
```

### Inspect a summary file

```bash
suss inspect summaries/provider.json                       # human-readable view
suss inspect --diff before.json after.json                 # diff two points in time
suss inspect --dir summaries/                              # boundary-pair overview
```

### Generate summaries from declared contracts

`suss contract` runs a contract reader over a non-source artifact and produces summaries in the same shape as `extract`:

```bash
# OpenAPI 3.x (3.0 and 3.1)
suss contract --from openapi -i openapi.yaml -o summaries/stripe-provider.json

# AWS CloudFormation / SAM (handles inline OpenAPI bodies, native REST/HTTP API
# resources, SAM Events blocks, SQS event-source mappings, Lambda Environment)
suss contract --from cloudformation -i template.yaml -o summaries/api-provider.json

# AppSync GraphQL schema + resolver mapping
suss contract --from appsync -i template.yaml -o summaries/graphql-provider.json

# Storybook CSF3 stories
suss contract --from storybook -p tsconfig.json -o summaries/stories.json
```

Contract-derived summaries carry `confidence.source: "contract"` and pair with extracted consumers exactly like source-extracted provider summaries. (The `@suss/contract-*` packages were called `@suss/stub-*` in earlier versions; see [docs/contract-sources.md](docs/contract-sources.md) for the rename.)

### Suppress accepted findings

Create `.sussignore.yml` at the project root:

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: "GET /pet/{petId}"
    consumer:
      transitionId: ct-500
    reason: Upstream returns 500 only in force-majeure handled by retry middleware.
    effect: mark  # mark | downgrade | hide — default "mark"
```

`mark` keeps the finding visible but excludes it from exit code; `downgrade` drops severity a level; `hide` removes it entirely. `reason` is required. See [`docs/suppressions.md`](docs/suppressions.md) for the full format.

### Use in CI

```yaml
# .github/workflows/contracts.yml
- name: Extract
  run: npx suss extract -p tsconfig.json -f ts-rest -f axios -o summaries.json
- name: Contracts from third-party APIs
  run: npx suss contract --from openapi -i vendor/stripe.yaml -o stripe.json
- name: Check
  run: npx suss check --dir . --fail-on warning
```

The CLI exits non-zero when findings cross the `--fail-on` threshold, so standard CI gating works without extra plumbing. `--json` output is stable for downstream tools (dashboards, PR comment bots, metric collectors).

### Programmatic API

```typescript
import { parseSummaries } from "@suss/behavioral-ir";
import { checkAll, applySuppressions } from "@suss/checker";

const summaries = parseSummaries(JSON.parse(readFileSync("summaries.json", "utf8")));
const { findings } = checkAll(summaries);
const effective = applySuppressions(findings, mySuppressions);
```

## Packages

| Package | Description |
|---------|-------------|
| [`@suss/behavioral-ir`](packages/ir) | zod schemas, types, parsers, and generated [JSON Schema](packages/ir/schema/behavioral-summary.schema.json). Install this to consume summaries. |
| [`@suss/extractor`](packages/extractor) | Assembly engine. Converts raw extracted structure into `BehavioralSummary`. |
| [`@suss/adapter-typescript`](packages/adapter/typescript) | TypeScript language adapter via ts-morph. |
| [`@suss/checker`](packages/checker) | Pairwise cross-boundary checker. |
| [`@suss/cli`](packages/cli) | CLI wrapper. |
| **Frameworks** | |
| [`@suss/framework-ts-rest`](packages/framework/ts-rest) | ts-rest providers + clients (contract-backed). |
| [`@suss/framework-express`](packages/framework/express) | Express handlers. |
| [`@suss/framework-fastify`](packages/framework/fastify) | Fastify handlers. |
| [`@suss/framework-react`](packages/framework/react) | React function components, event handlers, `useEffect` bodies. |
| [`@suss/framework-react-router`](packages/framework/react-router) | React Router loaders / actions / routes. |
| [`@suss/framework-apollo`](packages/framework/apollo) | Apollo Server resolvers (code-first). |
| [`@suss/framework-nestjs-rest`](packages/framework/nestjs-rest) | NestJS REST controllers. |
| [`@suss/framework-nestjs-graphql`](packages/framework/nestjs-graphql) | NestJS GraphQL resolvers. |
| [`@suss/framework-prisma`](packages/framework/prisma) | Prisma client calls — emits storage-access interactions per read / write. |
| [`@suss/framework-aws-sqs`](packages/framework/aws-sqs) | AWS SDK v3 SQS producer calls — emits message-send interactions. |
| [`@suss/framework-process-env`](packages/framework/process-env) | `process.env.X` access — emits config-read interactions. |
| **Runtimes (client packs)** | |
| [`@suss/runtime-web`](packages/runtime/web) | Global `fetch` call sites. |
| [`@suss/runtime-axios`](packages/runtime/axios) | axios call sites + `axios.create` factories. |
| [`@suss/runtime-apollo-client`](packages/runtime/apollo-client) | `@apollo/client` hooks + imperative `client.query`. |
| **Contract sources** | |
| [`@suss/contract-openapi`](packages/contract/openapi) | OpenAPI 3.x → behavioral summaries. |
| [`@suss/contract-aws-apigateway`](packages/contract/aws-apigateway) | API Gateway resource semantics — REST/HTTP API configs → summaries with platform-injected transitions. |
| [`@suss/contract-cloudformation`](packages/contract/cloudformation) | CloudFormation / SAM templates → summaries (delegates to contract-openapi + contract-aws-apigateway; also handles SQS event-source mappings + Lambda Environment). |
| [`@suss/contract-appsync`](packages/contract/appsync) | AppSync GraphQL schema + resolver mapping templates. |
| [`@suss/contract-storybook`](packages/contract/storybook) | Storybook CSF3 stories → component contract summaries. |
| [`@suss/contract-prisma`](packages/contract/prisma) | Prisma schema → storage provider summaries. |

## A complete example

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) is a runnable end-to-end demo: a small TypeScript axios consumer of the Petstore API, paired against the Petstore OpenAPI spec via `suss contract`. `make all` runs the full pipeline (extract → contract → check) and produces actionable findings — unhandled status codes plus consumer reads of fields the provider declares optional.

## Docs

- [`docs/behavioral-summary-format.md`](docs/behavioral-summary-format.md) — the summary format spec, JSON Schema, publishing convention, what you can build on this
- [`docs/motivation.md`](docs/motivation.md) — the problem, why existing tools don't catch it, prior art, design principles
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together, the vocabulary (with examples), package dependency rules
- [`docs/pipelines.md`](docs/pipelines.md) — sequence diagrams for each CLI action plus the internal assembly and pairing flows
- [`docs/extraction-algorithm.md`](docs/extraction-algorithm.md) — the four extraction functions, pseudocode, edge cases
- [`docs/ir-reference.md`](docs/ir-reference.md) — type-by-type walkthrough of `@suss/behavioral-ir`
- [`docs/framework-packs.md`](docs/framework-packs.md) — how to write or modify a pattern pack
- [`docs/cross-boundary-checking.md`](docs/cross-boundary-checking.md) — the pairwise checker: provider coverage, consumer satisfaction, contract consistency
- [`docs/suppressions.md`](docs/suppressions.md) — `.sussignore` file format
- [`docs/contract-sources.md`](docs/contract-sources.md) — non-source-code contracts (specs, manifests, vendor docs); reader/semantics layering
- [`docs/contracts.md`](docs/contracts.md) — the five contract shapes and their epistemic characters
- [`docs/boundary-semantics.md`](docs/boundary-semantics.md) — the layered transport / semantics / recognition model
- [`docs/internal/status.md`](docs/internal/status.md) — capability matrix, decisions log

## Status

The behavioral summary format and the IR types in `@suss/behavioral-ir` are stable. The extraction pipeline and the cross-boundary checker are in active development against a growing set of packs. Shipped recognition: ts-rest, React Router, Express, Fastify, Apollo Server, NestJS REST + GraphQL, React (components + handlers + effects), fetch, axios, Apollo Client, Prisma, AWS SQS producers, `process.env`. Shipped contract sources: OpenAPI 3.x, AWS API Gateway, CloudFormation / SAM, AppSync, Storybook CSF3, Prisma schema.

## License

This project is licensed under the [Apache 2.0 License](LICENSE).
