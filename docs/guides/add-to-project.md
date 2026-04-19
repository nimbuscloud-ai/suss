# Add suss to an existing project

For real integrations, not the tutorial. Assumes you already have
a TypeScript project with an HTTP boundary, a GraphQL boundary,
or a React component tree.

## Install the pieces you need

suss ships as discrete packages. You install one pack per framework
your code uses, plus the CLI. Pick from:

| Pack | What it handles | Install |
|---|---|---|
| `@suss/framework-ts-rest` | ts-rest providers + clients (contract-backed) | `npm i -D @suss/framework-ts-rest` |
| `@suss/framework-express` | Express `app.get(...)` / `router.get(...)` handlers | `npm i -D @suss/framework-express` |
| `@suss/framework-fastify` | Fastify `fastify.get(...)` handlers | `npm i -D @suss/framework-fastify` |
| `@suss/framework-react-router` | React Router v6+ loaders / actions | `npm i -D @suss/framework-react-router` |
| `@suss/framework-react` | React components + event handlers + `useEffect` | `npm i -D @suss/framework-react` |
| `@suss/framework-apollo` | Apollo Server resolvers (code-first) | `npm i -D @suss/framework-apollo` |
| `@suss/runtime-web` | Global `fetch` call sites | `npm i -D @suss/runtime-web` |
| `@suss/runtime-axios` | axios call sites + `axios.create` factories | `npm i -D @suss/runtime-axios` |
| `@suss/runtime-apollo-client` | `@apollo/client` hooks + imperative `client.query` | `npm i -D @suss/runtime-apollo-client` |
| `@suss/stub-openapi` | Generate summaries from an OpenAPI 3.x spec | `npm i -D @suss/stub-openapi` |
| `@suss/stub-cloudformation` | Generate summaries from a CFN / SAM template | `npm i -D @suss/stub-cloudformation` |
| `@suss/stub-appsync` | Generate summaries from an AppSync CFN template | `npm i -D @suss/stub-appsync` |
| `@suss/stub-storybook` | Generate summaries from CSF3 stories | `npm i -D @suss/stub-storybook` |

Plus the CLI once:

```bash
npm install -D @suss/cli
```

You don't have to install everything. Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client via the contract).
- **Express API + fetch client:** `@suss/framework-express @suss/runtime-web`.
- **React + GraphQL:** `@suss/framework-react @suss/runtime-apollo-client`.
- **GraphQL server:** `@suss/framework-apollo`. Add `@suss/stub-appsync` if you also deploy via CloudFormation.

## Point suss at your tsconfig

`suss extract` reads your `tsconfig.json` to get the same type
resolution your compiler sees. Use the tsconfig that matches the
source you want analyzed — often the app's `tsconfig.json`, but
for monorepos you'll typically run it per-package.

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

Findings print to stdout; non-zero exit code when there are
errors. Flags:

- `--fail-on warning` — treat warnings as errors for exit code purposes
- `--json` — emit findings as JSON (useful in CI; see the
  [CI guide](/guides/ci-integration))

## Add a third-party spec

When you consume an API you don't own (Stripe, an internal team,
a third-party), pull its OpenAPI spec into the same shape:

```bash
npx suss stub --from openapi stripe-openapi.json -o summaries/stripe.json
npx suss check summaries/stripe.json summaries/your-client.json
```

AWS API Gateway? CloudFormation stub reads the template:

```bash
npx suss stub --from cloudformation template.yaml -o summaries/api.json
```

GraphQL via AppSync? Same idea:

```bash
npx suss stub --from appsync template.yaml -o summaries/appsync.json
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
