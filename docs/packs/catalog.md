---
title: Pack catalog
description: Every pack suss ships, what each one reads, and which ones the frameworks and contract sources in your stack need.
---

# Pack catalog

Every pack ships inside the CLI, so there is one install and nothing else to add:

```bash
npm install --save-dev @suss/cli
```

Forty-nine packs read code today, across forty frameworks, eight HTTP and GraphQL clients, and the Node runtime. Ten contract readers turn a declared artifact into the same summary structure. Team-authored intent docs are their own stream, read by `@suss/contract-intent`.

Most of that is TypeScript and JavaScript. Four of the packs read another language: flask-restx and FastAPI read Python through `@suss/adapter-python`, and graphql-ruby and rails read Ruby through `@suss/adapter-ruby`. `suss extract` reaches those two adapters as well, and the [Python and Ruby guide](/guides/python-and-ruby) shows how.

The quickest way to find your packs is to let suss look:

```bash
suss init
```

It reads your dependencies, tells you which packs match, and offers to write them into `suss.json`. The [add-to-project guide](/guides/add-to-project) walks the whole setup.

## What to run, by stack

The first column of every table below is the name `-f` takes, and `-f` is repeatable. A declared artifact is read by `suss contract --from <source>` rather than by a pack.

| Stack | What to run |
|---|---|
| ts-rest full-stack | `-f ts-rest`, which reads the provider and the client through the contract |
| Hono and fetch | `-f hono -f fetch` |
| Express and fetch | `-f express -f fetch` |
| Next.js route handlers | `-f nextjs` |
| React and GraphQL | `-f react -f apollo-client` |
| Lambda and SQS | `-f aws-sqs -f node`, and `contract --from cloudformation` |
| Cloudflare Worker | `-f cloudflare-workers`, and `contract --from wrangler` |
| Postgres through Prisma | add `-f prisma`, and `contract --from prisma` |
| Postgres through Drizzle | add `-f drizzle` |
| MongoDB through Mongoose | add `-f mongoose` |

## Frameworks

A framework pack finds the units a framework defines: a route handler, a component, a resolver, a queue consumer. Run one of these and `suss extract` has something to describe.

<!-- generated from what each pack declares: framework -->

| Name | What it reads | Coverage |
|---|---|---|
| [`apollo`](../../packages/framework/apollo) | Apollo Server resolvers (code-first). | ![](../../.github/badges/coverage-apollo.svg) |
| [`aws-lambda`](../../packages/framework/aws-lambda) | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes. | ![](../../.github/badges/coverage-aws-lambda.svg) |
| [`cloudflare-workers`](../../packages/framework/cloudflare-workers) | A Cloudflare Workers entrypoint: one unit per trigger the default export defines, and the bindings its code reads off the argument they arrive in. | ![](../../.github/badges/coverage-cloudflare-workers.svg) |
| [`express`](../../packages/framework/express) | Express handlers. | ![](../../.github/badges/coverage-express.svg) |
| [`fastapi`](../../packages/framework/fastapi) | FastAPI routes (Python): the verb comes from the decorator's own attribute name, `APIRouter` prefixes are composed one `include_router` hop deep, and `response_model` / `status_code` are taken as the declared contract. | ![](../../.github/badges/coverage-fastapi.svg) |
| [`fastify`](../../packages/framework/fastify) | Fastify handlers. | ![](../../.github/badges/coverage-fastify.svg) |
| [`flask-restx`](../../packages/framework/flask-restx) | flask-restx `Resource` routes (Python), including a project's own wrapper module that re-exports the route decorator. | ![](../../.github/badges/coverage-flask-restx.svg) |
| [`graphql-ruby`](../../packages/framework/graphql-ruby) | graphql-ruby class-based field DSL (Ruby), including `mutation:` / `resolver:` wiring one hop out to what the referenced class itself declares, and the model a resolver reads through `dataloader` when a storage pack in the run recognizes it. | ![](../../.github/badges/coverage-graphql-ruby.svg) |
| [`hono`](../../packages/framework/hono) | Hono handlers, including the `c.json(body, status)` argument order. | ![](../../.github/badges/coverage-hono.svg) |
| [`nestjs-graphql`](../../packages/framework/nestjs-graphql) | NestJS GraphQL resolvers. | ![](../../.github/badges/coverage-nestjs-graphql.svg) |
| [`nestjs-microservices`](../../packages/framework/nestjs-microservices) | NestJS microservice handlers: `@EventPattern` and `@MessagePattern` consumers on the channel the decorator states. | ![](../../.github/badges/coverage-nestjs-microservices.svg) |
| [`nestjs-rest`](../../packages/framework/nestjs-rest) | NestJS REST controllers. | ![](../../.github/badges/coverage-nestjs-rest.svg) |
| [`nextjs`](../../packages/framework/nextjs) | Next.js route handlers, pages, and server actions; the route comes from where the file is on disk, and a `"use server"` function becomes an action unit. | ![](../../.github/badges/coverage-nextjs.svg) |
| [`package-exports`](../../packages/framework/package-exports) | The boundary between packages in one workspace: public exports on the provider side, imports of them on the consumer side. Reads the workspace manifest, so it needs no per-project package list. | ![](../../.github/badges/coverage-package-exports.svg) |
| [`rails`](../../packages/framework/rails) | Rails controller actions (Ruby), bound to the method and path `config/routes.rb` gives each one; an action the routes file does not reach is discovered with no boundary. | ![](../../.github/badges/coverage-rails.svg) |
| [`react`](../../packages/framework/react) | React function components, event handlers, `useEffect` bodies. | ![](../../.github/badges/coverage-react.svg) |
| [`react-query`](../../packages/framework/react-query) | TanStack Query hooks: ties a component to the query function its `useQuery` / `useMutation` call runs. | ![](../../.github/badges/coverage-react-query.svg) |
| [`react-router`](../../packages/framework/react-router) | React Router loaders / actions / routes. | ![](../../.github/badges/coverage-react-router.svg) |
| [`ts-rest`](../../packages/framework/ts-rest) | ts-rest providers + clients (contract-backed). | ![](../../.github/badges/coverage-ts-rest.svg) |

