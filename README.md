# suss

Static behavioral analysis for TypeScript. For every code unit at a boundary — HTTP handler, React component, event handler, client call site, queue consumer — suss answers: *under what conditions does it produce what outputs?*

```
suss extract -p tsconfig.json -f ts-rest -o summaries.json
suss inspect summaries.json
```

## The idea

Most tools describe what your code *should* do — specs, types, design docs. Some describe what your code *did* do — tests, snapshots, traces. Neither describes what your code *does*: every path, every branch, every output, across the whole surface where your code meets the outside world.

suss fills that gap. It reads your source and produces **behavioral summaries** — structured descriptions of every execution path through every code unit at a boundary. The summary is the primary artifact, and it's useful in three directions:

- **As documentation.** "What does this thing actually do?" reduces to reading a JSON file (or `suss inspect`, which renders it human-readably). Useful for code review, onboarding, impact analysis, architecture discussions — anywhere people need an accurate, current picture of behavior without reading 2,000 lines of source.
- **To compare against intent.** Every spec you've written (OpenAPI, TypeScript types, Storybook stories, Prisma schemas, CloudFormation templates) asserts what *should* happen. `suss check` surfaces where code and intent disagree — with semantics that reflect what each kind of artifact actually claims.
- **To compare against observations.** Every test, snapshot, and recording captures what *did* happen, once. The summary enumerates every path, so the suite's coverage — and its blind spots — becomes visible.

The summary is the product. Checking is one thing you can do with it; others include generating docs, feeding AI context providers, enumerating test cases, and tracking boundary drift across releases. suss is a behavioral-understanding platform, not a linter.

## Three kinds of truth

A distinction that shapes everything: artifacts about code have different *epistemic characters*. Conflating them is the most common source of confusion when people ask "is this tool a spec? a test? documentation?"

| Character | Answers | Examples | Completeness |
|---|---|---|---|
| **Specification** | *what should happen* | OpenAPI, TypeScript interfaces, Storybook stories, Prisma schemas | Under-specified — declares what's allowed, rarely when each case fires |
| **Observation** | *what did happen, once* | Snapshots, Pact recordings, Playwright tests, production logs | Point-samples — covers only what was tested |
| **Derivation** | *what the code does, across all paths* | A suss `BehavioralSummary` | Complete over paths; limited by analyzer fidelity |

Interesting findings are *cross-character*: derivation has a path no specification declares (drift from intent); a specification declares a case no derivation can reach (dead promise); an observation shows something derivation says can't happen (analyzer gap or genuine bug). Each pair has its own severity and its own owner.

See [`docs/contracts.md`](docs/contracts.md) for the full taxonomy and how it grounds the checker's finding semantics.

## What a summary looks like

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

That's `suss inspect` on a ts-rest handler. The same summary as JSON is what `@suss/checker` and downstream tools consume. `suss extract` produces summaries from source code; `suss stub` produces summaries from specs (OpenAPI), manifests (CloudFormation/SAM), and vendor docs — both feed the same `BehavioralSummary[]` shape, so you can reason across hand-written handlers and third-party APIs (Stripe, AWS services, internal gateways) uniformly.

## What's modeled today

**HTTP boundaries** — the shipped surface. Framework packs: ts-rest, React Router, Express, Fastify. Client packs: `fetch`, axios, ts-rest's `initClient`. Stubs: OpenAPI 3.x, AWS API Gateway (REST + HTTP API) via CloudFormation/SAM with full configuration-driven behavior (authorizers, throttling, request validation, CORS preflight, integration timeouts).

**React components** — in progress. Each component yields one `component`-kind summary for its render body plus one `handler`-kind summary per locally-authored event handler. Inline JSX conditionals, `useEffect` bodies as separate code units, Storybook as a stub source, and cross-shape contract agreement (inferred vs Storybook vs snapshots vs Playwright) are on the roadmap. See [`docs/roadmap-react.md`](docs/roadmap-react.md).

**The IR is protocol-agnostic.** `CodeUnitKind` covers handler, loader, action, middleware, resolver, component, hook, consumer (message queues), worker, and client. Framework packs and stubs don't assume HTTP. GraphQL operations, gRPC methods, queue topics (Kafka, SQS, SNS, EventBridge), database-schema boundaries, and other domains are additive packs and stubs — follow-on work, not architectural change. See [`docs/status.md`](docs/status.md) for the capability matrix.

## What you can do with summaries

**Understand unfamiliar code.** `suss inspect` shows what a code unit does — across every path — without having to read the source. Code review, onboarding, architecture conversations, PR comments all get a current, source-faithful artifact to anchor on.

