# Add suss to an existing project

Assumes a TypeScript project with at least one boundary suss
recognises: an HTTP handler, a GraphQL resolver, a React component
tree, a queue producer, a Prisma call, or a `process.env` access. For a
Python or Ruby project, start at
[Read a Python or Ruby project](/guides/python-and-ruby) instead.

## What you're setting up

Three pieces, in order:

1. **Framework / runtime / contract packs.** Declarative descriptions
   of how a given framework expresses its boundaries (where handlers
   register, how status codes attach to responses, what counts as a
   storage call, how an env var resolves to a CFN resource). One pack
   per framework + runtime + contract source you want covered. Without
   a pack, suss has nothing to discover.
2. **Extraction.** `suss extract` walks your source and emits the
   structured summaries. Static analysis only, nothing runs.
3. **Pairing.** `suss check` compares summaries across boundaries:
   provider against consumer, contract against handler, story against
   component, producer against consumer, schema against query call.

The output of (2) is a JSON file. The input to (3) is one or more JSON
files. (2) is useful on its own if all you want is a structured
description of what your handlers do.

## Let suss set it up

```bash
npx @suss/cli init
```

It reads your `package.json`, looks for schemas and templates on disk,
and offers to do the rest:

```
┌  suss init
│
◇  Found ────────────────────────────────────────────╮
│                                                    │
│  aws-sqs          @aws-sdk/client-sqs in deps      │
│  aws-lambda       @types/aws-lambda in devDeps     │
│  cloudformation   a SAM template at template.yaml  │
│                                                    │
├────────────────────────────────────────────────────╯
│
◇  Install 4 packages as devDependencies?
│  ● Yes / ○ No
│
◇  Installed 4 packages
│
◇  Read the code now and compare what it finds?
│  ● Yes / ○ No
│
◇  suss extract -f aws-sqs -f aws-lambda -o summaries/code.json
◇  suss contract --from cloudformation template.yaml -o summaries/cloudformation.json
◇  suss check --dir summaries/
│
◆  Add a .sussignore for findings you decide to accept?
│  ○ Yes / ● No
│
◆  Add a GitHub Actions workflow that runs this on every pull request?
│  ○ Yes / ● No
│
└  Done. Re-run `suss check --dir summaries/` whenever code changes.
```

Installing defaults to yes. Writing `.sussignore` and the CI workflow
both default to no, and nothing reaches disk unless you accept it. If
the install fails, it stops there, prints what npm said, and leaves the
command behind rather than carrying on.

### In a monorepo

At a repo root it reads the workspace declaration, from `package.json`
workspaces, `pnpm-workspace.yaml`, `lerna.json`, or `turbo.json`, then
asks which packages to set up:

```
◆  Which should suss set up?
│  ◼ @acme/auth        aws-lambda, cloudformation
│  ◼ @acme/web         react, apollo-client
│  ◻ @acme/tooling     node
```

