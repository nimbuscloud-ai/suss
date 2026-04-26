# Add suss to an existing project

For full integrations, not the tutorial. Assumes you already have a
TypeScript project with an HTTP boundary, a GraphQL boundary, or a
React component tree.

## What you're setting up

Three things, in order:

1. **Framework packs** — declarative descriptions of how a given
   framework expresses its boundaries (where handlers register,
   how status codes get attached to responses, etc.). One pack per
   framework you use. Without a pack, suss has nothing to
   discover.
2. **Extraction** — running `suss extract` against your source to
   produce the structured summaries. You commit nothing to do
   this; analysis is static.
3. **Pairing** — running `suss check` to compare the summaries
   across boundaries. This is where suss earns its keep: comparing
   provider against consumer, contract against handler, story
   against component.

The output of (2) is a JSON file. The input to (3) is a JSON file
or two. You can stop at (2) if all you want is "what do my
handlers do" — the summaries are useful in their own right.

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
| `@suss/contract-openapi` | Generate summaries from an OpenAPI 3.x spec | `npm i -D @suss/contract-openapi` |
| `@suss/contract-cloudformation` | Generate summaries from a CFN / SAM template | `npm i -D @suss/contract-cloudformation` |
| `@suss/contract-appsync` | Generate summaries from an AppSync CFN template | `npm i -D @suss/contract-appsync` |
| `@suss/contract-storybook` | Generate summaries from CSF3 stories | `npm i -D @suss/contract-storybook` |

Plus the CLI once:

```bash
npm install -D @suss/cli
```

You don't have to install everything. Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client via the contract).
- **Express API + fetch client:** `@suss/framework-express @suss/runtime-web`.
- **React + GraphQL:** `@suss/framework-react @suss/runtime-apollo-client`.
- **GraphQL server:** `@suss/framework-apollo`. Add `@suss/contract-appsync` if you also deploy via CloudFormation.

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
