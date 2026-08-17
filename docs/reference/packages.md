# Packages

suss ships as `@suss/cli` plus opt-in packs for the frameworks, runtimes, and contract sources a project uses. Install the CLI and only the packs you need; nothing pulls in the whole set.

Twenty-two packs read code today, across eighteen frameworks, three HTTP and GraphQL clients, and the Node runtime. Eight contract readers turn a declared artifact into the same summary structure. Team-authored intent docs are their own stream, read by `@suss/contract-intent`.

Most of that is TypeScript and JavaScript, which is what `suss extract` reads. Three of the framework packs are not: flask-restx and FastAPI read Python through `@suss/adapter-python`, and graphql-ruby reads Ruby through `@suss/adapter-ruby`. `suss extract` reaches those two adapters as well; the [Python and Ruby guide](/guides/python-and-ruby) shows how.

## Install by stack

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/client-axios
```

Common combinations:

| Stack | Packs |
|---|---|
| ts-rest full-stack | `@suss/framework-ts-rest` (provider + client through the contract) |
| Hono + fetch | `@suss/framework-hono @suss/client-web` |
| Express + fetch | `@suss/framework-express @suss/client-web` |
| Next.js route handlers | `@suss/framework-nextjs` |
| React + GraphQL | `@suss/framework-react @suss/client-apollo` |
| Lambda + SQS | `@suss/framework-aws-sqs @suss/contract-cloudformation @suss/runtime-node` |
| App backed by Postgres (Prisma) | add `@suss/framework-prisma @suss/contract-prisma` to any of the above |
| App backed by Postgres (Drizzle) | add `@suss/framework-drizzle` to any of the above |

The [add-to-project guide](/guides/add-to-project) walks the integration end-to-end.

## Core

![combined](../../.github/badges/coverage.svg)

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/ir-core`](../../packages/ir-core) | Shared IR primitives, type shapes, boundary bindings + constructors, source locations, confidence. Base for `behavioral-ir` and `intent-ir`. | ![](../../.github/badges/coverage-ir-core.svg) |
| [`@suss/behavioral-ir`](../../packages/behavioral-ir) | zod schemas, types, parsers, and generated [JSON Schema](../../packages/behavioral-ir/schema/behavioral-summary.schema.json). Install this to consume summaries. | ![](../../.github/badges/coverage-ir.svg) |
| [`@suss/intent-ir`](../../packages/intent-ir) | Team-authored intent: system intent (what a boundary should do) + PRD outcome intent, paired against derived summaries. | ![](../../.github/badges/coverage-intent-ir.svg) |
| [`@suss/datalog`](../../packages/datalog) | Small semi-naive Datalog evaluator with stratified negation; the rules engine behind derived program facts. | ![](../../.github/badges/coverage-datalog.svg) |
| [`@suss/resolution`](../../packages/resolution) | Datalog rules for following a value back to the function it resolves to: a factory's argument, a re-exported wrapper, a closure three levels down. Language-neutral, so an adapter supplies facts and inherits the rules. | ![](../../.github/badges/coverage-resolution.svg) |
| [`@suss/extractor`](../../packages/extractor) | Assembly engine. It converts raw extracted structure into `BehavioralSummary`. | ![](../../.github/badges/coverage-extractor.svg) |
| [`@suss/adapter-typescript`](../../packages/adapter/typescript) | TypeScript language adapter via ts-morph. | ![](../../.github/badges/coverage-typescript.svg) |
| [`@suss/adapter-python`](../../packages/adapter/python) | Python language adapter: tree-sitter (WASM) parsing, a lexical binder, repo-scoped module resolution. v0, no path-engine work yet. | ![](../../.github/badges/coverage-python.svg) |
| [`@suss/adapter-ruby`](../../packages/adapter/ruby) | Ruby language adapter: tree-sitter (WASM) parsing, a lexical binder over class/module nesting, Rails' constant-to-path convention for `mutation:` / `resolver:` wiring. v0, graphql-ruby only, no `routes.rb`, no path-engine work yet. | ![](../../.github/badges/coverage-ruby.svg) |
| [`@suss/checker`](../../packages/checker) | Pairwise cross-boundary checker (behavioral). | ![](../../.github/badges/coverage-checker.svg) |
| [`@suss/checker-intent`](../../packages/checker-intent) | Pairs team-authored intent against derived code; emits `IntentFinding` coverage. | ![](../../.github/badges/coverage-checker-intent.svg) |
| [`@suss/cli`](../../packages/cli) | CLI wrapper. | ![](../../.github/badges/coverage-cli.svg) |

