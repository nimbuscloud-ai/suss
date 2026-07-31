# Packages

suss ships as `@suss/cli` plus opt-in packs for the frameworks, runtimes, and contract sources a project uses. Install the CLI and only the packs you need; nothing pulls in the whole set.

## Install by stack

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/client-axios
```

Common combinations:

| Stack | Packs |
|---|---|
| ts-rest full-stack | `@suss/framework-ts-rest` (provider + client through the contract) |
| Express + fetch | `@suss/framework-express @suss/client-web` |
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
| [`@suss/behavioral-ir`](../../packages/ir) | zod schemas, types, parsers, and generated [JSON Schema](../../packages/ir/schema/behavioral-summary.schema.json). Install this to consume summaries. | ![](../../.github/badges/coverage-ir.svg) |
| [`@suss/intent-ir`](../../packages/intent-ir) | Team-authored intent: system intent (what a boundary should do) + PRD outcome intent, paired against derived summaries. | ![](../../.github/badges/coverage-intent-ir.svg) |
| [`@suss/datalog`](../../packages/datalog) | Small semi-naive Datalog evaluator with stratified negation; the rules engine behind derived program facts. | ![](../../.github/badges/coverage-datalog.svg) |
| [`@suss/extractor`](../../packages/extractor) | Assembly engine. Converts raw extracted structure into `BehavioralSummary`. | ![](../../.github/badges/coverage-extractor.svg) |
| [`@suss/adapter-typescript`](../../packages/adapter/typescript) | TypeScript language adapter via ts-morph. | ![](../../.github/badges/coverage-typescript.svg) |
| [`@suss/checker`](../../packages/checker) | Pairwise cross-boundary checker (behavioral). | ![](../../.github/badges/coverage-checker.svg) |
| [`@suss/checker-intent`](../../packages/checker-intent) | Pairs team-authored intent against derived code; emits `IntentFinding` coverage. | ![](../../.github/badges/coverage-checker-intent.svg) |
| [`@suss/cli`](../../packages/cli) | CLI wrapper. | ![](../../.github/badges/coverage-cli.svg) |

## Frameworks

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/framework-ts-rest`](../../packages/framework/ts-rest) | ts-rest providers + clients (contract-backed). | ![](../../.github/badges/coverage-ts-rest.svg) |
| [`@suss/framework-express`](../../packages/framework/express) | Express handlers. | ![](../../.github/badges/coverage-express.svg) |
| [`@suss/framework-fastify`](../../packages/framework/fastify) | Fastify handlers. | ![](../../.github/badges/coverage-fastify.svg) |
| [`@suss/framework-react`](../../packages/framework/react) | React function components, event handlers, `useEffect` bodies. | ![](../../.github/badges/coverage-react.svg) |
| [`@suss/framework-react-router`](../../packages/framework/react-router) | React Router loaders / actions / routes. | ![](../../.github/badges/coverage-react-router.svg) |
| [`@suss/framework-apollo`](../../packages/framework/apollo) | Apollo Server resolvers (code-first). | ![](../../.github/badges/coverage-apollo.svg) |
| [`@suss/framework-nestjs-rest`](../../packages/framework/nestjs-rest) | NestJS REST controllers. | ![](../../.github/badges/coverage-nestjs-rest.svg) |
| [`@suss/framework-nestjs-graphql`](../../packages/framework/nestjs-graphql) | NestJS GraphQL resolvers. | ![](../../.github/badges/coverage-nestjs-graphql.svg) |
| [`@suss/framework-prisma`](../../packages/framework/prisma) | Prisma client calls, emits storage-access interactions per read / write. | ![](../../.github/badges/coverage-prisma.svg) |
| [`@suss/framework-drizzle`](../../packages/framework/drizzle) | Drizzle ORM query-builder and relational-query calls, emits storage-access interactions with SQL table names. | ![](../../.github/badges/coverage-drizzle.svg) |
| [`@suss/framework-aws-sqs`](../../packages/framework/aws-sqs) | AWS SDK v3 SQS producer calls, emits message-send interactions. | ![](../../.github/badges/coverage-aws-sqs.svg) |
| [`@suss/framework-aws-eventbridge`](../../packages/framework/aws-eventbridge) | AWS EventBridge `PutEvents` producer calls, emits message-bus interactions. |, |
| [`@suss/framework-aws-lambda`](../../packages/framework/aws-lambda) | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes. |, |

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
| [`@suss/contract-graphql`](../../packages/contract/graphql) | Plain GraphQL SDL → resolver-kind summaries (Query / Mutation / Subscription fields). | ![](../../.github/badges/coverage-contract-graphql.svg) |
| [`@suss/contract-aws-apigateway`](../../packages/contract/aws-apigateway) | API Gateway resource semantics, REST / HTTP API configs → summaries with platform-injected transitions. | ![](../../.github/badges/coverage-contract-aws-apigateway.svg) |
| [`@suss/contract-cloudformation`](../../packages/contract/cloudformation) | CloudFormation / SAM templates → summaries (delegates to contract-openapi + contract-aws-apigateway; also handles SQS event-source mappings + Lambda Environment). | ![](../../.github/badges/coverage-contract-cloudformation.svg) |
| [`@suss/contract-appsync`](../../packages/contract/appsync) | AppSync GraphQL schema + resolver mapping templates. | ![](../../.github/badges/coverage-contract-appsync.svg) |
| [`@suss/contract-storybook`](../../packages/contract/storybook) | Storybook CSF3 stories → component contract summaries. | ![](../../.github/badges/coverage-contract-storybook.svg) |
| [`@suss/contract-prisma`](../../packages/contract/prisma) | Prisma schema → storage provider summaries. | ![](../../.github/badges/coverage-contract-prisma.svg) |
| [`@suss/contract-intent`](../../packages/contract/intent) | Team-authored intent specs (`*.intent` / `*.prd`) → intent summaries. | ![](../../.github/badges/coverage-contract-intent.svg) |

## Manifests

| Package | Description | Coverage |
|---------|-------------|----------|
| [`@suss/manifest-aws`](../../packages/manifest/aws) | Parse CloudFormation / SAM templates into a shared facts layer that contract readers and manifest-driven framework packs both consume. |, |

Adding a framework is one pack file (~100-300 lines of declarative `PatternPack` configuration); adding a contract source is one reader. The IR is protocol-agnostic, so new boundary kinds slot in without architectural change. See [Packs](/packs) for the model and [Write a pack](/guides/writing-a-pack) for the how-to.
