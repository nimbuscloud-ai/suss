# suss

suss finds the bugs that compile cleanly, type-check, and pass their tests, and still break at runtime. A consumer reads a `200` whose shape the provider changed. A Prisma write touches a column the schema doesn't declare. The types line up on both sides, so nothing in CI flags it.

suss reads what each function does on every path it can follow, then compares those readings wherever two units of code meet: a caller against a handler, a query against a schema. Where they disagree, you get a finding. It runs on your source as it stands, without instrumentation or authored specs.

## Getting started

`suss init` reads your project, works out which packs it needs, and
offers to set them up:

```
┌  suss init
│
◇  Found ─────────────────────────────╮
│                                     │
│  hono          hono in dependencies │
│  apollo-client @apollo/client in .. │
│  cloudformation a SAM template at.. │
│                                     │
├─────────────────────────────────────╯
│
◇  Install 4 packages as devDependencies?
│  ● Yes / ○ No
│
◇  Installed 4 packages
│
◇  Read the code now and compare what it finds?
│  ● Yes / ○ No
│
◇  suss extract -f hono -f apollo-client -o summaries/code.json
◇  suss contract --from cloudformation template.yaml -o summaries/cloudformation.json
│
◆  Add a .sussignore for findings you decide to accept?
│  ○ Yes / ● No
│
└  Done. Re-run `suss check --dir summaries/` whenever code changes.
```

Nothing is written or installed unless you say yes, and every question
takes Ctrl-C. At a monorepo root it finds the workspace and asks which
packages to set up. Piped or in CI it prints the commands instead of
asking, so `suss init --plain` fits in a script.

Or run the three commands yourself:

```
suss extract -f hono -o summaries/api.json
suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
suss check --dir summaries/
```

## What a summary looks like

For every function reachable from a recognized entry point, suss emits a `BehavioralSummary`: the transitions the function produces (one per execution path), the predicates gating each, the outputs, and the side effects along the way. `suss inspect` renders one:

```
src/api.ts
├─ GET /users/:id  (hono handler | line 11)
│      if  !findUser()
│        -> 404 { error }
│      elif  findUser().deletedAt
│        -> 410 { error }
│      else
│        -> 200 { id, name }
│
└─ POST /users  (hono handler | line 25)
       if  !c.req.json().name
         -> 400 "name is required"
       else
         -> 201 { id, name }
```

Every path the code can take, with the status and body shape it produces. Where a declared contract promises something the code never produces, a `!!` line marks the gap. The same data as JSON is what `@suss/checker` and any downstream tool consumes, and `inspect` is a renderer over it.

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