<!-- end framework -->

## Clients

A client pack finds the other side, the call sites, and binds each one to the method and path it sends. That is what lets the checker pair a call against whoever serves the route.

<!-- generated from what each pack declares: client -->

| Name | What it reads | Coverage |
|---|---|---|
| [`aiohttp`](../../packages/client/aiohttp) | aiohttp call sites (Python): the request methods on a `ClientSession`, opened with `async with` or held in an assignment. | ![](../../.github/badges/coverage-aiohttp.svg) |
| [`apollo-client`](../../packages/client/apollo) | `@apollo/client` hooks + imperative `client.query`. | ![](../../.github/badges/coverage-apollo-client.svg) |
| [`axios`](../../packages/client/axios) | axios call sites + `axios.create` factories. | ![](../../.github/badges/coverage-axios.svg) |
| [`faraday`](../../packages/client/faraday) | Faraday call sites (Ruby): a request method on the module itself or on a connection `Faraday.new` built, served under the path that connection's own URL states. | ![](../../.github/badges/coverage-faraday.svg) |
| [`fetch`](../../packages/client/web) | Global `fetch` call sites. | ![](../../.github/badges/coverage-web.svg) |
| [`httpx`](../../packages/client/httpx) | httpx call sites (Python): the verb functions, `httpx.request`, and a `Client` or `AsyncClient` held in an assignment or opened with `with`. | ![](../../.github/badges/coverage-httpx.svg) |
| [`net-http`](../../packages/client/net-http) | Net::HTTP call sites (Ruby): the module methods that send on their own, and a request object built with `Net::HTTP::Get` and its siblings, with the URL read through `URI`. | ![](../../.github/badges/coverage-net-http.svg) |
| [`requests`](../../packages/client/requests) | requests call sites (Python): the seven verb functions, `requests.request`, and a `Session`, each bound to the method and path the call states. | ![](../../.github/badges/coverage-requests.svg) |

<!-- end client -->

## What your code reaches

An effects pack reads the calls inside a unit another pack discovered: a query, a publish, a read of the environment. On its own it comes back empty, so run it alongside the pack that finds the units.

<!-- generated from what each pack declares: effects -->

