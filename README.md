# suss

suss reads your code and checks what it does at every boundary, such as a route or a table, against the clients, specs and infrastructure on the other side. It works on TypeScript, Python and Ruby.

Code is written faster than anyone can read it. Large pull requests land all day, and no reviewer can keep one of them in their head. A diff shows you which lines of text changed, and you still have to work out what the service does now. Tests written alongside the change only check what their author meant. suss reads the code and writes down what it does on every path, from the request or message that comes in to the table or queue it touches, so you can read that instead. It runs the same way every time, and there is no model in it.

## Read one service

```bash
npx @suss/cli inspect
```

`inspect` reads the project you run it in. It works out which packs the project needs from its dependencies, the way `suss init` does, and tells you which ones it picked. `suss init` writes that choice down in `suss.json`, so every later command reads the same thing.

```
src/api.ts
├─ GET /users/{id}  (hono handler | line 5)
│      if  !findUser()
│        -> 404 { error }
│      elif  findUser().deletedAt
│        -> 410 { error }
│      else
│        -> 200 { id, name, email }
│
└─ POST /users  (hono handler | line 19)
       if  !c.req.json().name
         -> 400 "name is required"
       else
         -> 201 { id, name }
```

That is every path each handler can take, with the status and the body fields it produces. Where suss could not follow a call, it reports that under the handler instead of leaving the path out.

The same summaries are available to a coding agent over MCP, so it can ask what a route reaches or what writes a table before it edits either:

```json
{
  "mcpServers": {
    "suss": { "command": "npx", "args": ["-y", "@suss/mcp", "/path/to/project"] }
  }
}
```

`suss init` writes the `suss.json` the server reads. You can ask the same questions from the shell with `suss ask 'what writes postgresql:Article'`.

## Read what a change did

`inspect --diff` compares two summary files. Run it on the base and the head of a pull request and it reports what the change did to each unit, whichever lines the diff touched:

```
handler:GET /users/{id}
  hono handler
  3 changes
    + 200 { id, status }  when  findUser() && findUser().deletedAt
    - 410 { error }  when  findUser() && findUser().deletedAt
    ~ 200 { id, name, email }  (default)
      -> 200 { id, name }  (default)
```

A deleted account used to get a `410` and now gets a `200` with `status: "deleted"`, and `email` has left the response. Both versions compile and the types still line up, and every caller that treats a `200` as a usable account is now wrong. On a large pull request, read this output first.

## What you use it for

- A service you did not write, or one an agent changed an hour ago. `inspect` prints what each handler, consumer and query does on every path, in a page, without reading the source.
- A pull request too large to read. `inspect --diff` on the base and the head tells you which units changed behavior and how.
- An agent about to edit something. Over MCP it asks what a route reaches, what writes a table, or what calls a function, and gets file and line for each.
- A spec that drifted. `suss contract` reads an OpenAPI document, a Prisma schema or a CloudFormation template into the same form, and `check` reports where the code and the document disagree.
- A field you want to remove. `check` pairs every handler with the clients that call it and tells you which client reads the field, or never handles a status the handler produces.

Here is what a finding looks like, taken from the [runnable example](examples/petstore-axios-openapi/) in this repo:

```
[WARNING] unhandledProviderCase
  Provider produces status 400 but no consumer branch handles it
  provider: openapi:openapi.json::findPetsByStatus (openapi:openapi.json:0)
  consumer: src/petstore-client.ts::listPets (src/petstore-client.ts:48) (confidence: low)
  boundary: openapi (http) GET /api/v3/pet/findByStatus
```

## Adopting it

Each step costs a little more and asks a little more of the codebase. Stop at whichever one pays for itself. The [adoption guide](docs/guides/adopting-suss.md) walks each step with the command, what it tells you, and what a false positive looks like there.

1. Read one service with `extract` and `inspect`. Nothing to triage.
2. Question it with `suss ask` or the MCP server.
3. Compare it against a document you already keep with `suss contract` and `check`. `suss init` sets this up.
4. Add the consumer side, so a finding points at the caller that breaks.
5. Gate on it: `check --fail-on error` in CI, `inspect --diff` on every pull request.
6. Reuse the summaries: agent context, endpoint docs, the list of paths a test suite should cover.

## What it reads