## Frameworks

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/framework-ts-rest`](../../packages/framework/ts-rest) | ts-rest providers + clients (contract-backed). | ![](../../.github/badges/coverage-ts-rest.svg) |
| [`@suss/framework-express`](../../packages/framework/express) | Express handlers. | ![](../../.github/badges/coverage-express.svg) |
| [`@suss/framework-fastify`](../../packages/framework/fastify) | Fastify handlers. | ![](../../.github/badges/coverage-fastify.svg) |
| [`@suss/framework-hono`](../../packages/framework/hono) | Hono handlers, including the `c.json(body, status)` argument order. | ![](../../.github/badges/coverage-hono.svg) |
| [`@suss/framework-nextjs`](../../packages/framework/nextjs) | Next.js route handlers and pages; the route comes from where the file is on disk. | ![](../../.github/badges/coverage-nextjs.svg) |
| [`@suss/framework-react`](../../packages/framework/react) | React function components, event handlers, `useEffect` bodies. | ![](../../.github/badges/coverage-react.svg) |
| [`@suss/framework-react-router`](../../packages/framework/react-router) | React Router loaders / actions / routes. | ![](../../.github/badges/coverage-react-router.svg) |
| [`@suss/framework-apollo`](../../packages/framework/apollo) | Apollo Server resolvers (code-first). | ![](../../.github/badges/coverage-apollo.svg) |
| [`@suss/framework-nestjs-rest`](../../packages/framework/nestjs-rest) | NestJS REST controllers. | ![](../../.github/badges/coverage-nestjs-rest.svg) |
| [`@suss/framework-nestjs-graphql`](../../packages/framework/nestjs-graphql) | NestJS GraphQL resolvers. | ![](../../.github/badges/coverage-nestjs-graphql.svg) |
| [`@suss/framework-prisma`](../../packages/framework/prisma) | Prisma client calls, emits storage-access interactions per read / write. | ![](../../.github/badges/coverage-prisma.svg) |
| [`@suss/framework-drizzle`](../../packages/framework/drizzle) | Drizzle ORM query-builder and relational-query calls, emits storage-access interactions with SQL table names. | ![](../../.github/badges/coverage-drizzle.svg) |
| [`@suss/contract-terraform`](../../packages/contract/terraform) | Reads the boundaries a Terraform configuration declares. | ![](../../.github/badges/coverage-contract-terraform.svg) |
| [`@suss/terraform-aws`](../../packages/terraform/aws) | What AWS's Terraform provider declares, as data for that reader. | ![](../../.github/badges/coverage-terraform-aws.svg) |
| [`@suss/sql`](../../packages/sql) | Reads what a SQL statement touches, for packs that meet a raw query. | ![](../../.github/badges/coverage-sql.svg) |
| [`@suss/framework-aws-dynamodb`](../../packages/framework/aws-dynamodb) | AWS SDK v3 DynamoDB calls, emits storage-access interactions. | ![](../../.github/badges/coverage-aws-dynamodb.svg) |
| [`@suss/framework-aws-s3`](../../packages/framework/aws-s3) | AWS SDK v3 S3 object calls, emits storage-access interactions. | ![](../../.github/badges/coverage-aws-s3.svg) |
| [`@suss/framework-redis`](../../packages/framework/redis) | Redis, Valkey and node-redis commands, emits storage-access interactions. | ![](../../.github/badges/coverage-redis.svg) |
| [`@suss/framework-aws-sqs`](../../packages/framework/aws-sqs) | AWS SDK v3 SQS producer calls, emits message-send interactions. | ![](../../.github/badges/coverage-aws-sqs.svg) |
| [`@suss/framework-aws-eventbridge`](../../packages/framework/aws-eventbridge) | AWS EventBridge `PutEvents` producer calls, emits message-bus interactions. | ![](../../.github/badges/coverage-aws-eventbridge.svg) |
| [`@suss/framework-aws-lambda`](../../packages/framework/aws-lambda) | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes. | ![](../../.github/badges/coverage-aws-lambda.svg) |
| [`@suss/framework-flask-restx`](../../packages/framework/flask-restx) | flask-restx `Resource` routes (Python), including a project's own wrapper module that re-exports the route decorator. | ![](../../.github/badges/coverage-flask-restx.svg) |
| [`@suss/framework-fastapi`](../../packages/framework/fastapi) | FastAPI routes (Python): the verb comes from the decorator's own attribute name, `APIRouter` prefixes are composed one `include_router` hop deep, and `response_model` / `status_code` are taken as the declared contract. | ![](../../.github/badges/coverage-fastapi.svg) |
| [`@suss/framework-sqlalchemy`](../../packages/framework/sqlalchemy) | SQLAlchemy calls (Python): says which types a query comes back as and which methods write, and the adapter matches a call chain by resolving through a project's own base class to what the method behind it says it returns. | ![](../../.github/badges/coverage-sqlalchemy.svg) |
| [`@suss/framework-activerecord`](../../packages/framework/activerecord) | ActiveRecord calls (Ruby): a call matches when the constant its receivers start at reaches `ActiveRecord::Base`, following what each class extends through the project. | ![](../../.github/badges/coverage-activerecord.svg) |
| [`@suss/framework-graphql-ruby`](../../packages/framework/graphql-ruby) | graphql-ruby class-based field DSL (Ruby), including `mutation:` / `resolver:` wiring one hop out to what the referenced class itself declares. | ![](../../.github/badges/coverage-graphql-ruby.svg) |

## Clients

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/client-web`](../../packages/client/web) | Global `fetch` call sites. | ![](../../.github/badges/coverage-web.svg) |
| [`@suss/client-axios`](../../packages/client/axios) | axios call sites + `axios.create` factories. | ![](../../.github/badges/coverage-axios.svg) |
| [`@suss/client-apollo`](../../packages/client/apollo) | `@apollo/client` hooks + imperative `client.query`. | ![](../../.github/badges/coverage-apollo-client.svg) |

