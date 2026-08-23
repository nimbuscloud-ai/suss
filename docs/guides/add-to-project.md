# Add suss to a project

Point suss at a repo you already have and get something you can act on
out of the first run: which of your queries disagree with the schema
they run against, which of your callers miss a status their provider
returns. You annotate nothing first and you start nothing, and the only
thing written to disk is a folder of summary files.

For a Python or Ruby project, start at
[Read a Python or Ruby project](/guides/python-and-ruby), which covers
the same ground for those two languages.

## The first run

```bash
npx @suss/cli init
```

`init` reads your `package.json`, looks for schemas and deploy
templates on disk, and offers to install the packs for what it found.
Here it is on
[gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app):

```
✓ Found 4 things to read in node-express-realworld-example-app

  Your code
    express          express in dependencies
    axios            axios in dependencies

  What your code reaches
    prisma           @prisma/client in dependencies

  Declared contracts
    prisma           a Prisma schema at src/prisma/schema.prisma
```

Then it walks you through the rest, one question at a time:

- **Install N packages as devDependencies?** Defaults to yes. If npm
  fails, it stops there, prints what npm said, and leaves you the
  command to run.
- **Read the code now and compare what it finds?** Defaults to yes, and
  runs the `extract`, `contract`, and `check` commands for you.
- **Add a `.sussignore` for findings you decide to accept?** Defaults to
  no.
- **Add a GitHub Actions workflow that runs this on every pull
  request?** Defaults to no.

Nothing reaches disk unless you accept it.

Run piped, in CI, or with `--plain`, `init` prints the commands instead
of asking:

```bash
npx @suss/cli init --plain
```

```
1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract -f express -f axios -f prisma -o summaries/code.json
   suss contract --from prisma src/prisma/schema.prisma -o summaries/prisma.json

3. Compare them

   suss check --dir summaries/
```

On this repo those commands produce 46 summaries from the source, 4
from the Prisma schema, and three warnings about fields the schema
declares that no query ever asks for. The
[Get started walkthrough](/tutorial/get-started) goes through that
output line by line.

Three pieces, in order: a **pack** per library you want read, an
**extract** that writes down what each unit does, and a **check** that
compares the summaries on either side of each boundary. Extract is
useful on its own if all you want is a description of what your
handlers do.

### In a monorepo

At a repo root, `init` reads the workspace declaration, from
`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`, or
`turbo.json`, and then asks which packages to set up:

```
◆  Which should suss set up?
│  ◼ @acme/auth        aws-lambda, cloudformation
│  ◼ @acme/web         react, apollo-client
│  ◻ @acme/tooling     node
```