Worth knowing before you check several services at once: suss tells
HTTP boundaries apart by method and path alone, so two services both
serving `GET /users` read as one. See
[Compatibility](/reference/compatibility#several-services-in-one-folder).

### Without a terminal

Piped, or in CI, or with `--plain`, it prints the commands instead of
asking:

```bash
npx @suss/cli init --plain
```

The rest of this page is the same thing done by hand.

## Install the pieces you need

suss ships as discrete packages. You install one pack per framework
your code uses, plus the CLI. Pick from:

| Pack | What it handles | Install |
|---|---|---|
| `@suss/framework-ts-rest` | ts-rest providers + clients (contract-backed) | `npm i -D @suss/framework-ts-rest` |
| `@suss/framework-express` | Express `app.get(...)` / `router.get(...)` handlers | `npm i -D @suss/framework-express` |
| `@suss/framework-fastify` | Fastify `fastify.get(...)` handlers | `npm i -D @suss/framework-fastify` |
| `@suss/framework-hono` | Hono `app.get(...)` handlers, including `c.json(body, status)` | `npm i -D @suss/framework-hono` |
| `@suss/framework-nextjs` | Next.js route handlers and pages; the route comes from where the file sits | `npm i -D @suss/framework-nextjs` |
| `@suss/framework-nestjs-rest` | NestJS REST controllers (`@Controller` / `@Get`) | `npm i -D @suss/framework-nestjs-rest` |
| `@suss/framework-nestjs-graphql` | NestJS GraphQL resolvers (`@Resolver` / `@Query` / `@Mutation`) | `npm i -D @suss/framework-nestjs-graphql` |
| `@suss/framework-react-router` | React Router v6+ loaders / actions | `npm i -D @suss/framework-react-router` |
| `@suss/framework-react` | React components + event handlers + `useEffect` | `npm i -D @suss/framework-react` |
| `@suss/framework-apollo` | Apollo Server resolvers (code-first) | `npm i -D @suss/framework-apollo` |
| `@suss/framework-aws-lambda` | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes | `npm i -D @suss/framework-aws-lambda` |
| `@suss/framework-prisma` | Prisma client calls, emits storage-access interactions | `npm i -D @suss/framework-prisma` |
| `@suss/framework-drizzle` | Drizzle query-builder and relational-query calls, with SQL table names | `npm i -D @suss/framework-drizzle` |
| `@suss/framework-aws-sqs` | AWS SDK v3 SQS producer calls, emits message-send interactions | `npm i -D @suss/framework-aws-sqs` |
| `@suss/framework-aws-eventbridge` | EventBridge `PutEvents` calls, emits message-bus interactions | `npm i -D @suss/framework-aws-eventbridge` |
| `@suss/runtime-node` | Node runtime surface, scheduling, `process.*` (incl. `process.env.X` config-read interactions), module-loading globals | `npm i -D @suss/runtime-node` |
| `@suss/client-web` | Global `fetch` call sites | `npm i -D @suss/client-web` |
| `@suss/client-axios` | axios call sites + `axios.create` factories | `npm i -D @suss/client-axios` |
| `@suss/client-apollo` | `@apollo/client` hooks + imperative `client.query` | `npm i -D @suss/client-apollo` |
| `@suss/contract-openapi` | OpenAPI 3.x spec → provider summaries | `npm i -D @suss/contract-openapi` |
| `@suss/contract-graphql` | GraphQL SDL → resolver summaries, and committed `.graphql` operation documents → client summaries | `npm i -D @suss/contract-graphql` |
| `@suss/contract-aws-apigateway` | API Gateway REST/HTTP API resource semantics → summaries | `npm i -D @suss/contract-aws-apigateway` |
| `@suss/contract-cloudformation` | CFN / SAM templates → summaries (delegates to OpenAPI + API Gateway; also reads SQS event-source mappings + Lambda Environment) | `npm i -D @suss/contract-cloudformation` |
| `@suss/contract-serverless` | Serverless Framework service files → summaries, through the same shapes the CFN reader handles | `npm i -D @suss/contract-serverless` |
| `@suss/contract-appsync` | AppSync schema + resolver mapping templates → summaries | `npm i -D @suss/contract-appsync` |
| `@suss/contract-storybook` | Storybook CSF3 stories → component contract summaries | `npm i -D @suss/contract-storybook` |
| `@suss/contract-prisma` | Prisma schema → storage provider summaries | `npm i -D @suss/contract-prisma` |
| `@suss/contract-intent` | Team-authored `*.intent` / `*.prd` docs, read by `suss check --intent` | `npm i -D @suss/contract-intent` |

Plus the CLI once:

```bash
npm install -D @suss/cli
```

You don't have to install everything. Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client through the contract).
- **Express API + fetch client:** `@suss/framework-express @suss/client-web`.
- **React + GraphQL:** `@suss/framework-react @suss/client-apollo`.
- **GraphQL server:** `@suss/framework-apollo`. Add `@suss/contract-appsync` if you also deploy via CloudFormation.
- **Lambda + SQS + Postgres:** `@suss/framework-aws-sqs @suss/framework-prisma @suss/runtime-node @suss/contract-cloudformation @suss/contract-prisma`. CFN reads the producer-side env var and resolves it to the queue resource; Prisma's schema becomes the storage provider summaries that pair with the source-extracted query call sites.

## Point suss at your tsconfig

`suss extract` reads your `tsconfig.json` to get the same type
resolution your compiler sees, same `paths` aliases, same
`moduleResolution`, same `lib` set. Without that, references that
cross package boundaries (`@app/lib/db`, monorepo workspace
imports) wouldn't resolve and most type information would be lost.

Use the tsconfig that matches the source you want analyzed, usually
the app's `tsconfig.json`, but for monorepos you'll
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

## A Python or Ruby project

There is no tsconfig to point at, so point suss at the directory. It
works out which language it is reading from what the directory holds
(`pyproject.toml`, `requirements.txt`, a `Gemfile`, or the source
files themselves), and `--lang` says so outright when you would rather
not leave it to that.

```bash
# FastAPI and flask-restx routes
npx suss extract --lang python --dir services/orders -f fastapi -o summaries/orders.json

# graphql-ruby fields
npx suss extract --lang ruby --dir . -f graphql-ruby=suss.graphql-ruby.json -o summaries/schema.json
```

Two of these packs need a sentence about your project before they can
read it, which the built-in TypeScript packs never do. graphql-ruby
needs the directory a `mutation:` or `resolver:` field's class is
looked up under, and it reads nothing without one:

```json
{ "root": "app/graphql" }
```

flask-restx and fastapi take an optional `wrapperModules`, the modules
your own code re-exports the route decorator or the router constructor
from. The library's own module is always read, so leave this out if
your routes import from it directly:

```json
{ "wrapperModules": ["myapp.wrappers.restx"] }
```

Write either to a JSON file and name it on the flag:
`-f flask-restx=suss.flask-restx.json`.

If your service imports a shared framework from a git submodule, check
the submodule out before extracting. suss reads `.gitmodules`, treats
each submodule as part of this project, and resolves imports into it;
an empty one gets a line saying so, because the routes that depend on
it would otherwise go missing without explanation.

## Pair them

```bash
# Two explicit files
npx suss check summaries/provider.json summaries/consumer.json

# A whole directory, auto-pairs by (method, normalized path)
npx suss check --dir summaries/
```

`check` reads the JSON files, groups summaries into provider /
consumer pairs by their boundary key (e.g. `(GET, /users/:id)`),
and runs each pair through the agreement checks. Output is a list
of findings naming the boundary, both sides, and what disagrees.
There's no aggregate score, every finding is a concrete pair-level
fact you can act on.

Findings print to stdout; non-zero exit code when there are
errors. Flags:

- `--fail-on warning`: treat warnings as errors for exit code purposes
- `--json`: emit findings as JSON (useful in CI; see the
  [CI guide](/guides/ci-integration))

## Add a third-party spec

When you consume an API you don't own (Stripe, an internal team,
a third-party), you don't have the source, so `extract` can't run
on it. Instead, run `contract` over the API's specification. It
produces summaries with the same shape as `extract`'s output,
describing what the spec says happens. Once the contract summary
exists, `check` pairs it with your client the same way it would
pair two extracted summaries.

```bash
npx suss contract --from openapi stripe-openapi.json -o summaries/stripe.json
npx suss check summaries/stripe.json summaries/your-client.json
```

AWS API Gateway? The CloudFormation contract reader reads the template:

```bash
npx suss contract --from cloudformation template.yaml -o summaries/api.json
```

GraphQL via AppSync? Same idea:

```bash
npx suss contract --from appsync template.yaml -o summaries/appsync.json
```

## Commit or not?

The summaries themselves are derived artifacts, you don't need
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