| Name | What it reads | Coverage |
|---|---|---|
| [`activerecord`](../../packages/framework/activerecord) | ActiveRecord calls (Ruby): a call matches when its method is one ActiveRecord defines as a read or a write and the class behind its receiver reaches `ActiveRecord::Base`, following what each class extends through the project. Statements the project wrote itself are read for the tables they touch, whether they went through `find_by_sql` and `count_by_sql` or through the connection. | ![](../../.github/badges/coverage-activerecord.svg) |
| [`aws-dynamodb`](../../packages/framework/aws-dynamodb) | AWS SDK v3 DynamoDB calls, emits storage-access interactions. | ![](../../.github/badges/coverage-aws-dynamodb.svg) |
| [`aws-eventbridge`](../../packages/framework/aws-eventbridge) | AWS EventBridge `PutEvents` producer calls, emits message-bus interactions. | ![](../../.github/badges/coverage-aws-eventbridge.svg) |
| [`aws-s3`](../../packages/framework/aws-s3) | AWS SDK v3 S3 object calls, emits storage-access interactions. | ![](../../.github/badges/coverage-aws-s3.svg) |
| [`aws-secrets-manager`](../../packages/framework/aws-secrets-manager) | AWS Secrets Manager calls, emits storage-access interactions against the secret. | ![](../../.github/badges/coverage-aws-secrets-manager.svg) |
| [`aws-sns`](../../packages/framework/aws-sns) | AWS SDK v3 SNS `Publish` and `PublishBatch` calls, emits message-send interactions on the topic. | ![](../../.github/badges/coverage-aws-sns.svg) |
| [`aws-sqs`](../../packages/framework/aws-sqs) | AWS SDK v3 SQS producer calls, emits message-send interactions. | ![](../../.github/badges/coverage-aws-sqs.svg) |
| [`aws-ssm`](../../packages/framework/aws-ssm) | AWS SSM Parameter Store calls, emits storage-access interactions against the parameter. | ![](../../.github/badges/coverage-aws-ssm.svg) |
| [`bigquery`](../../packages/framework/bigquery) | BigQuery queries and table calls, emits storage-access interactions with the dataset as the scope. | ![](../../.github/badges/coverage-bigquery.svg) |
| [`bigquery-python`](../../packages/framework/bigquery-python) | BigQuery calls (Python): the statement a client or an Airflow hook is handed, read for the tables it touches, and the calls that say which table without writing SQL. | ![](../../.github/badges/coverage-bigquery-python.svg) |
| [`bigquery-ruby`](../../packages/framework/bigquery-ruby) | google-cloud-bigquery calls (Ruby): a call matches when its receiver follows back to a client the gem handed out, and the statement it was given is parsed for the tables it touches. | ![](../../.github/badges/coverage-bigquery-ruby.svg) |
| [`drizzle`](../../packages/framework/drizzle) | Drizzle ORM query-builder and relational-query calls, emits storage-access interactions with SQL table names. | ![](../../.github/badges/coverage-drizzle.svg) |
| [`gcs`](../../packages/framework/gcs) | Google Cloud Storage calls, emits storage-access interactions. | ![](../../.github/badges/coverage-gcs.svg) |
| [`mongoose`](../../packages/framework/mongoose) | Mongoose model calls, emits storage-access interactions against the collection a model's `.model(...)` call declares. | ![](../../.github/badges/coverage-mongoose.svg) |
| [`node`](../../packages/runtime/node) | Node.js runtime primitives, scheduling, the `process` surface (incl. `process.env.X` config-read interactions), module-loading globals, emitted as interaction effects. | ![](../../.github/badges/coverage-runtime-node.svg) |
| [`pg`](../../packages/framework/pg) | node-postgres queries, emits storage-access interactions with the tables each statement touches. | ![](../../.github/badges/coverage-pg.svg) |
| [`pg-ruby`](../../packages/framework/pg-ruby) | pg gem calls (Ruby): a call matches when its receiver follows back to a connection the gem handed out, and the statement it was given is parsed for the tables it touches. | ![](../../.github/badges/coverage-pg-ruby.svg) |
| [`prisma`](../../packages/framework/prisma) | Prisma client calls, emits storage-access interactions per read / write. | ![](../../.github/badges/coverage-prisma.svg) |
| [`redis`](../../packages/framework/redis) | Redis, Valkey and node-redis commands, emits storage-access interactions. | ![](../../.github/badges/coverage-redis.svg) |
| [`sqlalchemy`](../../packages/framework/sqlalchemy) | SQLAlchemy calls (Python): says which types a query comes back as and which methods write, and the adapter matches a call chain by resolving through a project's own base class to what the method behind it says it returns. | ![](../../.github/badges/coverage-sqlalchemy.svg) |
| [`sqlmodel`](../../packages/framework/sqlmodel) | SQLModel calls (Python): says which types a query comes back as and which methods write, under the modules SQLModel exports them from, and includes the SQLAlchemy patterns a SQLModel project also reaches. | ![](../../.github/badges/coverage-sqlmodel.svg) |
| [`zustand`](../../packages/framework/zustand) | zustand stores: `setState` writes and `getState` reads against the store as a client-side container. | ![](../../.github/badges/coverage-zustand.svg) |

<!-- end effects -->

## Contract sources

