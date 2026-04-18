# suss

Static behavioral analysis for TypeScript. Given a function, suss answers: *under what conditions does this produce what outputs?*

```
suss extract -p tsconfig.json -f ts-rest -o summaries.json
suss inspect summaries.json
```

## What it does

suss reads your source code and produces **behavioral summaries** — structured, language-agnostic descriptions of every execution path through a handler or client function:

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

The JSON output (`suss extract`) is a machine-readable format designed for consumption by other tools. The human output (`suss inspect`) is what you see above. Both describe the same thing: every behavioral path through the code.

## How a behavioral summary is different from a spec

| Tool | Describes | What's missing |
|---|---|---|
| **OpenAPI / JSON Schema** | Request and response *shapes* | The conditions under which each shape is produced |
| **Pact / contract testing** | Concrete request/response *examples* | Coverage — the example set is always incomplete |
| **TypeScript types** | The structural type of return values | Which values fire which paths, and where body fields originate |
| **Behavioral summary** | *(conditions → outputs)* for every execution path | Nothing the code doesn't already determine |

A spec says "the response has a `status` field that's a string." A behavioral summary says "the response's `status` field is `"deleted"` when `user.deletedAt` is truthy, and `user` came from `db.findById(params.id)`." The first lets you check shape; the second lets you check that a consumer's assumptions about what a `200` *means* still hold.

A summary doesn't replace specs — they coexist. `suss extract` produces summaries from source code; `suss stub` produces summaries from specs (OpenAPI), manifests (CloudFormation/SAM), or vendor docs (the API Gateway resource-semantics layer at `@suss/stub-aws-apigateway`). Both feed the same `BehavioralSummary[]` shape. See [`docs/stubs.md`](docs/stubs.md).

## What's modeled today

**HTTP boundaries** are the shipped surface. Provider-side framework packs: ts-rest, React Router, Express, Fastify. Consumer-side runtime packs: `fetch`, axios, ts-rest's `initClient`. Stubs: OpenAPI 3.x, AWS API Gateway (REST + HTTP API) via CloudFormation/SAM templates with full configuration-driven behavior (authorizers, throttling, request validation, CORS preflight, integration timeouts).

**The IR is protocol-agnostic.** `CodeUnitKind` already includes `consumer` (message queues), `worker`, `loader`, `action`, `component`, `hook`, `middleware`, `resolver`. The framework-pack and stub interfaces don't assume HTTP. GraphQL operations, gRPC methods, message-queue topics (Kafka, SQS, SNS, EventBridge), React component contracts, and other boundary types are in-scope as additional packs and stubs — they're follow-on work, not architectural changes. See [`docs/status.md`](docs/status.md) for the capability matrix and what's deferred.

## What you can do with summaries

**Cross-boundary checking.** `suss check` compares a provider's behavioral summary against a consumer's. It catches statuses the consumer doesn't handle, dead consumer branches, contract violations, body-field mismatches, and cases where the provider distinguishes sub-cases that the consumer collapses.

```
suss check provider.json consumer.json
suss check --dir summaries/           # auto-pairs by method + path
```

**Understand unfamiliar code.** `suss inspect` shows what a handler does without reading the source. Useful for code review, onboarding, and architecture discussions.

**Publish behavioral contracts.** Summaries are portable — paths are relative, the format is [versioned and documented](docs/behavioral-summary-format.md). Library authors can publish summaries alongside their packages so consumers get cross-boundary checking without the source code.

**Check against contracts you don't own.** `suss stub --from openapi` turns an OpenAPI 3.x specification into the same `BehavioralSummary[]` shape, so you can check your TS consumer against a third-party API (Stripe, an AWS service, an internal team's gateway) whose handlers you can't extract from source.

**Build downstream tools.** The summary format is a foundation: documentation generators, AI context providers, test case enumerators, impact analyzers, architectural dashboards. Install `@suss/behavioral-ir` (one peer dep on `zod`) to consume the format with runtime validation. Non-TS consumers can validate against the published [JSON Schema](packages/ir/schema/behavioral-summary.schema.json) generated from the same source. See the [format spec](docs/behavioral-summary-format.md) for the consumption guide.

