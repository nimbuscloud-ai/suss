# suss

suss finds the bugs that compile without complaint, type-check, and pass their tests, and still break at runtime. A consumer reads a `200` whose fields the provider changed. A Prisma write touches a column the schema doesn't declare. The types line up on both sides, so nothing in CI flags it.

suss works out what each function does on every path it can follow, then compares what it found wherever two units of code meet: a caller against a handler, a query against a schema. Where they disagree, you get a finding. It runs on the source you already have, without instrumentation or specs you have to write.

Here is what a finding looks like, taken from the [runnable example](examples/petstore-axios-openapi/) in this repo:

```
[ERROR] unhandledProviderCase
  Provider produces status 400 but no consumer branch handles it
  provider: openapi:petstore-openapi.json::findPetsByStatus (openapi:petstore-openapi.json:0)
  consumer: src/petstore-client.ts::listPets (src/petstore-client.ts:48) (confidence: low)
  boundary: openapi (http) GET /pet/findByStatus
```

The spec declares a 400 that this client never branches on. Both sides type-check today, so the first bad request at runtime reaches code that has no plan for it.

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

Nothing is written or installed unless you say yes. At a monorepo root
it finds the workspace and asks which packages you want to set up. When
its output is piped, or
when it runs in CI, it prints the commands instead of asking, so you can
put `suss init --plain` in a script.

Or run the three commands yourself:

```
suss extract -f hono -o summaries/api.json
suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
suss check --dir summaries/
```

## What a summary looks like

For every function reachable from a recognized entry point, suss emits a `BehavioralSummary`. It has the transitions the function produces, one per execution path, the predicates that guard each of them, the outputs, and the side effects along the way. `suss inspect` renders one:

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

That is every path the code can take, with the status and the body fields it produces. Where a declared contract promises something the code never produces, a `!!` line marks the gap. `@suss/checker` and any downstream tool read the same data as JSON, and `inspect` is one renderer over it.

The summary is the product. Checking is the use we have developed furthest. You can also use a summary to see what code does without reading the source, to generate documentation, to list out test cases, and to give AI agents structured context.

## Four CLI surfaces

All four work on the same `BehavioralSummary[]`:

- `suss extract` derives summaries from TypeScript or JavaScript source. Python and Ruby have adapters of their own, which you call from a script; see [docs/guides/python-and-ruby.md](docs/guides/python-and-ruby.md).
- `suss contract` derives summaries from declared contracts (OpenAPI, CloudFormation and SAM, Serverless Framework service files, AppSync, GraphQL SDL, committed `.graphql` operation documents, Prisma schema, Storybook).
- `suss check` pairs providers with consumers and emits findings where they disagree. It exits nonzero when a finding crosses the `--fail-on error|warning|info|none` threshold.
- `suss inspect` renders summaries as text. Give it `--diff BEFORE AFTER` to see what a change added, removed, or altered.

`extract` and `contract` produce the same format, so you can compare a TypeScript handler directly against an OpenAPI spec for it, a CloudFormation template against the Lambda code it deploys, or a Storybook CSF3 file against the React component it documents.

## Install

suss ships as `@suss/cli`, plus packs you opt into for the frameworks, runtimes, and contract sources you use:

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/client-axios
```

See [docs/reference/packages.md](docs/reference/packages.md) for the full pack matrix and common stack combinations, and the [add-to-project guide](docs/guides/add-to-project.md) for end-to-end integration.

## A complete example

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) pairs a TypeScript axios consumer against the Petstore OpenAPI spec. `make all` runs extract, contract and check over it.

## Docs

- [Get started](docs/tutorial/get-started.md): the smallest end-to-end example.
- [Motivation](docs/motivation.md): the problem, why existing tools miss it, prior art, design principles.
- [Glossary](docs/glossary.md): one canonical definition per term.
- [FAQ](docs/faq.md): how suss relates to linters, types, OpenAPI, tests, observability.
- [Contracts](docs/contracts.md): the kinds of contract, how much each one can tell you, and how that decides what a finding means. Intent docs your team writes are the [intent section](docs/contracts.md#intent).
- [Cross-boundary checking](docs/cross-boundary-checking.md): how the pairwise checker works.
- [Suppressions](docs/suppressions.md): the `.sussignore` file format.

Reference and internals: [Summary format](docs/behavioral-summary-format.md), [IR reference](docs/ir-reference.md), [Architecture](docs/architecture.md), [Packs](docs/packs.md), [Contract sources](docs/contract-sources.md).

## Status

The behavioral summary format and the IR types in `@suss/behavioral-ir` are stable. The extraction pipeline and the cross-boundary checker are in active development against a growing set of packs.

Nineteen packs read code today: ts-rest, Express, Fastify, Hono, Next.js, NestJS REST and GraphQL, Apollo Server, AWS Lambda, React (components, handlers, effects), React Router, fetch, axios, Apollo Client, Prisma, Drizzle, AWS SQS and EventBridge producers, and the Node runtime surface including `process.env`.

Seven contract readers turn a declared artifact into that same format: OpenAPI 3.x, GraphQL (SDL and committed `.graphql` operation documents), AWS API Gateway, CloudFormation / SAM, AppSync, Storybook CSF3, Prisma schema. Intent docs your team writes are handled separately, by `suss check --intent`.

## License

[Apache 2.0](LICENSE).
