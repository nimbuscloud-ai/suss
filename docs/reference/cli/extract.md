---
title: suss extract
description: Read TypeScript, Python or Ruby source into behavioral summaries, with every flag and every built-in pack name.
---

# `suss extract`

Extract behavioral summaries from source.

Python and Ruby have adapters of their own, and this command reaches
them: it works out which language a directory contains, and `--lang`
lets you state it directly. See
[Read Python or Ruby](/guides/python-and-ruby).

**What it does.** It walks every function the framework pack discovers
(`loader` in React Router, `app.get(...)` in Express, etc.), folds
its branches and terminals into a decision tree, and emits one
`BehavioralSummary` per discovered unit. It never runs your code, and
you never annotate it.

```
suss extract [-p TSCONFIG | --dir DIR] [--lang typescript|python|ruby]
             [-f FRAMEWORK ...]
             [-o OUTPUT] [--files FILE ...]
             [--gaps strict|permissive|silent]
             [--explain] [--timing] [--no-cache] [--allow-empty]
```

| Flag | Required | Description |
|---|---|---|
| `-f`, `--framework NAME` | no | Pack name. Repeatable. See [built-in packs](/reference/cli/extract#built-in-packs) below. Leave it off and suss reads the packs for the language from `suss.json`, or picks the ones `init` would when there is no file, and prints the command it is running. A name that is not built in resolves in three tries. A name starting with `@` or containing a `/` is imported exactly as you wrote it; otherwise suss tries `@suss/packs/NAME`, then `@suss/framework-NAME`, then `@suss/NAME`. |
| `-p`, `--project PATH` | no | Path to `tsconfig.json`, for the same type resolution your compiler sees. Leave it off and suss uses the nearest tsconfig or jsconfig above the working directory. |
| `--dir PATH` | no | Read this directory directly, for a project with no tsconfig. |
| `--lang NAME` | no | Which language to read this project as: `typescript`, `python`, or `ruby`. Leave it off and suss works that out from what the directory contains, from the packs you asked for, and from the nearest tsconfig, and it tells you when it cannot tell. |
| `-o`, `--output PATH` | no | Write JSON to file. Default: stdout. Parent dirs created automatically. |
| `--files F1 F2 ...` | no | Scope extraction to specific files. Default: every file in the tsconfig. Paths are resolved relative to cwd. File paths written as bare arguments, with no flag in front of them, mean the same thing when `--files` is absent. |
| `--gaps MODE` | no | `permissive` (default) records gaps in the summary: returns and declared statuses the pack couldn't account for. `strict` records the same gaps, then exits non-zero if the run recorded any. `silent` skips gap detection entirely, recording none. |
| `--explain` | no | Print the extraction funnel, file by file and pack by pack, so you can see where summaries came from. A run that produced nothing prints it either way. |
| `--timing` | no | Print the per-phase wall-clock breakdown to stderr. |
| `--datalog-profile` | no | Print what the Datalog evaluator spent its time on, rule by rule, and how many rows its joins read. Reach for it when `--timing` says the rules phase is the slow one. It also says how many values were read under a construction site, how many of those the evaluator gave up on part way, and how many it never put because the run had spent its rows on the questions before them. Either way the run keeps the answer it had without that site. |
| `--no-cache` | no | Skip the on-disk extraction cache for this run. Normal runs benefit from it; reach for this when debugging cache invalidation. |
| `--allow-empty` | no | Let a run that produced no summaries exit 0. Without it the run fails, since a silent zero looks the same as a passing check in CI. |
| `--fail-on-pack-error` | no | Exit non-zero when a pack throws while it reads. By default the run reports the throw and continues with the other packs. |

## When a run could not read everything

With `-o`, a run that could not read part of the project writes a note
beside the summaries, at `summaries.incomplete.json` next to
`summaries.json`, so a job that knows where the summaries went can tell
whether extraction was complete. The note has one key per reason:
`filesWithUnreadableExports` for re-export chains suss could not follow
in a TypeScript run, and `submodulesNotCheckedOut` for a submodule with
nothing in it, which any language can hit. A run with nothing to report
removes a note an earlier run left, so a stale file never fails a job
that has since been fixed.

## Built-in packs

`-f NAME` accepts these out of the box:

Every one of them ships inside `@suss/packs`, so the module column is
where the name resolves rather than something to install.

| Name | Module | What it discovers |
|---|---|---|
| `ts-rest` | `@suss/packs/ts-rest` | ts-rest routers + contracts; handlers and clients derive method/path from the contract |
| `express` | `@suss/packs/express` | `app.get(...)` / `router.get(...)` style registration |
| `fastify` | `@suss/packs/fastify` | `fastify.get(...)` / equivalent Fastify handlers |
| `hono` | `@suss/packs/hono` | `app.get(...)` Hono handlers, including `c.json(body, status)` |
| `nextjs` | `@suss/packs/nextjs` | Next.js route handlers and pages; the route comes from where the file is on disk |
| `nestjs-rest` | `@suss/packs/nestjs-rest` | NestJS REST controllers (`@Controller` / `@Get`) |
| `nestjs-graphql` | `@suss/packs/nestjs-graphql` | NestJS GraphQL resolvers (`@Resolver` / `@Query` / `@Mutation`) |
| `apollo` | `@suss/packs/apollo` | Apollo Server code-first resolvers (`new ApolloServer({ typeDefs, resolvers })`) |
| `aws-lambda` | `@suss/packs/aws-lambda` | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes |
| `react` | `@suss/packs/react` | Function components + locally-authored event handlers + `useEffect` bodies |
| `react-router` | `@suss/packs/react-router` | React Router v6+ `loader` / `action` named exports |
| `fetch` | `@suss/packs/fetch` | Global `fetch(...)` call sites |
| `axios` | `@suss/packs/axios` | axios call sites + `axios.create` factories |
| `apollo-client` | `@suss/packs/apollo-client` | `@apollo/client` hooks + imperative `client.query` / `mutate` |
| `node` | `@suss/packs/node` | `setTimeout` and friends, the `process` surface including `process.env.X`, module-loading globals |

Three of them read another language, so you run them with `--lang` or
point them at a directory suss treats as that language, and they cannot
run alongside a TypeScript pack. One of them needs you to tell it
something about your project, which you pass through
`-f NAME=config.json`:

| Name | Package | What it discovers |
|---|---|---|
| `fastapi` | `@suss/packs/fastapi` | FastAPI routes (Python): the verb comes from the decorator's attribute name, and router prefixes are composed one mount hop deep. |
| `flask-restx` | `@suss/packs/flask-restx` | flask-restx `Resource` routes (Python), one per HTTP-verb-named method. |
| `graphql-ruby` | `@suss/packs/graphql-ruby` | graphql-ruby's class-based `field` DSL (Ruby), one resolver per field. It needs `root`, and reads nothing without it. |
| `rails` | `@suss/packs/rails` | Rails controller actions (Ruby), each bound to the method and path `config/routes.rb` gives it. Needs nothing: `root` and `routesFile` default to `app` and `config/routes.rb`. |

Five more names are built in the same way, and discover no units of
their own. They attach typed effects to calls inside whatever units
another pack found:

| Name | Package | What it recognizes |
|---|---|---|
| `prisma` | `@suss/packs/prisma` | Prisma client calls, as storage-access interactions |
| `drizzle` | `@suss/packs/drizzle` | Drizzle query-builder and relational-query calls, with SQL table names |
| `aws-dynamodb` | `@suss/packs/aws-dynamodb` | AWS SDK v3 DynamoDB commands, as storage-access interactions, and a request the project signs and posts itself. |
| `aws-sqs` | `@suss/packs/aws-sqs` | AWS SDK v3 SQS producer calls, as message-send interactions |
| `aws-sns` | `@suss/packs/aws-sns` | AWS SDK v3 SNS `Publish` and `PublishBatch` calls, as message-send interactions |
| `aws-secrets-manager` | `@suss/packs/aws-secrets-manager` | AWS Secrets Manager calls, as storage-access interactions against the secret |
| `aws-ssm` | `@suss/packs/aws-ssm` | AWS SSM Parameter Store calls, as storage-access interactions against the parameter |
| `aws-eventbridge` | `@suss/packs/aws-eventbridge` | EventBridge `PutEvents` calls, as message-bus interactions |

Your own pack works the same way. Publish it under any name and pass
that name: `-f @acme/suss-pack` imports it as written, and
`-f mypack` finds `@suss/framework-mypack` through the fallback above.

## Configuring a pack

Write `-f <pack>=<config.json>` and the file's contents go to the pack
as its options. The CLI parses the file against the pack's own schema
before the pack runs, so a key nobody declared stops the run by name
instead of reading as nothing.

A pack config says something about your own project: which database is
behind a connection, which directory your schema lives in, which
modules make a file worth reading. A fact about a package you depend on
goes in a [dependency stub](/guides/teach-a-dependency) instead, and every pack
that consumes it reads it from there.

The DynamoDB pack takes one option, `requiresImport`. It lists the
modules whose presence, directly or through a file the project imports,
makes a file worth reading, which is how the call sites of a helper that
signs its own requests get walked at all.

It used to take `requestFunctions` as well, saying which of the
project's own functions posted a DynamoDB request and which of its
arguments were the operation and the request. suss reads that itself
now, before extraction: a function whose body sends the operation in the
`X-Amz-Target` header and the request as the body is a DynamoDB helper,
whichever parameters those come from, and the call sites are matched
with the arguments they were written with. What each operation does to
the table is DynamoDB's own, so it lives in the pack.

The express, fastify and hono packs take no options at all. They used to
take `registrationHelpers`, saying what a route helper of the project's
own registers. That is read the same way: before extraction, every
function the code hands its app to is read once, what it registers is
written down in terms of its own parameters, and each call site fills
those in. A helper called twice for two different resources gives both
routes, and a helper whose parameter is typed with an interface of the
project's own is read like any other.

The aws-lambda pack takes no options at all. It used to take
`subjectFactories`, saying which property of your handler factory's
config was the subject its SQS consumer listens for:

```ts
export const handler = makeSubjectHandler(
  { name: "paid-worker", subject: "billing.invoicePaid" as const },
  async (message) => { ... },
);
```

The channel was the wrong thing to take from there. A producer sends to
a queue, so the two ends never met on that subject, and the SAM template
already says which queue delivers to a function. A consumer's binding
now says the bus and leaves the channel blank, and the template's own
consumer supplies it. The subject stays a field of the message, which
`suss check` compares against what the producers on that queue send.

Nine options used to state facts about a dependency here, and 0.21.0
removed them. Setting one now stops the run and says which stub kind
takes it over:

| Pack | Option was | States it now |
| --- | --- | --- |
| `nestjs-rest`, `nestjs-graphql`, `nestjs-microservices` | `classDecorators` | `composes-decorator` |
| `aws-sqs`, `aws-eventbridge` | `producers` | `performs-call` |
| `axios` | `factories` | `performs-call` |
| `fastapi`, `flask-restx` | `wrapperModules` | `re-exports` |
| `graphql-ruby` | `baseClassNames` | `extends-base` |

The message-bus dispatcher the `producers` option used to describe now
reads like this. A service that sends every message through a wrapper
never writes a `SendMessageCommand`, so the pack cannot see the send
until the stub says which call performs it:

```yaml
# suss/stubs/acme-async.yaml
package: "@acme/async"
statements:
  - kind: performs-call
    system: aws.sqs
    spec:
      receiver: CommandDispatcher
      method: dispatch
      subjectArg: 0
      bodyArg: 1
```

`receiver` is the name of the dispatcher's type, `method` is the call
that sends, and the two indexes say which argument is the subject and
which is the body. Leave `bodyArg` out for a batch method that takes a
list of entries.

The subject becomes the channel the producer sends on, so it pairs with
the handler that uses the same subject. If the source does not write the
subject as a string, suss does not record the effect at all: pairing on
a guessed channel would point at the wrong consumer.

`errorHelpers` on `react-router` stays a pack option, since it describes
the project's own helpers rather than a package it depends on.

[Exit codes](/reference/cli/exit-codes#suss-extract) says what `extract`
returns to the shell.