**Check against declared intent.** `suss check` pairs providers with consumers and surfaces drift: statuses the consumer doesn't handle, dead consumer branches, body-field mismatches, declared responses the code never produces, contract disagreements across overlapping sources.

```
suss check provider.json consumer.json
suss check --dir summaries/           # auto-pairs by method + path
```

**Check against third-party specs you don't own.** `suss stub --from openapi` (or `--from cloudformation`) turns a spec into the same `BehavioralSummary[]` shape. Your consumer can be checked against Stripe's OpenAPI, an internal team's API Gateway template, or any vendor contract, without access to their source.

**Publish behavioral contracts.** Summaries are portable — paths are relative, the format is [versioned and documented](docs/behavioral-summary-format.md). Library authors can ship summaries alongside their package so consumers get cross-boundary checking without the source.

**Build downstream tools.** The summary format is a foundation: documentation generators, AI context providers, test case enumerators, impact analyzers, architectural dashboards, design-review artifacts. Install `@suss/behavioral-ir` (one peer dep on `zod`) to consume it in TS with runtime validation. Non-TS consumers can validate against the generated [JSON Schema](packages/ir/schema/behavioral-summary.schema.json). See the [format spec](docs/behavioral-summary-format.md) for the consumption guide.

## Usage

### Install

suss ships as `@suss/cli` plus opt-in pattern packs for your framework and runtime. Install the CLI globally or per-project:

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/runtime-axios
```

Pick the packs that match your code. The full set is in the [Packages](#packages) table.

### Extract summaries from source

```bash
# Provider side: extract handlers using the ts-rest pack
suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json

# Consumer side: extract axios call sites
suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json
```

`-f` may be repeated: `-f ts-rest -f axios` runs both packs in one pass. Output is a JSON array of `BehavioralSummary` objects.

### Pair a provider against a consumer

```bash
suss check summaries/provider.json summaries/consumer.json
```

Emits findings (unhandled statuses, dead consumer branches, body-field mismatches, contract violations). Exit code is non-zero when any `error`-severity finding exists; tune with `--fail-on error|warning|info|none`.

Whole-directory mode pairs every summary against every other by `(method, path)`:

```bash
suss check --dir summaries/
suss check --dir summaries/ --fail-on warning --json > findings.json
```

### Inspect a summary file

```bash
# Human-readable view of every transition
suss inspect summaries/provider.json

# Compare two points in time
suss inspect --diff before.json after.json

# Boundary-pair overview for a directory
suss inspect --dir summaries/
```

### Generate stubs from specs / manifests

`suss stub` turns a non-source-code contract into the same summary format:

```bash
# OpenAPI 3.x (3.0 and 3.1 supported)
suss stub --from openapi -i openapi.yaml -o summaries/stripe-provider.json

# AWS CloudFormation / SAM templates (handles inline OpenAPI bodies, native
# REST/HTTP API resources, and SAM Events blocks)
suss stub --from cloudformation -i template.yaml -o summaries/api-provider.json
```

Stubbed summaries carry `confidence.source: "stub"` and pair with extracted consumers exactly like source-extracted provider summaries.

### Suppress accepted findings

Create `.sussignore.yml` at the project root (or wherever you run `suss check` from):

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

`mark` keeps the finding visible but excludes it from exit-code; `downgrade` drops severity a level; `hide` removes it entirely. `reason` is required. See [`docs/suppressions.md`](docs/suppressions.md) for the full format.

Override or skip lookup via `--sussignore <path>` / `--no-suppressions`.

### Use in CI

```yaml
# .github/workflows/contracts.yml
- name: Extract
  run: npx suss extract -p tsconfig.json -f ts-rest -f axios -o summaries.json
- name: Stub third-party APIs
  run: npx suss stub --from openapi -i vendor/stripe.yaml -o stripe.json
- name: Check
  run: npx suss check --dir . --fail-on warning
```

The CLI exits non-zero when findings cross the `--fail-on` threshold, so standard CI gating works without extra plumbing. `--json` output is stable for downstream tools (dashboards, PR comment bots, metric collectors).

### Programmatic API

For custom pipelines (mono-repo orchestrators, IDE integrations, AI context providers), `@suss/checker` and `@suss/behavioral-ir` are directly importable:

```typescript
import { parseSummaries } from "@suss/behavioral-ir";
import { checkAll, applySuppressions } from "@suss/checker";