## Runtimes

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/runtime-node`](../../packages/runtime/node) | Node.js runtime primitives, scheduling, the `process` surface (incl. `process.env.X` config-read interactions), module-loading globals, emitted as interaction effects. | ![](../../.github/badges/coverage-runtime-node.svg) |

## Contract sources

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/contract-openapi`](../../packages/contract/openapi) | OpenAPI 3.x → behavioral summaries. | ![](../../.github/badges/coverage-contract-openapi.svg) |
| [`@suss/contract-graphql`](../../packages/contract/graphql) | Two readers. A plain GraphQL SDL file becomes one resolver-kind summary per Query / Mutation / Subscription field. Committed `.graphql` / `.gql` operation documents become one client-kind summary per operation, with fragment spreads inlined, so a repo that keeps its queries in files pairs against its resolvers without suss having to trace any call site. | ![](../../.github/badges/coverage-contract-graphql.svg) |
| [`@suss/contract-aws-apigateway`](../../packages/contract/aws-apigateway) | API Gateway resource semantics, REST / HTTP API configs → summaries with platform-injected transitions. | ![](../../.github/badges/coverage-contract-aws-apigateway.svg) |
| [`@suss/contract-cloudformation`](../../packages/contract/cloudformation) | CloudFormation / SAM templates → summaries (delegates to contract-openapi + contract-aws-apigateway; also handles SQS event-source mappings + Lambda Environment). | ![](../../.github/badges/coverage-contract-cloudformation.svg) |
| [`@suss/contract-serverless`](../../packages/contract/serverless) | Serverless Framework service files → summaries. The reader restates the functions block in SAM's forms and hands it to contract-cloudformation, so a route, a queue consumer or an environment contract comes out the same whichever manifest language declared it. `${self:}` resolves against the document; a deploy-time reference keeps its token. | ![](../../.github/badges/coverage-contract-serverless.svg) |
| [`@suss/contract-appsync`](../../packages/contract/appsync) | AppSync GraphQL schema + resolver mapping templates. | ![](../../.github/badges/coverage-contract-appsync.svg) |
| [`@suss/contract-storybook`](../../packages/contract/storybook) | Storybook CSF3 stories → component contract summaries. | ![](../../.github/badges/coverage-contract-storybook.svg) |
| [`@suss/contract-prisma`](../../packages/contract/prisma) | Prisma schema → storage provider summaries. | ![](../../.github/badges/coverage-contract-prisma.svg) |
| [`@suss/contract-intent`](../../packages/contract/intent) | Team-authored intent specs (`*.intent` / `*.prd`) → intent summaries. | ![](../../.github/badges/coverage-contract-intent.svg) |

## Manifests

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/manifest-aws`](../../packages/manifest/aws) | Parse CloudFormation / SAM templates into a shared facts layer that contract readers and manifest-driven framework packs both consume. | ![](../../.github/badges/coverage-manifest-aws.svg) |

Adding a framework is one pack file (~100-300 lines of declarative `PatternPack` configuration); adding a contract source is one reader. The IR is protocol-agnostic, so new boundary kinds slot in without architectural change. See [Packs](/packs) for the model and [Write a pack](/guides/writing-a-pack) for the how-to.