TypeScript is the furthest along: Express, Fastify, Hono, NestJS, Next.js and ts-rest on the server, fetch, axios and Apollo on the client, Prisma, Drizzle and Mongoose for storage, Lambda handlers, and the AWS clients for SQS, SNS, EventBridge, DynamoDB and S3. In Python, suss reads FastAPI and flask-restx routes and SQLAlchemy queries. In Ruby, it reads Rails controllers, graphql-ruby schemas and ActiveRecord. The full list is in [Packs](#packs) below. suss checks a boundary inside one repository. You can compare summaries from two repositories by putting the files in one directory, and nothing does that for you yet.

## Install

suss ships as `@suss/cli`, with every pack inside it, so there is one install:

```bash
npm install --save-dev @suss/cli
```

You reach a pack by name, as in `suss extract -f ts-rest -f axios`, and a declared artifact with `suss contract --from openapi`. Without `-f`, `extract` reads the packs from `suss.json`, and when there is no such file it picks the ones `init` would have. A Python or Ruby project is read with `--dir` instead of a tsconfig; see [Read Python or Ruby](docs/guides/python-and-ruby.md).

`suss init` reads your project, works out which packs it needs, writes them to `suss.json`, and offers to set them up:

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

Nothing is written or installed unless you say yes. When its output is piped, or when it runs in CI, it prints the commands instead of asking, so `suss init --plain` works in a script.

## The four commands

All four work on the same `BehavioralSummary[]`:

- `suss extract` derives summaries from source.
- `suss contract` derives summaries from a declared artifact: OpenAPI, CloudFormation and SAM, Serverless Framework, Terraform, AppSync, GraphQL SDL and committed `.graphql` operation documents, Prisma schema, Storybook, Wrangler.
- `suss check` pairs providers with consumers and emits findings where they disagree. It exits nonzero when a finding crosses the `--fail-on error|warning|info|none` threshold.
- `suss inspect` renders summaries as text. `--diff BEFORE AFTER` reports what a change added, removed, or altered. `--flow "GET https://..."` shows who serves a request, hop by hop.

`extract` and `contract` produce the same format, so a TypeScript handler compares directly against the OpenAPI document for it, a CloudFormation template against the Lambda code it deploys, or a Storybook file against the React component it documents.

For every function reachable from a recognized entry point, suss emits a `BehavioralSummary`: the transitions the function produces, one per execution path, the predicates that guard each of them, the outputs, and the side effects along the way. `@suss/checker` and any downstream tool read that JSON, and `inspect` is one renderer over it.

## A complete example

[`examples/petstore-axios-openapi/`](examples/petstore-axios-openapi/) pairs a TypeScript axios consumer against the Petstore OpenAPI spec. `make all` runs extract, contract and check over it.

## Docs

The documentation site is at [nimbuscloud-ai.github.io/suss](https://nimbuscloud-ai.github.io/suss/).

- [Quickstart](./docs/start/quickstart.md): the smallest end-to-end example.
- [Adopt it step by step](docs/guides/adopting-suss.md): the steps above, one at a time.
- [AGENTS.md](AGENTS.md): driving suss from a coding agent, and which docs answer what. [`@suss/mcp`](packages/mcp) puts the same questions in front of a model as MCP tools. `npm install @suss/cli` ships the same file at `node_modules/@suss/cli/AGENTS.md`. Run `suss ask` with no question and it prints the questions it takes.
- [The problem](./docs/why/the-problem.md): the problem, and why existing tools miss it.
- [Compared to other tools](./docs/why/compared.md): what your linter, types, OpenAPI, tests and tracing each tell you, and what suss adds.
- [Glossary](./docs/reference/glossary.md): one canonical definition per term.
- [FAQ](./docs/reference/faq.md): what suss reads, what a boundary is, and what it leaves out.
- [Kinds of contract](./docs/why/kinds-of-contract.md): the kinds of contract, how much each one can tell you, and how that decides what a finding means. Intent docs your team writes get [their own guide](./docs/guides/check-against-intent.md).
- [Cross-boundary checking](./docs/why/cross-boundary-checking.md): how the pairwise checker works.
- [Accept a finding](./docs/guides/accept-a-finding.md): the `.sussignore` file format.

Reference and theory: [Summary format](./docs/reference/summary-format.md), [IR types](./docs/reference/ir.md), [Architecture](./docs/theory/architecture.md), [What a pack is](./docs/packs/what-a-pack-is.md), [Contract sources](./docs/packs/contract-sources.md).

## Packs

The behavioral summary format and the IR types in `@suss/behavioral-ir` are stable. The extraction pipeline and the cross-boundary checker are in active development against a growing set of packs.

Forty-four packs read code today, reached by name with `-f`:

| What it reads | Packs |
|---|---|
| HTTP frameworks, TypeScript | `express` `fastify` `hono` `nextjs` `nestjs-rest` `ts-rest` |
| HTTP frameworks, Python | `fastapi` `flask-restx` |
| HTTP frameworks, Ruby | `rails` |
| GraphQL servers | `apollo` `nestjs-graphql` `graphql-ruby` |
| Serverless and edge | `aws-lambda` `cloudflare-workers` |
| UI | `react` `react-router` `react-query` |
| HTTP and GraphQL clients | `fetch` `axios` `apollo-client` `requests` `httpx` `aiohttp` `faraday` `net-http` |
| Databases and ORMs | `prisma` `drizzle` `mongoose` `sqlalchemy` `sqlmodel` `activerecord` `redis` |
| Client state | `zustand` |
| Object and key-value storage | `aws-s3` `gcs` `aws-dynamodb` |
| Secrets and parameters | `aws-secrets-manager` `aws-ssm` |
| Messaging | `aws-sqs` `aws-sns` `aws-eventbridge` `nestjs-microservices` |
| Runtime surface | `node`, which includes `process.env` |
| In-process, between workspace packages | `package-exports` |

Ten contract readers turn a declared artifact into the same format, reached with `--from`: `openapi`, `graphql` (SDL), `graphql-documents` (committed `.graphql` operations), `cloudformation` (including SAM, and the API Gateway resources in it), `serverless`, `appsync`, `storybook`, `prisma`, `terraform`, `wrangler`. Intent docs your team writes are handled separately, by `suss check --intent`.

## License

[Apache 2.0](LICENSE).