const summaries = parseSummaries(JSON.parse(readFileSync("summaries.json", "utf8")));
const { findings } = checkAll(summaries);
const effective = applySuppressions(findings, mySuppressions);
```

## Packages

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/behavioral-ir`](packages/ir) | zod schemas, types, parsers, and generated [JSON Schema](packages/ir/schema/behavioral-summary.schema.json). Install this to consume summaries. | ![](.github/badges/coverage-ir.svg) |
| [`@suss/extractor`](packages/extractor) | Assembly engine. Converts raw extracted structure into `BehavioralSummary`. | ![](.github/badges/coverage-extractor.svg) |
| [`@suss/adapter-typescript`](packages/adapter/typescript) | TypeScript language adapter via ts-morph. | ![](.github/badges/coverage-typescript.svg) |
| [`@suss/framework-ts-rest`](packages/framework/ts-rest) | Pattern pack for ts-rest. | ![](.github/badges/coverage-ts-rest.svg) |
| [`@suss/framework-react-router`](packages/framework/react-router) | Pattern pack for React Router loaders/actions/components. | ![](.github/badges/coverage-react-router.svg) |
| [`@suss/framework-react`](packages/framework/react) | Pattern pack for React function components. Components become `component`-kind summaries (render body + nested JSX tree); event handlers become sibling `handler`-kind summaries. | ![](.github/badges/coverage-react.svg) |
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

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) is a runnable end-to-end demo: a small TypeScript axios consumer of the Petstore API, paired against the Petstore OpenAPI spec via `suss stub`. `make all` runs the full pipeline (extract → stub → check) and produces actionable findings — unhandled status codes plus consumer reads of fields the provider declares optional.

## Docs

- [`docs/behavioral-summary-format.md`](docs/behavioral-summary-format.md) — the summary format spec, JSON Schema, publishing convention, what you can build on this
- [`docs/motivation.md`](docs/motivation.md) — the problem, why existing tools don't catch it, prior art, design principles
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together, the vocabulary (with examples), package dependency rules
- [`docs/pipelines.md`](docs/pipelines.md) — sequence diagrams for each CLI action (`extract`, `inspect`, `check`, `stub`) plus the internal assembly and pairing flows
- [`docs/extraction-algorithm.md`](docs/extraction-algorithm.md) — the four extraction functions, pseudocode, edge cases, testing strategy
- [`docs/ir-reference.md`](docs/ir-reference.md) — type-by-type walkthrough of `@suss/behavioral-ir`
- [`docs/framework-packs.md`](docs/framework-packs.md) — how to write or modify a pattern pack, pattern reference, worked Fastify example
- [`docs/cross-boundary-checking.md`](docs/cross-boundary-checking.md) — the pairwise checker: provider coverage, consumer satisfaction, contract consistency
- [`docs/suppressions.md`](docs/suppressions.md) — `.sussignore` file format and effects (`mark` / `downgrade` / `hide`) for accepted findings
- [`docs/stubs.md`](docs/stubs.md) — boundary contracts authored from non-source-code inputs (specs, manifests, vendor docs); reader/semantics layering; conventions for platform-injected transitions
- [`docs/contracts.md`](docs/contracts.md) — the five contract shapes (schema, examples, tests, snapshots, design), their epistemic characters (specification / observation / derivation), and how new domains get added
- [`docs/roadmap-react.md`](docs/roadmap-react.md) — React as the first non-HTTP boundary: components as N code units (render + handlers + effects), phased plan (inferred → Storybook → cross-shape checking), Figma punted
- [`docs/boundary-semantics.md`](docs/boundary-semantics.md) — design-only: the layered transport / semantics / recognition model, the `BoundarySemantics` refactor deferred until a second concrete protocol lands, and why GraphQL is the forcing function
- [`docs/status.md`](docs/status.md) — phase-by-phase progress tracker, test counts, decisions log
- [`docs/style.md`](docs/style.md) — code conventions (Biome, TypeScript, tests, monorepo)

## Status

Stable surface: the [behavioral summary format](docs/behavioral-summary-format.md), the IR types in `@suss/behavioral-ir`, the extraction pipeline, and the cross-boundary checker. Shipped packs: **ts-rest**, **React Router**, **Express**, **Fastify**, **fetch**, **axios**, plus early React component support (render body + event handlers). Stub generators: **OpenAPI 3.x**, **AWS API Gateway** (via CloudFormation/SAM). See [`docs/status.md`](docs/status.md) for the full capability matrix and [`docs/roadmap-react.md`](docs/roadmap-react.md) for the React arc.

## License

This project is licensed under the [Apache 2.0 License](LICENSE).