One thing to know before you check several services at once: suss tells
HTTP boundaries apart by method and path alone, so two services that
both serve `GET /users` look like a single boundary. See
[Compatibility](/reference/compatibility#several-services-in-one-folder).

## When the first run turns up nothing

Every command that comes up empty says where it stopped. These four
cover most first runs.

### That tsconfig matched no source files

```
No summaries to write in 0.00s.
  That tsconfig matched no source files.
  Check its `include` and `files` patterns against where your source actually lives.

  Where it stopped:
    0  files in the tsconfig
    0  files read
```

suss took the nearest `tsconfig.json`, and that one covers no source.
Nx, project references, and solution-style configs all do this: the
root config lists `"files": []` and points at the configs that do the
work. Pass the one that covers your source:

```bash
npx suss extract -p tsconfig.app.json -f express -o summaries/code.json
```

### No file imports anything the pack looks for

```
No summaries to write in 0.02s.
  No file imports anything hono looks for.
  Either this project does not use it, or your code reaches it through a local wrapper module. suss only recognizes direct imports today.

  Where it stopped:
    26  files in the tsconfig
     0  files read
     0  files importing hono and @hono/zod-openapi
```

The tsconfig is right and the pack is wrong for this project. Re-run
`init` to see which packs match your dependencies. If the library is in
`package.json` but your code imports a wrapper module of your own
rather than the library directly, suss stops at the wrapper.

### A pack found the library and matched nothing

```
Wrote 46 summaries to summaries/code.json in 0.60s

Pack health:
  a pack dropped everything it was holding
    prisma: its import gate found the library and it matched nothing in the bodies it saw (20 unit bodies to look inside, 0 effects recognized)
```

The run succeeded and one pack contributed nothing to it. The usual
cause is a library that is installed but not yet in a usable state.
Prisma is the common one: `@prisma/client` is in `node_modules`, but
until `npx prisma generate` runs, the package exports no model types,
so every `prisma.article.findUnique` call is treated as a call on an opaque
value and the pack classifies none of them.

```bash
npx prisma generate
npx suss extract -p tsconfig.app.json -f express -f prisma -o summaries/code.json
```

Anything with a codegen step behaves the same way: run the generator
first, then extract. The pack-health block appears whenever a pack you
asked for contributes nothing, so it is the line to read before you
conclude that suss cannot see your storage layer.

### Nothing was compared

```
Nothing was compared.

  These summaries cover 20 boundaries on the provider side and none on the client side, so there was no other side to compare against.
  Extract both sides of the boundary into the same folder, then check them together:
    suss extract -p <tsconfig> -f <pack> -o summaries/<name>.json
    suss check --dir summaries/

  26 boundaries had nothing to pair with, so nothing was checked across them.
```

`check` compares two sides, so one side on its own gives it nothing to
do. Twenty Express routes with no `fetch` or axios call sites beside
them means the callers were never extracted, either because they live
in a separate repository or because the pack that reads them was left
off the command.

Extract the other side into the same folder and check them together:

```bash
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

Where the other side is a schema or a spec rather than code, `contract`
produces it in the same format. A Prisma schema becomes the provider
for your query call sites, an OpenAPI document becomes the provider for
your client:

```bash
npx suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
npx suss check --dir summaries/
```

Where the front end really does live in another repository, extract it
there and copy its summary file in. Summaries are portable JSON, and
`check --dir` pairs whatever it reads in a folder regardless of which
run produced it.

## Reading a run that did compare something

`check --dir` prints a count of what it left out as well as what it
found:

```
Compared 4 boundaries.

  20 provider-side boundaries have no client to compare against.
  5 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.
```

`--all` lists every pair it made and every boundary it skipped, which
is how you find out whether "no findings" means agreement or means
nothing got compared. `--at src/dao.ts:43` narrows a run to one file,
line, boundary, or summary.

## Which packs to install

suss ships as discrete packages. You install one pack per library you
want read, plus the CLI. `init` picks these for you; the table is for
when you want to choose by hand.

| Pack | What it handles | Install |
|---|---|---|
| `@suss/framework-ts-rest` | ts-rest providers + clients (contract-backed) | `npm i -D @suss/framework-ts-rest` |
| `@suss/framework-express` | Express `app.get(...)` / `router.get(...)` handlers | `npm i -D @suss/framework-express` |
| `@suss/framework-fastify` | Fastify `fastify.get(...)` handlers | `npm i -D @suss/framework-fastify` |
| `@suss/framework-hono` | Hono `app.get(...)` handlers, including `c.json(body, status)` | `npm i -D @suss/framework-hono` |
| `@suss/framework-nextjs` | Next.js route handlers and pages; the route comes from where the file is | `npm i -D @suss/framework-nextjs` |
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
| `@suss/contract-serverless` | Serverless Framework service files → summaries, read through the same structures the CFN reader handles | `npm i -D @suss/contract-serverless` |
| `@suss/contract-appsync` | AppSync schema + resolver mapping templates → summaries | `npm i -D @suss/contract-appsync` |
| `@suss/contract-storybook` | Storybook CSF3 stories → component contract summaries | `npm i -D @suss/contract-storybook` |
| `@suss/contract-prisma` | Prisma schema → storage provider summaries | `npm i -D @suss/contract-prisma` |
| `@suss/contract-intent` | Team-authored `*.intent` / `*.prd` docs, read by `suss check --intent` | `npm i -D @suss/contract-intent` |

Plus the CLI once:

```bash
npm install -D @suss/cli
```

Common combinations:

- **ts-rest full-stack:** `@suss/framework-ts-rest` (provider + client through the contract).
- **Express API + fetch client:** `@suss/framework-express @suss/client-web`.
- **React + GraphQL:** `@suss/framework-react @suss/client-apollo`.
- **GraphQL server:** `@suss/framework-apollo`. Add `@suss/contract-appsync` if you also deploy via CloudFormation.
- **Lambda + SQS + Postgres:** `@suss/framework-aws-sqs @suss/framework-prisma @suss/runtime-node @suss/contract-cloudformation @suss/contract-prisma`. The CloudFormation reader picks up the env var on the producer side and resolves it to the queue resource. Prisma's schema becomes the storage provider summaries, and those pair with the query call sites read out of your source.

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
works out which language it is reading from what the directory contains
(`pyproject.toml`, `requirements.txt`, a `Gemfile`, or the source
files themselves), and `--lang` lets you say which language it is when
you would rather not leave it to that.

```bash
# FastAPI and flask-restx routes
npx suss extract --lang python --dir services/orders -f fastapi -o summaries/orders.json

# graphql-ruby fields
npx suss extract --lang ruby --dir . -f graphql-ruby=suss.graphql-ruby.json -o summaries/schema.json
```

Two of these packs need a sentence about your project before they can
read it. The built-in TypeScript packs never do. graphql-ruby needs the
directory a `mutation:` or `resolver:` field's class is looked up
under, and it reads nothing without one:

```json
{ "root": "app/graphql" }
```

A relative path here is read relative to the config file itself, so a
config file that lives beside `app/` means the same directory whichever
directory you run the command from.

flask-restx and fastapi take an optional `wrapperModules`, the modules
your own code re-exports the route decorator or the router constructor
from. The library's own module is always read, so leave this out if
your routes import from it directly:

```json
{ "wrapperModules": ["myapp.wrappers.restx"] }
```

Write either to a JSON file and give the file name on the flag:
`-f flask-restx=suss.flask-restx.json`.

If your service imports a shared framework from a git submodule, check
the submodule out before extracting. suss reads `.gitmodules`, treats
each submodule as part of this project, and resolves imports into it.
An empty one gets a line saying so, because the routes that depend on
it would otherwise go missing with no explanation.

## Pair them

```bash
# Two explicit files
npx suss check summaries/provider.json summaries/consumer.json

# A whole directory, auto-pairs by (method, normalized path)
npx suss check --dir summaries/
```

`check` reads the JSON files, groups summaries into provider /
consumer pairs by their boundary key (e.g. `(GET, /users/:id)`),
and runs each pair through the agreement checks. It prints a list
of findings, and each one gives the boundary, both sides, and what
disagrees. There's no aggregate score. Every finding is a concrete
fact about one pair, and you can act on it.

Findings print to stdout, and the command exits non-zero when there
are errors. Flags:

- `--fail-on warning`: treat warnings as errors for exit code purposes
- `--json`: emit findings as JSON (useful in CI; see the
  [CI guide](/guides/ci-integration))

## Add a third-party spec

When you consume an API you don't own (Stripe, an internal team,
a third-party), you don't have the source, so `extract` can't run
on it. Instead, run `contract` over the API's specification. It
produces summaries in the same format as `extract`'s output,
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

The summaries themselves are derived artifacts, so you don't need
to check them in. Most projects commit a `.suss/` directory only
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