These are not packs. A contract source reads something the project already declares and writes the same summaries the extractor writes, and you reach it through `suss contract --from <name>`. [Contract sources](/packs/contract-sources) has a command and the output for each one.

| Reader | `--from` | What it reads | Coverage |
|---|---|---|---|
| [`@suss/contract-openapi`](../../packages/contract/openapi) | `openapi` | An OpenAPI 3.x document, JSON or YAML. | ![](../../.github/badges/coverage-contract-openapi.svg) |
| [`@suss/contract-graphql`](../../packages/contract/graphql) | `graphql`, `graphql-documents` | A GraphQL SDL file becomes one resolver-kind summary per Query, Mutation and Subscription field. Committed `.graphql` and `.gql` operation documents become one client-kind summary per operation, with fragment spreads inlined, so a repo that keeps its queries in files pairs against its resolvers without any call site being traced. | ![](../../.github/badges/coverage-contract-graphql.svg) |
| [`@suss/contract-cloudformation`](../../packages/contract/cloudformation) | `cloudformation` | CloudFormation and SAM templates. It delegates to the OpenAPI and API Gateway readers, and handles SQS event-source mappings and a function's `Environment` itself. | ![](../../.github/badges/coverage-contract-cloudformation.svg) |
| [`@suss/contract-serverless`](../../packages/contract/serverless) | `serverless` | A Serverless Framework service file. The reader restates the functions block in SAM's forms and hands it to the CloudFormation reader, so a route, a queue consumer or an environment contract comes out the same whichever manifest language declared it. `${self:}` resolves against the document, and a deploy-time reference keeps its token. | ![](../../.github/badges/coverage-contract-serverless.svg) |
| [`@suss/contract-terraform`](../../packages/contract/terraform) | `terraform` | A `.tf` file or the directory a module lives in. The AWS and Google Cloud provider vocabularies both load. | ![](../../.github/badges/coverage-contract-terraform.svg) |
| [`@suss/contract-wrangler`](../../packages/contract/wrangler) | `wrangler` | A Cloudflare Worker's `wrangler.toml` or `wrangler.jsonc`. The Worker comes out as a deployable with the configuration it is given, values included, so a store addressed through a variable resolves, plus a summary per KV namespace, R2 bucket, D1 database and Queues channel it is bound to. | ![](../../.github/badges/coverage-contract-wrangler.svg) |
| [`@suss/contract-appsync`](../../packages/contract/appsync) | `appsync` | An AppSync GraphQL schema and its resolver mapping templates. | ![](../../.github/badges/coverage-contract-appsync.svg) |
| [`@suss/contract-prisma`](../../packages/contract/prisma) | `prisma` | A `schema.prisma` file, one storage provider summary per model. | ![](../../.github/badges/coverage-contract-prisma.svg) |
| [`@suss/contract-storybook`](../../packages/contract/storybook) | `storybook` | Storybook CSF3 stories, one component contract summary per story. | ![](../../.github/badges/coverage-contract-storybook.svg) |
| [`@suss/contract-aws-apigateway`](../../packages/contract/aws-apigateway) | (through the readers above) | API Gateway resource semantics for REST and HTTP APIs, including the transitions the platform injects. The CloudFormation, Serverless and Terraform readers all delegate to it. | ![](../../.github/badges/coverage-contract-aws-apigateway.svg) |
| [`@suss/contract-intent`](../../packages/contract/intent) | (through `check --intent`) | Team-authored intent specs, `*.intent` and `*.prd`. | ![](../../.github/badges/coverage-contract-intent.svg) |

## Asking for a pack

