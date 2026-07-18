# suss

suss catches behavioral drift between what your TypeScript code says it does and what it does. The bugs it surfaces are the ones that compile cleanly, type-check, and pass their tests: code where a consumer reads a `200` whose shape the provider quietly changed, or a Prisma write touches a column the schema doesn't declare. The bug shows up at runtime, and nothing in CI today catches it.

suss derives what every function does on every execution path and pairs those derivations across boundaries, the points where two units of code meet. The drift falls out of the comparison, without runtime instrumentation and without you writing specs.

```
suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json
suss check summaries/
```

## What a summary looks like

For every function reachable from a recognized entry point, suss emits a `BehavioralSummary`: the transitions the function produces (one per execution path), the predicates gating each, the outputs, and the side effects along the way. `suss inspect` renders one:

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

The decision tree shows every path with its output shape. The `!!` line is a gap between the declared contract and the implementation. The same data as JSON is what `@suss/checker` and any downstream tool consumes, and `inspect` is a renderer over it.

The summary is the product. Checking is the most-developed use; others include reading what code does without reading source, generating documentation, enumerating test cases, and feeding AI agents structured context.

## Four CLI surfaces

Over the same `BehavioralSummary[]`:

- `suss extract` derives summaries from TypeScript source.
- `suss contract` derives summaries from declared contracts (OpenAPI, CloudFormation, AppSync, GraphQL SDL, Prisma schema, Storybook).
- `suss check` pairs providers with consumers and emits findings where they disagree. The exit code crosses the `--fail-on error|warning|info|none` threshold.
- `suss inspect` renders summaries as text, or `--diff BEFORE AFTER` to see what a change added, removed, or altered.

`extract` and `contract` produce the same shape, so a TypeScript handler and an OpenAPI spec for it are directly comparable, as are a CloudFormation template and the Lambda code it deploys, or a Storybook CSF3 file and the React component it documents.

## Install

suss ships as `@suss/cli` plus opt-in packs for the frameworks, runtimes, and contract sources you use:

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/client-axios
```

See [docs/reference/packages.md](docs/reference/packages.md) for the full pack matrix and common stack combinations, and the [add-to-project guide](docs/guides/add-to-project.md) for end-to-end integration.

## A complete example

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) is a runnable end-to-end demo: a TypeScript axios consumer of the Petstore API, paired against the Petstore OpenAPI spec via `suss contract`. `make all` runs the full pipeline (extract, contract, check) and produces actionable findings: unhandled status codes plus consumer reads of fields the provider declares optional.

## Docs

Start here:

- [Get started](docs/tutorial/get-started.md): the smallest end-to-end example.
- [Motivation](docs/motivation.md): the problem, why existing tools miss it, prior art, design principles.
- [Glossary](docs/glossary.md): one canonical definition per term.
- [FAQ](docs/faq.md): how suss relates to linters, types, OpenAPI, tests, observability.

Understanding suss:

- [Contracts](docs/contracts.md): the shapes of contract (schema, examples, tests, snapshots, design), their epistemic characters, and how they ground finding semantics.
- [Cross-boundary checking](docs/cross-boundary-checking.md): how the pairwise checker works.
- [Suppressions](docs/suppressions.md): the `.sussignore` file format.

Intent docs (team-authored intent, checked against derived code) pair alongside behavioral summaries; see the intent section of [Contracts](docs/contracts.md#intent).

Reference and internals: [Summary format](docs/behavioral-summary-format.md), [IR reference](docs/ir-reference.md), [Architecture](docs/architecture.md), [Packs](docs/packs.md), [Contract sources](docs/contract-sources.md).

## Status

The behavioral summary format and the IR types in `@suss/behavioral-ir` are stable. The extraction pipeline and the cross-boundary checker are in active development against a growing set of packs. Shipped recognition: ts-rest, React Router, Express, Fastify, Apollo Server, NestJS REST + GraphQL, React (components + handlers + effects), fetch, axios, Apollo Client, Prisma, AWS SQS + EventBridge producers, AWS Lambda, `process.env`. Shipped contract sources: OpenAPI 3.x, GraphQL SDL, AWS API Gateway, CloudFormation / SAM, AppSync, Storybook CSF3, Prisma schema.

## License

This project is licensed under the [Apache 2.0 License](LICENSE).
