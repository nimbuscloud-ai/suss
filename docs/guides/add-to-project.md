# Add suss to an existing project

Assumes a TypeScript project with at least one boundary suss recognises
— an HTTP handler, a GraphQL resolver, a React component tree, a queue
producer, a Prisma call, or a `process.env` access.

## What you're setting up

Three pieces, in order:

1. **Framework / runtime / contract packs.** Declarative descriptions
   of how a given framework expresses its boundaries (where handlers
   register, how status codes attach to responses, what counts as a
   storage call, how an env var resolves to a CFN resource). One pack
   per framework + runtime + contract source you want covered. Without
   a pack, suss has nothing to discover.
2. **Extraction.** `suss extract` walks your source and emits the
   structured summaries. Static analysis only — nothing runs.
3. **Pairing.** `suss check` compares summaries across boundaries:
   provider against consumer, contract against handler, story against
   component, producer against consumer, schema against query call.

The output of (2) is a JSON file. The input to (3) is one or more JSON
files. (2) is useful on its own if all you want is a structured
description of what your handlers do.

## Install the pieces you need

suss ships as discrete packages. You install one pack per framework
your code uses, plus the CLI. Pick from:

| Pack | What it handles | Install |
|---|---|---|
| `@suss/framework-ts-rest` | ts-rest providers + clients (contract-backed) | `npm i -D @suss/framework-ts-rest` |
| `@suss/framework-express` | Express `app.get(...)` / `router.get(...)` handlers | `npm i -D @suss/framework-express` |
| `@suss/framework-fastify` | Fastify `fastify.get(...)` handlers | `npm i -D @suss/framework-fastify` |
| `@suss/framework-nestjs-rest` | NestJS REST controllers (`@Controller` / `@Get`) | `npm i -D @suss/framework-nestjs-rest` |
| `@suss/framework-nestjs-graphql` | NestJS GraphQL resolvers (`@Resolver` / `@Query` / `@Mutation`) | `npm i -D @suss/framework-nestjs-graphql` |
| `@suss/framework-react-router` | React Router v6+ loaders / actions | `npm i -D @suss/framework-react-router` |
| `@suss/framework-react` | React components + event handlers + `useEffect` | `npm i -D @suss/framework-react` |
| `@suss/framework-apollo` | Apollo Server resolvers (code-first) | `npm i -D @suss/framework-apollo` |
| `@suss/framework-prisma` | Prisma client calls — emits storage-access interactions | `npm i -D @suss/framework-prisma` |
| `@suss/framework-aws-sqs` | AWS SDK v3 SQS producer calls — emits message-send interactions | `npm i -D @suss/framework-aws-sqs` |
| `@suss/framework-process-env` | `process.env.X` access — emits config-read interactions | `npm i -D @suss/framework-process-env` |
| `@suss/client-web` | Global `fetch` call sites | `npm i -D @suss/client-web` |
| `@suss/client-axios` | axios call sites + `axios.create` factories | `npm i -D @suss/client-axios` |
| `@suss/client-apollo` | `@apollo/client` hooks + imperative `client.query` | `npm i -D @suss/client-apollo` |
| `@suss/contract-openapi` | OpenAPI 3.x spec → provider summaries | `npm i -D @suss/contract-openapi` |
| `@suss/contract-aws-apigateway` | API Gateway REST/HTTP API resource semantics → summaries | `npm i -D @suss/contract-aws-apigateway` |
| `@suss/contract-cloudformation` | CFN / SAM templates → summaries (delegates to OpenAPI + API Gateway; also reads SQS event-source mappings + Lambda Environment) | `npm i -D @suss/contract-cloudformation` |
| `@suss/contract-appsync` | AppSync schema + resolver mapping templates → summaries | `npm i -D @suss/contract-appsync` |
| `@suss/contract-storybook` | Storybook CSF3 stories → component contract summaries | `npm i -D @suss/contract-storybook` |
| `@suss/contract-prisma` | Prisma schema → storage provider summaries | `npm i -D @suss/contract-prisma` |

Plus the CLI once:

```bash
npm install -D @suss/cli
```

You don't have to install everything. Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client through the contract).
- **Express API + fetch client:** `@suss/framework-express @suss/client-web`.
- **React + GraphQL:** `@suss/framework-react @suss/client-apollo`.
- **GraphQL server:** `@suss/framework-apollo`. Add `@suss/contract-appsync` if you also deploy via CloudFormation.
- **Lambda + SQS + Postgres:** `@suss/framework-aws-sqs @suss/framework-prisma @suss/framework-process-env @suss/contract-cloudformation @suss/contract-prisma`. CFN reads the producer-side env var and resolves it to the queue resource; Prisma's schema becomes the storage provider summaries that pair with the source-extracted query call sites.

## Point suss at your tsconfig

`suss extract` reads your `tsconfig.json` to get the same type
resolution your compiler sees — same `paths` aliases, same
`moduleResolution`, same `lib` set. Without that, references that
cross package boundaries (`@app/lib/db`, monorepo workspace
imports) wouldn't resolve and most type information would be lost.

Use the tsconfig that matches the source you want analyzed —
often the app's `tsconfig.json`, but for monorepos you'll
typically run it per-package.

```bash
# Provider side: ts-rest handlers
npx suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json

# Consumer side: axios clients
npx suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json
```

`-f` can be repeated to run multiple packs in one invocation:

```bash
npx suss extract -p tsconfig.json -f ts-rest -f axios -o summaries/all.json
```

## Pair them

```bash
# Two explicit files
npx suss check summaries/provider.json summaries/consumer.json

# A whole directory — auto-pairs by (method, normalized path)
npx suss check --dir summaries/
```

`check` reads the JSON files, groups summaries into provider /
consumer pairs by their boundary key (e.g. `(GET, /users/:id)`),
and runs each pair through the agreement checks. Output is a list
of findings naming the boundary, both sides, and what disagrees.
There's no aggregate score — every finding is a concrete pair-level
fact you can act on.

Findings print to stdout; non-zero exit code when there are
errors. Flags:

- `--fail-on warning` — treat warnings as errors for exit code purposes
- `--json` — emit findings as JSON (useful in CI; see the
  [CI guide](/guides/ci-integration))

## Add a third-party spec

When you consume an API you don't own (Stripe, an internal team,
a third-party), you don't have the source — so `extract` can't run
on it. Instead, run `stub` over the API's specification. Stubs are
summaries with the same shape as `extract`'s output, declared
behavior rather than derived: "this is what the spec says
happens." Once a stub exists, `check` pairs it with your client
the same way it would pair two extracted summaries.

```bash
npx suss contract --from openapi stripe-openapi.json -o summaries/stripe.json
npx suss check summaries/stripe.json summaries/your-client.json
```

AWS API Gateway? CloudFormation stub reads the template:

```bash
npx suss contract --from cloudformation template.yaml -o summaries/api.json
```

GraphQL via AppSync? Same idea:

```bash
npx suss contract --from appsync template.yaml -o summaries/appsync.json
```

## Commit or not?

The summaries themselves are derived artifacts — you don't need
them checked in. Most projects commit a `.suss/` directory only
if they're publishing summaries for downstream consumers
(library authors shipping summaries alongside their package).

For a normal app, run extract + check as a CI step
([guide](/guides/ci-integration)) and keep summary files out of
the repo.

## What you can skip

- **You don't need to build the app.** suss reads TypeScript
  source via ts-morph. If your code compiles, suss can read it.
- **You don't need a runtime.** No dev server to start, no Docker
  containers. All analysis is static.
- **You don't need every pack.** Start with one pair
  (provider + consumer), add more when a new boundary gets
  interesting.