If the framework you use is not in a table above, [open an issue](https://github.com/nimbuscloud-ai/suss/issues/new) with the library, a link to its docs, and ten or fifteen lines of code showing how your project registers a handler and returns a response. That is what a pack is written from, and a snippet from a project that actually uses the library settles questions the library's own docs leave open.

You do not have to wait for one. A pack is a data object of about a hundred lines, it lives in a package of your own, and `-f @your-scope/your-pack` loads it with nothing else to configure. [Write a pack](/packs/write-a-pack) builds one start to finish.

If a pack exists and comes back with nothing, that is a different problem: [Fix a run that found nothing](/guides/fix-an-empty-run).

## Everything else in the box

The rest of what `@suss/cli` installs: the IR the summaries are written in, the language adapters, the checker, the shared machinery the packs run on.

![combined](../../.github/badges/coverage.svg)

| Package | What it is | Coverage |
|---------|-------------|----------|
| [`@suss/ir-core`](../../packages/ir-core) | Shared IR primitives, type shapes, boundary bindings + constructors, source locations, confidence. Base for `behavioral-ir` and `intent-ir`. | ![](../../.github/badges/coverage-ir-core.svg) |
| [`@suss/behavioral-ir`](../../packages/behavioral-ir) | zod schemas, types, parsers, and generated [JSON Schema](../../packages/behavioral-ir/schema/behavioral-summary.schema.json). Install this to consume summaries. | ![](../../.github/badges/coverage-ir.svg) |
| [`@suss/intent-ir`](../../packages/intent-ir) | Team-authored intent: system intent (what a boundary should do) + PRD outcome intent, paired against derived summaries. | ![](../../.github/badges/coverage-intent-ir.svg) |
| [`@suss/datalog`](../../packages/datalog) | Small semi-naive Datalog evaluator with stratified negation; the rules engine behind derived program facts. | ![](../../.github/badges/coverage-datalog.svg) |
| [`@suss/resolution`](../../packages/resolution) | Datalog rules for following a value back to the function it resolves to: a factory's argument, a re-exported wrapper, a closure three levels down. Language-neutral, so an adapter supplies facts and inherits the rules. | ![](../../.github/badges/coverage-resolution.svg) |
| [`@suss/values`](../../packages/values) | Bounded evaluator over an abstract value domain: strings as pieces with named holes, sequences, records. An adapter supplies a lowering of its AST and a row table for its operators and library methods, and readers ask what an expression is worth instead of matching one spelling at a time. | ![](../../.github/badges/coverage-values.svg) |
| [`@suss/extractor`](../../packages/extractor) | Assembly engine. It converts raw extracted structure into `BehavioralSummary`. | ![](../../.github/badges/coverage-extractor.svg) |
| [`@suss/recognize`](../../packages/recognize) | Write a pack as data: a chain of named links, compiled to the recognizer hooks, run by any adapter that implements the executor ops. | ![](../../.github/badges/coverage-recognize.svg) |
| [`@suss/packs`](../../packages/packs) | Every pack, one subpath each, so `@suss/packs/express` reaches the Express pack. The CLI resolves `-f` names to these on its own. | tested through each pack |
| [`@suss/adapter-typescript`](../../packages/adapter/typescript) | TypeScript language adapter via ts-morph. | ![](../../.github/badges/coverage-typescript.svg) |
| [`@suss/adapter-python`](../../packages/adapter/python) | Python language adapter: tree-sitter (WASM) parsing, a lexical binder, repo-scoped module resolution. v0, no path-engine work yet. | ![](../../.github/badges/coverage-python.svg) |
| [`@suss/adapter-ruby`](../../packages/adapter/ruby) | Ruby language adapter: tree-sitter (WASM) parsing, a lexical binder over class/module nesting, Rails' constant-to-path convention for `mutation:` / `resolver:` wiring and controller discovery. v0, graphql-ruby and rails, no path-engine work yet. | ![](../../.github/badges/coverage-ruby.svg) |
| [`@suss/checker`](../../packages/checker) | Pairwise cross-boundary checker (behavioral). | ![](../../.github/badges/coverage-checker.svg) |
| [`@suss/checker-intent`](../../packages/checker-intent) | Pairs team-authored intent against derived code; emits `IntentFinding` coverage. | ![](../../.github/badges/coverage-checker-intent.svg) |
| [`@suss/cli`](../../packages/cli) | CLI wrapper. | ![](../../.github/badges/coverage-cli.svg) |
| [`@suss/mcp`](../../packages/mcp) | An MCP server over the CLI, so a coding agent can ask about a boundary while it works. Keeps its summaries current as files change. | ![](../../.github/badges/coverage-mcp.svg) |
| [`@suss/sql`](../../packages/sql) | Reads what a SQL statement touches, for packs that meet a raw query. | ![](../../.github/badges/coverage-sql.svg) |
| [`@suss/manifest-aws`](../../packages/manifest/aws) | Parses CloudFormation and SAM templates into a shared facts layer that the contract readers and the manifest-driven framework packs both read. | ![](../../.github/badges/coverage-manifest-aws.svg) |
| [`@suss/terraform-aws`](../../packages/terraform/aws) | What AWS's Terraform provider declares, as data for that reader. | ![](../../.github/badges/coverage-terraform-aws.svg) |
| [`@suss/terraform-gcp`](../../packages/terraform/gcp) | What Google Cloud's Terraform provider declares, as data for that reader. | ![](../../.github/badges/coverage-terraform-gcp.svg) |