## Packages

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/behavioral-ir`](packages/ir) | zod schemas, types, parsers, and generated [JSON Schema](packages/ir/schema/behavioral-summary.schema.json). Install this to consume summaries. | ![](.github/badges/coverage-ir.svg) |
| [`@suss/extractor`](packages/extractor) | Assembly engine. Converts raw extracted structure into `BehavioralSummary`. | ![](.github/badges/coverage-extractor.svg) |
| [`@suss/adapter-typescript`](packages/adapter/typescript) | TypeScript language adapter via ts-morph. | ![](.github/badges/coverage-typescript.svg) |
| [`@suss/framework-ts-rest`](packages/framework/ts-rest) | Pattern pack for ts-rest. | ![](.github/badges/coverage-ts-rest.svg) |
| [`@suss/framework-react-router`](packages/framework/react-router) | Pattern pack for React Router loaders/actions/components. | ![](.github/badges/coverage-react-router.svg) |
| [`@suss/framework-express`](packages/framework/express) | Pattern pack for Express handlers. | ![](.github/badges/coverage-express.svg) |
| [`@suss/framework-fastify`](packages/framework/fastify) | Pattern pack for Fastify handlers. | ![](.github/badges/coverage-fastify.svg) |
| [`@suss/runtime-web`](packages/runtime/web) | Runtime pack for `fetch` call sites. | ![](.github/badges/coverage-web.svg) |
| [`@suss/runtime-axios`](packages/runtime/axios) | Runtime pack for axios call sites. | ![](.github/badges/coverage-axios.svg) |
| [`@suss/stub-openapi`](packages/stub/openapi) | Stub generator: OpenAPI 3.x → behavioral summaries. | ![](.github/badges/coverage-stub-openapi.svg) |
| [`@suss/stub-aws-apigateway`](packages/stub/aws-apigateway) | API Gateway resource semantics — normalized REST/HTTP API configs → behavioral summaries with platform-injected transitions. | ![](.github/badges/coverage-stub-aws-apigateway.svg) |
| [`@suss/stub-cloudformation`](packages/stub/cloudformation) | Stub generator: AWS CloudFormation / SAM templates → behavioral summaries (delegates to stub-openapi + stub-aws-apigateway). | ![](.github/badges/coverage-stub-cloudformation.svg) |
| [`@suss/checker`](packages/checker) | Pairwise cross-boundary checker. | ![](.github/badges/coverage-checker.svg) |
| [`@suss/cli`](packages/cli) | CLI wrapper. | ![](.github/badges/coverage-cli.svg) |

## A complete example

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) is a runnable end-to-end demo: a small TypeScript axios consumer of the Petstore API, paired against the Petstore OpenAPI spec via `suss stub`. `make all` runs the full pipeline (extract → stub → check) and produces real findings — unhandled status codes plus consumer reads of fields the provider declares optional.

## Docs

- [`docs/behavioral-summary-format.md`](docs/behavioral-summary-format.md) — the summary format spec, JSON Schema, publishing convention, what you can build on this
- [`docs/motivation.md`](docs/motivation.md) — the problem, why existing tools don't catch it, prior art, design principles
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together, the vocabulary (with examples), package dependency rules
- [`docs/pipelines.md`](docs/pipelines.md) — sequence diagrams for each CLI action (`extract`, `inspect`, `check`, `stub`) plus the internal assembly and pairing flows
- [`docs/extraction-algorithm.md`](docs/extraction-algorithm.md) — the four extraction functions, pseudocode, edge cases, testing strategy
- [`docs/ir-reference.md`](docs/ir-reference.md) — type-by-type walkthrough of `@suss/behavioral-ir`
- [`docs/framework-packs.md`](docs/framework-packs.md) — how to write or modify a pattern pack, pattern reference, worked Fastify example
- [`docs/cross-boundary-checking.md`](docs/cross-boundary-checking.md) — the pairwise checker: provider coverage, consumer satisfaction, contract consistency
- [`docs/stubs.md`](docs/stubs.md) — boundary contracts authored from non-source-code inputs (specs, manifests, vendor docs); reader/semantics layering; conventions for platform-injected transitions
- [`docs/boundary-semantics.md`](docs/boundary-semantics.md) — design-only: the layered transport / semantics / recognition model, the `BoundarySemantics` refactor deferred until a second concrete protocol lands, and why GraphQL is the forcing function
- [`docs/status.md`](docs/status.md) — phase-by-phase progress tracker, test counts, decisions log
- [`docs/style.md`](docs/style.md) — code conventions (Biome, TypeScript, tests, monorepo)

## Status

Stable surface: the [behavioral summary format](docs/behavioral-summary-format.md), the IR types in `@suss/behavioral-ir`, the extraction pipeline, and the cross-boundary checker. Pattern packs ship today for **ts-rest**, **React Router**, **Express**, **Fastify**, **fetch**, and **axios**. See [`docs/status.md`](docs/status.md) for the full capability matrix.

## License

This project is licensed under the [Apache 2.0 License](LICENSE).
