# CLI reference

Every command, every flag. For prose-style usage see the
[tutorial](/tutorial/get-started) and [how-to guides](/guides/add-to-project).

Placeholder notation: `<...>` marks a required value, `[...]` marks
optional. Example: `suss extract -f FRAMEWORK [-o OUTPUT]`.

## What each command is for

suss has four commands. They form one pipeline:

| Command | Inputs | Output | When you reach for it |
|---|---|---|---|
| `extract` | TypeScript or JavaScript source + a framework pack | `BehavioralSummary[]` JSON | You have code and want a structured description of every execution path. |
| `contract` | A specification (OpenAPI, CFN, Storybook, ...) | `BehavioralSummary[]` JSON | You have a spec instead of code, or want to compare code against a spec. Contract summaries have the same structure as `extract`'s output, so they pair against extracted summaries. |
| `check` | One or more summary files | Findings (text or JSON) | You have summaries from two sides of a boundary, provider + consumer, contract + handler, and want to know where they disagree. |
| `inspect` | A summary file | Human-readable text | You want to read what the summaries say without parsing JSON. The output is the form you paste into a code review or an AI prompt. |

The summary JSON is the canonical artifact. `inspect` is a renderer
over it; `check` is a comparator. Anything you can do in `inspect` or
`check` you can also do by reading the JSON yourself, they're
conveniences, not parsing layers. The one command that computes an
answer rather than rendering one is
[`inspect --flow`](#suss-inspect-flow), which walks the routing a set of
summaries declares to work out who serves a request.

Five more commands are outside the pipeline. `suss init` works out which
packs your project needs and offers to set them up. `suss ask`
([below](#suss-ask)) answers one question about one boundary from
summaries already on disk. `suss corroborate` (experimental,
[below](#suss-corroborate-experimental)) executes handlers against their
own summaries. `suss infer stub` ([below](#suss-infer-stub)) writes the
skeleton of a [dependency stub](/dependency-stubs) from the project's
observed calls into a package extraction cannot read. `suss infer intent`
([below](#suss-infer-intent)) writes starting intent docs from a
summaries file, one per boundary, for a person to curate, and
`suss infer prd` ([below](#suss-infer-prd)) reads those back once they
are curated and writes a PRD per boundary for a person to fill in.

## `suss init`

Work out which packs this project needs, then offer to install them.

**What it does.** It reads `package.json`, looks for schemas and deploy
templates on disk, and maps what it finds to packs. Then it asks whether
to install them, whether to run the first extract and check, and whether
to write a `.sussignore` and a CI workflow. Installing defaults to yes;
writing files defaults to no. Nothing reaches disk unless you accept it.

At a monorepo root it reads the workspace declaration from
`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`, or
`turbo.json`, and asks which packages to set up.

```
suss init [DIRECTORY] [--plain]
```

| Flag | Description |
|---|---|
| `DIRECTORY` | Where to look. Default: the current directory. |
| `--plain` | Print the commands instead of asking. Piped or in CI, it prints either way. |

### Exit codes

`0`, always. Declining every question, cancelling, and a failed install
all end the same way. A failed install stops there, prints what npm said,
and leaves you the command so you can retry it yourself.

## `suss extract`

Extract behavioral summaries from source.

Python and Ruby have adapters of their own, and this command reaches
them: it works out which language a directory contains, and `--lang`
lets you state it directly. See
[Read a Python or Ruby project](/guides/python-and-ruby).

**What it does.** It walks every function the framework pack discovers
(`loader` in React Router, `app.get(...)` in Express, etc.), folds
its branches and terminals into a decision tree, and emits one
`BehavioralSummary` per discovered unit. It never runs your code, and
you never annotate it.

```
suss extract [-p TSCONFIG | --dir DIR] [--lang typescript|python|ruby]
             -f FRAMEWORK [-f FRAMEWORK ...]
             [-o OUTPUT] [--files FILE ...]
             [--gaps strict|permissive|silent]
             [--explain] [--timing] [--no-cache] [--allow-empty]
```

| Flag | Required | Description |
|---|---|---|
| `-f`, `--framework NAME` | yes | Pack name. Repeatable. See [built-in packs](#built-in-packs) below. A name that is not built in resolves in three tries. A name starting with `@` or containing a `/` is imported exactly as you wrote it; otherwise suss tries `@suss/packs/NAME`, then `@suss/framework-NAME`, then `@suss/NAME`. |
| `-p`, `--project PATH` | no | Path to `tsconfig.json`, for the same type resolution your compiler sees. Leave it off and suss uses the nearest tsconfig or jsconfig above the working directory. |
| `--dir PATH` | no | Read this directory directly, for a project with no tsconfig. |
| `--lang NAME` | no | Which language to read this project as: `typescript`, `python`, or `ruby`. Leave it off and suss works that out from what the directory contains, from the packs you asked for, and from the nearest tsconfig, and it tells you when it cannot tell. |
| `-o`, `--output PATH` | no | Write JSON to file. Default: stdout. Parent dirs created automatically. |
| `--files F1 F2 ...` | no | Scope extraction to specific files. Default: every file in the tsconfig. Paths are resolved relative to cwd. File paths written as bare arguments, with no flag in front of them, mean the same thing when `--files` is absent. |
| `--gaps MODE` | no | `permissive` (default) records gaps in the summary: returns and declared statuses the pack couldn't account for. `strict` records the same gaps, then exits non-zero if the run recorded any. `silent` skips gap detection entirely, recording none. |
| `--explain` | no | Print the extraction funnel, file by file and pack by pack, so you can see where summaries came from. A run that produced nothing prints it either way. |
| `--timing` | no | Print the per-phase wall-clock breakdown to stderr. |
| `--datalog-profile` | no | Print what the Datalog evaluator spent its time on, rule by rule. Reach for it when `--timing` says the rules phase is the slow one. |
| `--no-cache` | no | Skip the on-disk extraction cache for this run. Normal runs benefit from it; reach for this when debugging cache invalidation. |
| `--allow-empty` | no | A run that doesn't produce any summaries exits non-zero by default, since a silent zero otherwise looks the same as a passing check in CI. Pass this to opt back into exiting 0. |
| `--fail-on-pack-error` | no | Exit non-zero when a pack throws while it reads. By default the run reports the throw and continues with the other packs. |

### When a run could not read everything

With `-o`, a run that could not read part of the project writes a note
beside the summaries, at `summaries.incomplete.json` next to
`summaries.json`, so a job that knows where the summaries went can tell
whether extraction was complete. The note has one key per reason:
`filesWithUnreadableExports` for re-export chains suss could not follow
in a TypeScript run, and `submodulesNotCheckedOut` for a submodule with
nothing in it, which any language can hit. A run with nothing to report
removes a note an earlier run left, so a stale file never fails a job
that has since been fixed.

### Built-in packs

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

### Configuring a pack

Write `-f <pack>=<config.json>` and the file's contents go to the pack
as its options. The CLI parses the file against the pack's own schema
before the pack runs, so a key nobody declared stops the run by name
instead of reading as nothing.

A pack config says something about your own project: which database is
behind a connection, which directory your schema lives in, which
modules make a file worth reading. A fact about a package you depend on
goes in a [dependency stub](/dependency-stubs) instead, and every pack
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

### Exit codes

- `0`: extraction succeeded, produced at least one summary or ran with `--allow-empty`, and neither `--fail-on-pack-error` nor `--gaps strict` found something to fail on.
- Non-zero: extraction threw (invalid tsconfig, unknown framework, missing files), it didn't produce any summaries and `--allow-empty` wasn't passed, or one of those flags fired.

## `suss contract`

Generate summaries from a declared contract instead of from code.

**What it does.** It reads a specification (OpenAPI, CloudFormation,
Storybook stories, AppSync schema) and emits the same
`BehavioralSummary` structure that `extract` produces. The point is not
to render the spec as JSON. The point is to produce a summary with
declared behavior, so the cross-boundary checker can pair it with an
extracted summary the same way it would pair two extracted
summaries.

Use cases:
- A third-party API ships an OpenAPI spec. You want to verify your
  client handles every status the spec declares.
- Your CloudFormation template declares an API Gateway route. You
  want to check that the Lambda handler implements every method the
  template registers.
- A Storybook story declares the props it passes to a component.
  You want to check that the component handles every prop variant
  the stories cover.

```
suss contract --from SOURCE SPEC [-o OUTPUT]
```

`SPEC` is either a local file path or an `http(s)` URL. Given a URL,
suss fetches the document, writes it to a temp file, and parses it
the same way as a local spec. That helps with vendor specs hosted on
GitHub or a docs site, e.g.
`https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml`.
The extension on the fetched file decides which parser suss uses
(`.json` → JSON, anything else including no extension → YAML).

| Flag | Description |
|---|---|
| `--from SOURCE` | Contract source kind. See [contract sources](#contract-sources) below. |
| `-o`, `--output PATH` | Write JSON to file. Default: stdout. |

### Contract sources

| Source | Package | Input |
|---|---|---|
| `openapi` | `@suss/contract-openapi` | OpenAPI 3.x JSON or YAML |
| `cloudformation` | `@suss/contract-cloudformation` | CFN / SAM template (JSON or YAML) with API Gateway REST / HTTP API resources |
| `serverless` | `@suss/contract-serverless` | A Serverless Framework service file. The path points at the file or at the directory containing it. The reader restates the service in SAM's forms and hands them to the CloudFormation reader, so a route, a queue consumer or an environment contract comes out the same whichever manifest declared it. `${self:...}` resolves against the document; a reference that a deploy supplies keeps its token. |
| `storybook` | `@suss/contract-storybook` | CSF3 `.stories.ts` / `.stories.tsx` file or directory of stories |
| `appsync` | `@suss/contract-appsync` | CFN template with `AWS::AppSync::*` resources |
| `prisma` | `@suss/contract-prisma` | `schema.prisma` file (Postgres / MySQL / SQLite datasources) |
| `graphql` | `@suss/contract-graphql` | Plain GraphQL SDL file. Each Query / Mutation / Subscription field becomes a resolver-kind summary. |
| `graphql-documents` | `@suss/contract-graphql` | Committed `.graphql` / `.gql` operation documents, a single file or a directory walked recursively. Each query / mutation / subscription becomes a client-kind summary, so a repo that keeps its operations in files pairs against its resolvers without suss having to trace any call site. Fragment spreads are inlined across the whole read set. |

Team-authored intent specs are not a `--from` source. They are their own
artifact stream, read directly by `suss check`:

```bash
suss check --dir summaries/ --intent intent/
```

### Exit codes

- `0`: contract source loaded.
- `1`: unknown source, file not found, parse error.

## `suss check`

Pair providers with consumers and report cross-boundary findings.

**What it does.** It reads summary files, groups them into
provider/consumer pairs by their boundary key (e.g. `(GET,
/users/:id)`), and runs each pair through a set of agreement
checks: does every status the provider produces have a consumer
branch that handles it? Does every status the contract declares
have a producer? Are the body shapes structurally compatible?

The "two sides of a boundary" framing is general:
- **Two extracted summaries**: handler vs. fetch client.
- **A contract vs. an extracted summary**, OpenAPI spec vs. handler;
  Storybook story vs. component.
- **Two contracts**, OpenAPI vs. CloudFormation, when both describe
  the same API.

Every finding tells you the boundary, the two sides, and what
disagrees. There's no global "compliance score", every finding is
a concrete pair.

```
# Two explicit summary files
suss check PROVIDER.json CONSUMER.json [--all] [--json] [-o OUTPUT] [--fail-on THRESHOLD]

# A whole directory, auto-pairs by boundary key
suss check --dir DIR [--intent INTENT_DIR] [--all] [--json] [-o OUTPUT]
           [--fail-on THRESHOLD] [--allow-empty] [--fail-on-unpaired N|N%]
           [--fail-on-unreadable] [--sussignore PATH] [--no-suppressions]

# One thing out of that directory
suss check --dir DIR --at TARGET [--json] [-o OUTPUT] [--fail-on THRESHOLD]
```

| Flag | Description |
|---|---|
| `--dir PATH` | Directory containing summary JSON files. suss reads every `.json` in the dir and auto-pairs by boundary. Mutually exclusive with positional args. |
| `--at TARGET` | Report on one thing instead of the whole folder. See [Reporting on one thing](#reporting-on-one-thing). Needs `--dir`, and does not run with `--intent`. |
| `--intent PATH` | Directory of team-authored intent docs (`*.intent.yaml`, `*.intent.yml`, `*.intent.json`, and the same three for `*.prd`). Each boundary intent is paired against the summaries in `--dir`, adding intent-coverage findings to the report. Needs `--dir`. |
| `--all` | Write out every finding and every list. See [What a run prints](#what-a-run-prints). |
| `--json` | Emit findings as JSON rather than human-readable text. Default: human text. |
| `-o`, `--output PATH` | Write findings to file. Default: stdout. |
| `--fail-on THRESHOLD` | `error` (default), exit non-zero when any error-severity finding exists. `warning`, also fail on warnings. `info`, fail on any finding. `none`, never fail (still prints). |
| `--allow-empty` | A run over `--dir` that pairs nothing has nothing to report and reads as a pass, the same as it prints when both sides agree, so it fails by default: the report gets a `nothingPaired` run finding saying what happened and what to do, and the run exits non-zero. Pass this to opt back into exiting 0. Needs `--dir`; a two-file check has no pairing count to opt out of, and refuses the flag. |
| `--fail-on-unpaired N\|N%` | Fail the run when more boundaries went unpaired than this: a count (`25`) or a share of all boundaries (`50%`). Needs `--dir`. A run that pairs three boundaries out of hundreds otherwise exits the same as one that paired everything; the report gets a `mostlyUnpaired` run finding with the numbers. |
| `--fail-on-unreadable` | Fail the run when a file in `--dir` could not be read as summaries, instead of skipping it with a warning. The report gets an `unreadableInput` run finding, and `--json` output lists the skipped files either way. |
| `--sussignore PATH` | Use this `.sussignore` file instead of searching for one nearby. |
| `--no-suppressions` | Report every finding, ignoring any `.sussignore`. Useful for auditing what the suppressions are hiding. |

A finding that points at one transition prints a `.sussignore` rule for
it, ready to paste under `rules:`. The rule identifies the transition on
whichever side has it, so it matches that finding and no other. See
[Suppressions](/suppressions).

### What a run prints

A run prints the errors in full, then counts everything else. The
counted parts are the findings below error severity, grouped by kind,
and the boundaries that went unpaired.

```
Compared 194 boundaries.

  400 provider-side boundaries have no client to compare against.
  10 client-side boundaries have no provider to compare against.
  11248 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

167 findings: 0 error, 167 warning, 0 info

Not shown: 167 boundaryFieldUnknown (warning). Run the same command with --all to see them.

4862 of 12229 summaries record something suss could not read, so what this run knows about those units is partial. Run `suss inspect` over the same files to see what.
```

Errors are what `--fail-on error` gates on, so they are what a run
leads with. The rest is there in a count, and `--all` writes all of it
out. Three things do not change with the flag. `--json` always includes
every finding and every list. `--at` always prints in full, because it
is already narrowed to one thing. The exit code is decided by
`--fail-on` rather than by what got printed.

Without the collapse, a first run over a repository of any size prints
thousands of lines before the first error. Over five public
repositories and suss's own packages, the unpaired lists alone were
between 66% and 99% of the report.

### Reporting on one thing

`--at` runs the same passes over the same folder and prints the part of
the report about one target. It is the question you have while editing a
file: does this call line up with what it reaches.

A target is one of four spellings, resolved in this order:

| Spelling | Example | What it picks out |
|---|---|---|
| Summary id | `app::src/editions/dao.ts::byPublication` | That one summary. A tail of the id works too, so the workspace in front is optional. |
| File and line | `src/editions/dao.ts:43` | The units covering line 43, and the branches that line falls in. Findings about other branches of the same function are left out. |
| File | `src/editions/dao.ts` | Every unit in that file. Matching is on whole path segments, so `dao.ts` finds it and `ao.ts` does not. |
| Boundary | `dynamodb:editions#by-publication` | Everything either side of that boundary, whichever file it is in. |

A file wins over a boundary, so a path is never read as a boundary whose
words happen to line up.

A boundary is spelled the way reports spell it, and a shorter spelling
covers more: `dynamodb:editions` covers the table and every index on it,
and `dynamodb:editions#by-publication` narrows it to the one index. The
same goes for a route, where `/editions` covers `GET /editions`.

```
$ suss check --dir .suss --at 'src/editions/dao.ts:45'
src/editions/dao.ts:45 (src/editions/dao.ts line 45, 1 summary, 1 branch over that line)

What it touches:
  dynamodb:editions#by-publication
    reads    src/editions/dao.ts::byPublication  via docClient.query

Compared 1 boundary here:
  dynamodb:editions#by-publication
    infra/editions.tf::aws_dynamodb_table.editions#by-publication <-> src/editions/dao.ts::byPublication

────────────────────────────────────────────────────────────
[ERROR] boundaryFieldUnknown
  byPublication selects "wordCount" on editions#by-publication (dynamodb) but the contract declares no wordCount field.
  ...
────────────────────────────────────────────────────────────
1 finding: 1 error, 0 warning, 0 info

1 thing here suss could not read, so what it knows about this target is partial:
  src/editions/dao.ts::byPublication
    suss met a call to loadCursor and could not settle which function it is, so whatever it does is missing from this summary.
```

The last paragraph is there whether or not anything was found: "no
findings here" means less when part of the unit could not be read, so a
target with a gap on it says so either way.

A target that matches nothing prints what it could not find and exits
`1`. An empty report would read as agreement.

`--json` writes the same report as `{ at, matched, target, touches,
findings, pairs, unmatched, gaps }`, where `touches` is one entry per
unit and boundary (`{ boundary, relations, unit, via }`) and `findings`
is the finding shape [`check --json`](#suss-check) already writes. A
target that matched nothing writes `{ at, matched: false, message }`.

### Exit codes

- `0`: no findings at or above the threshold (after suppressions).
- `1`: at least one finding at or above the threshold, or, under `--at`,
  a target that matched nothing.

Suppressions (`.sussignore`) affect counting: `mark` and `hide`
effects don't count toward the threshold; `downgrade` counts at
the downgraded severity. See [Suppressions](/suppressions).

## `suss ask`

Ask one question about one boundary, without writing a call first.

**What it does.** It reads summaries off disk and answers from them. An
index with a narrow projection is a set of attributes fixed in terraform
and invisible to TypeScript; autocomplete is the right answer to that and
there is nowhere to put it, so the next best thing is being able to ask.

```
suss ask "QUESTION" [--dir DIR | SUMMARIES.json] [--project DIR] [--json] [-o OUTPUT]
```

Ten questions, in these words:

| Question | What comes back |
|---|---|
| `what can I project from <boundary>` | What the boundary declares: the fields a store serves, the statuses a contract declares, the env vars a runtime takes. Also written `what does <boundary> declare`. |
| `what reads <boundary>` | Every unit that reads it, with the file, the line, and the call. |
| `what writes <boundary>` | The same, for writes. |
| `what invokes <boundary>` | Every unit that calls a deployed unit by name, such as one Lambda invoking another. |
| `what calls <unit>` | Every unit whose calls the run resolved to it, with the file, the line, and the call. The unit is spelled the way `--at` spells one: a file, a `file:line`, a summary id, or a function name. A package export such as `fn:@suss/datalog::evaluate` is the function behind it, so that spelling, the bare name, and `what reads` on the export give one answer. A bare name that is two functions in different places is refused, with both listed. |
| `what does <unit> reach` | Every boundary a file or a summary goes through, and whether it reads, writes or invokes each. |
| `what reaches <target>` | Every boundary whose unit ends up going through the target, and the calls it took to get there. The same call facts as `what calls`, closed over every hop with no limit on the chain, which is what somebody changing a store or a function wants before they change it. A unit is listed only when it serves a boundary of its own, so the answer is routes, queues, and package exports rather than the functions between them. The answer says how many calls resolved to no unit, since a boundary reaching the target through one of those is missing from it. |
| `what does <package or unit> provide` | Every boundary it provides, one per line, sorted by boundary key. A package is spelled by its name, `@suss/checker`, and the answer gathers its exports wherever they sit in the run. Also written `what does <package> export`. |
| `why does <unit> reach <target>` | The shortest call chain from the unit to a boundary, a function, or a package export, with each written hop's resolution proved from source. The same call facts as `what reaches`, so the chain is the one that answer lists under the unit. Both ends are spelled the way `what calls` takes a unit, and a bare name that is two functions is refused. |
| `why does <name> at <file>:<line> resolve to <target>` | The chain from a written name to the function it comes down to, one reason per hop. |

The boundary is spelled the way reports spell it, and a shorter spelling
covers more, exactly as under [`--at`](#reporting-on-one-thing). A
service call counts as both a read and a write, since a request sends a
body out and gets a response back. Calling a deployed unit by name does
the same two things and is reported as `invokes`, because a service made
of Lambdas would otherwise read as every function reading and writing
every other one. When a spelling covers several
boundaries at once, suss says which ones rather than picking one, and a
spelling that is exactly one boundary's name takes that one:
`GET /articles` is the collection route, not the comments route under
it.

When the unit an item is about provides a boundary itself, an exported
function or a route, the item says which one after the location:
`discoverUnits (src/discovery.ts:150, provides
fn:@suss/adapter-python::discoverUnits) calls builtSubjects`. The JSON
form has the same key in a `provides` field. Read that rather than the
summary id, which only spells the boundary when two summaries share a
name.

### The same questions in symbols

Five of the questions have a symbol form, for somebody asking the same
thing often. The arrows point the way the calls go:

| Symbols | The question it means |
|---|---|
| `<- <unit>` | `what calls <unit>` |
| `<unit> ->` | `what does <unit> reach` |
| `<unit> -> <boundary> ?` | `why does <unit> reach <boundary>` |
| `r<- <boundary>` | `what reads <boundary>` |
| `w<- <boundary>` | `what writes <boundary>` |

```
$ suss ask '<- src/orderStore.ts' --dir .suss
$ suss ask 'getOrder -> aws.dynamodb:orders-v1 ?' --dir .suss
```

The words are the documentation and the symbols are an alias for them,
so both take the same spellings and both give the same answer, in text
and under `--json`. The parts separate on spaces, since `<-`, `->` and
a trailing `?` are characters no key, id, or path contains.

A store has two spellings when its name is filled in at deploy time:
the reference the code states (`aws.dynamodb:{SUBSCRIBER_TABLE}`) and
the deployed name (`aws.dynamodb:prod-subscribers-v1`). When the
summaries contain what grounds one to the other, a wrangler `[vars]`
value or the argument a caller passed, either spelling finds the same
pairs, and the answer says how the two connect:

```
$ suss ask 'what writes aws.dynamodb:prod-subscribers-v1' --dir .suss
1 unit writes aws.dynamodb:{env.SUBSCRIBERS_TABLE}:
  src/index.ts::fetch (src/index.ts:11) through dynamo.send, which grounds to prod-subscribers-v1 via wrangler:wrangler.toml
```

When the grounding input is missing, the answer says which input would
connect the two spellings, in place of an empty list.

A calls question takes the reverse direction of `reach`: which units'
calls arrive at this one. An empty answer distinguishes "nothing calls
this" from "a call suss could not follow could reach it", from the
unfollowed-call gaps the summaries record:

```
$ suss ask 'what calls src/orderStore.ts' --dir .suss
1 unit calls storage-wrapper::src/orderStore.ts::readRow:
  storage-wrapper::src/orders.ts::GetOrderFunction.getOrder (src/orders.ts:6) calls readRow
```

A provides question lists what a package or a file exports, one
boundary per line, so an agent that needs a package's whole surface
gets it in one call instead of reading every export's own summary:

```
$ suss ask 'what does @suss/checker provide' --dir .suss
@suss/checker provides 2 boundaries:
  fn:@suss/checker::analyzeFlow, from analyzeFlow (packages/checker/src/flow/reachability.ts:400)
  fn:@suss/checker::checkAll, from checkAll (packages/checker/src/index.ts:12)
```

```
$ suss ask 'what can I project from dynamodb:editions#by-publication' --dir .suss
dynamodb:editions#by-publication declares 3 things you can ask it for:
  field publicationId (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication
  field editionId (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication
  field title (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication

$ suss ask 'what reads dynamodb:editions' --dir .suss
2 units read dynamodb:editions#by-publication:
  src/editions/dao.ts::byPublication (src/editions/dao.ts:30) through docClient.query
  src/editions/dao.ts::forDashboard (src/editions/dao.ts:70) through docClient.query

dynamodb:editions#by-publication is provided by infra/editions.tf::aws_dynamodb_table.editions#by-publication.
```

An answer that cannot be given from what is on disk says which input
would give it, rather than assembling one out of what the call sites
happen to ask for:

```
$ suss ask 'what can I project from dynamodb:editions#by-publication' --dir .suss
Nothing here declares what dynamodb:editions#by-publication serves.
  code here reads it through docClient.query, in src/editions/dao.ts::byPublication

No summary here provides dynamodb:editions#by-publication. Read the schema or deploy
template that declares it: suss contract --from terraform <path> -o summaries/infra.json
```

A why question is answered from two layers. The summaries say which
unit calls which and where the boundary is touched, and the chain is
the shortest one the call facts behind `what reaches` contain. The
chain under each hop is proved from source: the question re-reads the
relevant files and re-evaluates the resolution rules under the witness
algebra, when asked and never during a normal run. `--project` says
where the source is when it is not the working directory.

A hop can be one the caller writes, `getOrder calls readRow`, or one
only the caller's import records, as `analyzeFlow is bound to
fn:@suss/datalog::evaluate, which evaluate provides`. A bound hop has
no written call to prove, so it prints without resolution steps.
[How suss follows a value](../resolving-values.md) walks through the
facts, the rules and the proof behind one of these chains.

```
$ suss ask 'why does getOrder reach aws.dynamodb' --dir .suss
GetOrderFunction.getOrder reaches aws.dynamodb:{location.table}:
  GetOrderFunction.getOrder -> readRow -> client.send
  GetOrderFunction.getOrder (src/orders.ts:6) calls readRow, and that call runs readRow (src/orderStore.ts:14):
    readRow (src/orders.ts:9) -> readRow (src/orders.ts:4) -> readRow (src/orderStore.ts:14)
    readRow (src/orders.ts:9) is declared as readRow (src/orders.ts:4)
    readRow (src/orders.ts:4) is imported from src/orderStore.ts under the name readRow
  readRow reads aws.dynamodb:{location.table} through client.send (src/orderStore.ts:14)
```

A hop through a pack-declared wrapper says what it rests on, as
`assuming a pack declares that withSentry from @sentry/serverless
passes argument 0 through to its result`.

An answer also says when a unit suss could not read all of could be
missing from it. `--json` gives the same answer as `{ question, shape,
subject, found, headline, items, needs, caveats }`, and a why answer
adds the chain, the hops with their resolution steps, and what the
re-evaluation cost.

### Exit codes

- `0`: the question was one of the ten and its subject is in these
  summaries, including when the answer is empty.
- `1`: the question was not one of the ten, nothing here is at the
  boundary it asked about, or a why question's chain is not one the
  run contains.

## `suss inspect`

Render a summary file (or directory, or diff) as human-readable
text.

**What it does.** It reads a summary JSON file and prints a tree-style
view: summaries grouped by source file, decision-tree branches
under each summary, side effects under each branch, follow-references
to other summaries inline. The output is meant to be the form you
paste into a code review or an AI prompt, short enough to share,
self-describing enough to read cold, structurally aligned with the
underlying IR.

```
# A single summary file
suss inspect SUMMARIES.json

# Every summary in a directory, grouped by boundary
suss inspect --dir DIR

# Diff two summary files (shows changed transitions)
suss inspect --diff BEFORE.json AFTER.json [--json]

# Who serves a request, hop by hop
suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir DIR
```

| Flag | Description |
|---|---|
| `--dir PATH` | Report how the summaries in a directory pair up, boundary by boundary, and which ones found nothing to pair with. It does not render the summaries themselves. |
| `--diff BEFORE AFTER` | Compare two summary files and render added / removed / changed transitions. A transition that only moved in the file is not a change, so an edit above a handler leaves the diff quiet. Takes `--json`. |
| `--types` | Spell out the named types a summary references instead of printing their names. It applies to a single file and to `--dir`; a `--diff` run ignores it. |
| `--flow "METHOD URL"` | Work out who serves one request, hop by hop. See [below](#suss-inspect-flow). |

Rendering a file has no JSON output mode, it is always human-formatted.
For programmatic consumption, read the summary files directly (they ARE
JSON). Two forms are different, because each works an answer out rather
than rendering a file, so there is nowhere else to read it from.
`--flow` takes `--json` and gives you the chain as data. `--diff` takes
it and gives you what moved between two runs, as
`{ version, changed, summaries }` with each entry marked `added`,
`removed`, or `changed`.

A diff reports behaviour. Two runs over the same code with a comment
added produce transitions at different offsets and the diff says
nothing, because where a handler is in a file is not something it does.

### `suss inspect --flow`

Ask who serves a request, and get the chain back.

**What it does.** It walks the routing a set of summaries declares, hop
by hop. It then tells you the entry the request came in by, every hop it
took and the rule that admitted that hop, the unit it lands in, and the
handler inside that unit.

It reads both sides of the question, so point it at a directory
containing both: a deploy template read with `suss contract` for the
wiring, and `suss extract` over the code for the handlers that respond.

```
suss inspect --flow "<METHOD URL>" [SUMMARIES.json | --dir DIR]
```

Asking the ALB fixture who serves an order lookup:

```
suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir summaries/
```

```
GET https://shop.example.com/api/orders/123
in by ShopAlb, declared in cloudformation:fixtures/aws-alb/template.yaml

What serves it, as the declarations settle it:

  ShopAlb
    -> ShopHttpsListener   ShopHttpsListener belongs to ShopAlb
    -> OrdersTargetGroup   OrdersListenerRule takes it (priority 10; path-pattern /api/orders/*)
    -> OrdersTaskDefinition/orders-app   OrdersTargetGroup fronts it
  OrdersTaskDefinition/orders-app serves it
    allOrders answers it: * /api/orders/*   (src/orders-app/app.ts)
```

| Flag | Description |
|---|---|
| `--flow "METHOD URL"` | The request to ask about. A path works too (`"GET /api/orders/123"`), and then suss cannot settle a host-header rule, and it says so. |
| `--dir PATH` | Read every summary file in a directory, instead of the one file given as an argument. |
| `--entry NAME` | Which node the request comes in by, when the summaries contain more than one way in. |
| `--scope DOCUMENT` | Which document's node, when two documents declare that name. |
| `--json` | Write the chains as JSON instead of prose. |

You can see how certain each answer is, and a possible answer is never
presented as a settled one. A hop whose rule takes the request outright
is certain. A hop gated on something the declarations leave open, an
unevaluated condition field or a tie between two rules, is only
possible, and suss groups the chain containing it under its own heading
and says which hop is unsettled.

When nothing serves the request, the answer says where the walk
stopped. That is the response a listener's own default action gives it,
or the last node the walk reached along with the rules declared there
that refused the request, or a rule that took the request and sent it
somewhere nothing here resolved. In that last case the output shows the
reference the document wrote and the reason the reader stopped (a target
another template declares, for instance).

If the wiring branches wider than the answer prints, the output ends
with how many chains were left out, so you never mistake a partial
answer for the whole of it. The JSON form has the same count under
`omitted`.

Two documents that both declare a listener called `HttpListener` are
two listeners, and neither one's rules may be used for the other's
question. If you ask about a name they share, suss refuses and lists the
documents, so
`--entry HttpListener --scope cloudformation:services/beta/template.yaml`
says which stack you meant.

### Reading the output

Summaries group by source file. Within each group, summaries
render in source-order with elbow / pipe tree decoration so the
relationship "these two summaries live in the same file" is
visible at a glance.

```
app/routes/_bff.architecture.containers.$id.files.ts
├─ loader  (react-router loader | line 14)
│      if  !args.params.id
│        -> 400
│      elif  !prismaClient.containerV2.findUnique()
│        -> 404
│      else
│        -> return { files }
│          + logger.info
│          + getFiles →
│
├─ getAnalyzedFilesAtCommit  (reachable library | line 102)
│      -> return [{ filePath, id }]
│
└─ getFiles  (reachable library | line 124)
       -> return [{ id, filePath }]
         + getAnalyzedFilesAtCommit →
```

Five things to read for, in order:

1. **The file path**, what file these summaries come from.
2. **The header line** for each summary, what's summarized and
   what kind it is.
3. **The branch tree**, every execution path's condition and
   output.
4. **The effect lines** under each output, what the path calls
   into.
5. **The `→` markers**, pointers to other summaries you can
   navigate to for detail.

#### Header line

```
├─ <name>  (<recognition> <kind> | line N [| <metadata>])
```

| Field | Meaning |
|---|---|
| `<name>` | Identity. `METHOD /path` for REST endpoints; `<package>::<exportPath>` for package exports; bare function name otherwise. Generic / colliding names get path-qualified (`app/routes/_app.tsx.loader`). |
| `<recognition>` | Which discovery variant produced this summary, `react`, `react-router`, `ts-rest`, `reachable`, etc. Tells you *why* this thing is here. |
| `<kind>` | Behavioral role, `handler`, `loader`, `action`, `component`, `library`, `caller`, `client`, `useEffect`, ... See [`ir-reference.md`](/ir-reference). |
| `line N` | Source line where the function starts. |
| `<metadata>` | Optional kind-specific suffix. `useEffect` shows its dependency array (`[user, prefs]`, `(mount)`, `(every render)`). `confidence: medium` appears when not high. |

#### Branch tree

Each branch reads like an `if` in source:

```
    if  <predicate>
      -> <output>
    elif  <predicate>
      -> <output>
    else
      -> <output>
```

- `if` / `elif` / `else` mirror the source. Nested branches indent
  further.
- **Predicates** render as JavaScript-like expressions:
  `!params.id`, `user.deletedAt`, `db.findById().status === 200`.
  Shared prefixes across siblings are collapsed so each branch
  shows only the predicate that decides it.
- **Outputs** appear after `-> `:
  - `-> 200 { id, name, email }`, REST response, literal status,
    body shape. `{ ... }` records show keys; `[...]` are arrays;
    primitives are `string` / `int` / `bool` / `null`; unions
    join with `|`.
  - `-> return <shape>`: function return; `-> return` alone for
    empty.
  - `-> throw <ExceptionType>`: exception with the constructor
    name when known.
  - `-> render` followed by an indented JSX-style subtree, React
    component output. Self-closing leaves (`<X />`) collapse
    inline; elements with children expand to open/close tags.
  - `-> delegate -> <target>` / `-> emit "<event>"` / `-> void`.

An `elif` line with no `->` underneath it is a tree-building
artifact: the decision tree walked past that predicate but the
leaf lives deeper inside a nested `if`. It is not an empty source
branch.

#### Effect lines

Under each output, lines starting with `+ ` describe what that
branch *also* does, calls invoked on the path to the terminal,
mutations, emissions, state changes:

```
        -> return { files }
          + logger.info
          + getFiles →
          + + app/util/vcs.fetchFromVcs →
```

- `+ <callee>`: a plain call. No marker means the callee isn't
  a separate summary suss can navigate to.
- `+ <callee> →`: a follow reference. The callee resolves to
  another summary in the file. Look for it nearby.
- `+ <path/file>.<callee> →`: a cross-file follow reference.
  The callee resolves to a summary in another file (path shown
  without extension); scroll to that file's group to read it.
- `+ <Parent>.effect#N →`: a sub-unit reference. React
  components with `useEffect(...)` calls split into the
  parent component's summary and one summary per effect body.
  The parent's effect line points at the `effect#0`, `effect#1`,
  ... summaries directly below it.

#### Continuation markers

Long summaries (more than ~50 body lines) re-emit a compact
`↳ <file> (cont.)` marker every 50 lines. This keeps the file
context within view when the file-group header has scrolled
past. Short summaries are unaffected.

#### Annotations that start with `!!`

| What you see | What it means |
|---|---|
| Top-level `!! <description>` | A gap, the declared contract says a status exists but no branch produces it, or a branch produces a status the contract doesn't declare. |
| Trailing `!! undeclared` on an output | That output's status code isn't in the declared contract for this endpoint. |

### Format stability

`inspect` output is curated for human and AI reading, not for parsing.
If you need to programmatically consume what suss extracted, read the
summary JSON directly, `inspect` is a renderer over it, and the JSON
is the canonical artifact. See [behavioral summary format](/behavioral-summary-format)
for the JSON's own stability guarantees.

Within v0, `inspect` promises to keep these parts unchanged across
minor versions:

- **Grouping by source file**: with each summary rendered under its
  file's path header.
- **Header line layout**: `<name>  (<recognition> <kind> | line N [| <metadata>])`.
- **Branch tree keywords**: `if` / `elif` / `else`, with `-> ` prefixing
  each output.
- **Output prefixes**: `-> <status>`, `-> return`, `-> throw`, `-> render`,
  `-> delegate`, `-> emit`, `-> void`.
- **Effect prefix**: lines under an output begin with `+ ` for calls
  and `+ + ` for cross-file references.
- **Follow markers**: `→` after a callee name signals another summary
  exists for it.
- **`!!` annotations** for gaps and `undeclared` outputs.

Free to change without warning:

- Exact tree-decoration characters (`├─`, `└─`, `│`), these are
  cosmetic and may shift to align with other tools.
- Whitespace, indentation widths, column alignment.
- Predicate rendering style (operator precedence, parenthesization,
  identifier truncation rules).
- The exact `<metadata>` suffix on the header line, including which
  fields appear and in what order.
- Continuation marker text (`↳ <file> (cont.)`).
- Trailing-whitespace behavior, line-wrap thresholds, color codes.

If your tooling regexes any of the "free to change" items, expect it
to break. If you find yourself reaching for parsing, reach for the
summary JSON instead.

### Exit codes

- `0`: rendered successfully.
- Non-zero, input file missing or not valid summary JSON.

## `suss corroborate` (experimental)

Extract, then run each handler against its own claims.

**What it does.** It runs a normal extraction, then for every summary in
scope it generates request inputs that satisfy a transition's own
extracted conditions, executes the actual handler function in a sandbox
with a stub response object, and compares the observed status with
the claimed one. Verdicts land on
`transition.confidence.corroboration`:

- `observed`: every satisfying run produced the claimed status.
- `refuted`: some run produced a different status. The concrete
  counterexample (request, observed status, claimed status) is
  attached and printed. Either the extraction is wrong there or the
  code surprises its own summary, and both are findings.
- `untested`: no satisfying input was found, or every run hit a
  dependency the sandbox cannot supply (a database, another service).
  The claim keeps its static confidence.

**Scope today** (why the flag is mandatory): `handler` summaries
recognized by the express or fastify packs, and only claims with a
literal status code. Everything else is skipped untouched. The scope
and the report format will change as coverage grows.

```
suss corroborate --experimental [-p TSCONFIG | --dir DIR] -f express
                 [-o ANNOTATED.json] [--runs N] [--attempts N]
```

| Flag | Description |
|---|---|
| `--experimental` | Required. Acknowledges the command is early. |
| `-p, --project PATH` | tsconfig covering the code to read. Same resolution as `extract`. |
| `--dir PATH` | Directory to read when there is no tsconfig. |
| `-f, --framework NAME` | Pack to use. Repeatable, same names as `extract`. |
| `--runs N` | Verdict-producing executions to aim for per claim (default 25). |
| `--attempts N` | Sampling attempts per claim before giving up (default 300). |
| `-o, --output PATH` | Write the annotated summaries to a file. |

### Exit codes

- `0`: every claim that could be tried held up (or nothing was in scope).
- Non-zero: at least one claim was refuted by execution.

## `suss infer stub`

```bash
suss infer stub <package> [-p <tsconfig> | --dir <directory>] [-o <file | ->]
```

Writes a [dependency stub](/dependency-stubs) skeleton for a package the
project calls but extraction cannot read into: one `performs-call`
candidate per export the code reaches, with the argument shapes observed
at each call site as comments, and the semantic fields (`system`, `spec`)
left blank for the author to fill from the package's own source.

The draft lands in `suss/stubs/<package>.yaml` under the resolved source
root; an existing file is never overwritten. `-o` picks another path, and
`-o -` prints the draft instead. MCP hosts get the same skeleton from the
`suss_stub_draft` tool.

| Flag | Description |
|---|---|
| `-p`, `--project` | Path to the tsconfig covering the code to read. Without it, the nearest tsconfig wins, or the directory is read as-is. |
| `--dir` | Directory to read when there is no tsconfig. |
| `-o`, `--output` | Where to write the draft; `-` prints it. |

### Exit codes

- `0`: a draft was written (or printed).
- `1`: no calls into the package were found, so there was nothing to draft.

## `suss infer intent`

```bash
suss infer intent --from <summaries.json | directory> [-o <directory> | --into <directory>]
```

Writes one [boundary intent doc](/contracts) per boundary in a summaries
file, from what the code does today, for a team adopting the intent layer
on a codebase that already exists. `--from` takes a folder as well, and
reads every `.json` in it, which is what a project with one file per pack
has.

```bash
suss extract -p tsconfig.json -f express -o summaries/code.json
suss infer intent --from summaries/code.json --out intent/
```

A drafted doc for `GET /users/:id` reads:

```yaml
# GET /users/{id}, as the code has it today.
# Read from src/handlers.ts, by way of summaries/code.json.
#
# Written from what the code does, so it says nothing about why. Fill in
# purpose and audience, rename this document and its outcome ids to what
# your team calls them, then set source to "inferred, curated" so findings
# against it count at full severity.
#
# Until the blanks are filled the reader rejects this file and says so,
# which is what keeps an uncurated draft from passing for finished.

kind: boundary

name: get-users-id
purpose: "" # what this boundary is for, in your words
audience: "" # who observes it: a customer, an operator, another service
source: inferred

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /users/:id

transitions:
  - id: 400-bad-request
    when:
      - input: request.params.id
        is: missing
    response:
      status: 400
      body:
        type: object
        properties:
          error:
            type: string
```

Outcome ids come from the status code and the body from the shape the
handler produces. A body shape the intent schema has no spelling for is
left out rather than guessed at.

`when` says what the branch turned on, in the same verbs `results` takes.
A route whose 404 depends on a table lookup finding nothing reads:

```yaml
  - id: 404-not-found
    when:
      - reads: aws.dynamodb:Invoices
        finds: nothing
  - id: 409-conflict
    when:
      - reads: aws.dynamodb:Invoices
        finds: something
        where: settledAt is set
  - id: 200-ok
    when:
      - reads: aws.dynamodb:Invoices
        finds: something
        where: settledAt is missing
```

The subject is a boundary verb whose value is the boundary's name, or
`input:` with the path the caller sent. The check is one of `finds`,
`is`, `equals` or `has`, and `where` narrows it.

The last branch states its own condition rather than saying `otherwise`,
since the summary records its guards as the negations of the ones above
it. A word meaning "not the branches above" changes what it claims when
somebody inserts a transition over it, and these files are hand-edited.
`otherwise` is left for a default branch whose guards the summary
never recorded. A guard that maps to none of that keeps a sentence, and a `when`
written as one plain string stays valid.

Naming the boundary is what makes the line survive a rename of the
variable the source used, and what lets `suss check --intent` compare it:
an intent saying 404 on a read finding nothing fails when the code's 404
turns on the row being there.

A boundary that is not HTTP gets a doc the same way. Here is what a queue
consumer that records what it read looks like, with the header left off:

```yaml
kind: boundary

name: bus-aws-sqs-billing-invoice-paid
purpose: "" # what this boundary is for, in your words
audience: "" # who observes it: a customer, an operator, another service
source: inferred

boundary:
  semantics: message-bus
  messageBus: aws_sqs
  channel: billing.invoicePaid

transitions:
  - id: throws-error
    when: invoiceId is not a string
    throws:
      errorType: Error
  - id: returns
    when: invoiceId is a string
    returns:
      body:
        type: object
        properties:
          recorded:
            type: boolean
    results:
      - writes: aws.dynamodb:Invoices
        by: [invoiceId]
```

`results` is what the transition did at other boundaries. The key is the
verb and the value is the boundary's own name, which is the string
`suss ask` takes: `suss ask "what writes aws.dynamodb:Invoices"` is the
question and this document is the assertion. A queue consumer has no
status worth declaring, so this is the part of its outcome that means
something. The checker compares it both ways: a declared write the code
never makes is an error, and a boundary the code reaches that no outcome
mentions is info.

That document is on `billing.invoicePaid` because a factory in the
service states the subject its consumer expects, so the code says which
channel it is. A Lambda without one has no channel of its own: the SAM
template decides which queue delivers to it. Read the template as well
and give `--from` the folder both summaries are in, and the doc comes out
on the queue the template says reaches that function, with the outcomes
from the handler:

```bash
suss extract --dir . -f aws-lambda -o summaries/code.json
suss contract --from cloudformation template.yaml -o summaries/infra.json
suss infer intent --from summaries --out intent/
```

A clause can also say `fields`, the columns the access touches, and `by`,
what it picks the item out by. Both are optional and both are drafted
when the summary has them, which is what stops "the customer's contact
details are erased" from being satisfied by any write at all to that
table.

**Purpose and audience are left blank on purpose.** Neither can be read
out of code: why the boundary exists and who it is for are what somebody
supplies while curating. An empty string does not satisfy the schema, so
`suss check --intent` reads the folder and reports the drafts still
waiting rather than checking them:

```
6 intent doc(s) in intent/ are inferred drafts with blanks still in them:
  - get-users-id.intent.yaml
  ...
Write them and set source to "inferred, curated", or take those files out of the intent folder until you do.
```

Curating a doc means filling in the two blanks, renaming the outcome ids
to what your team calls them, and setting `source: "inferred, curated"`.
`source` is what the checker reads to decide severity: findings against
bare `inferred` intent are downgraded one level, and curation restores
them.

Those same two files are what gives a Lambda nothing triggers a document
of its own. A function other functions call by name is a
`unit-invocation` boundary, keyed on the platform and the name the
template deploys it under, and the calls it makes to other functions are
`results` lines in the third verb:

```yaml
boundary:
  semantics: unit-invocation
  deploymentTarget: lambda
  instanceName: ReportBuilder

transitions:
  - id: returns
    when: every call reaches this outcome
    returns:
      body:
        type: object
        properties:
          reportId:
            type: string
    results:
      - invokes: unit:lambda {ARCHIVE_WORKER_FUNCTION}
```

The callee reads that way because the code gets its name from an env
var, and the drafter writes the boundary as the code spells it. Working
out which function that variable points at happens when the checker
pairs the invoke, and nothing hands that answer back to a drafted
document yet.

A boundary that could not be drafted is reported with the reason.
Boundary intent covers REST, function-call, message-bus, storage and
unit-invocation boundaries, so a GraphQL, runtime-config or metric
boundary is reported rather than drafted, as is a boundary whose
summaries never record a transition producing a response, a return, a
throw, or an effect.

A store is reported too, for a different reason: storage has no identity
key, so a doc naming one could never be paired. The reported reason says
so and points at the alternative, which is to write
`- writes: aws.dynamodb:Invoices` on an outcome of the boundary that
touches the store.

Pick the boundaries at extract time, with `extract`'s own `--files` and
`-f`. `infer intent` writes a doc for every boundary in the file it is
given.

| Flag | Description |
|---|---|
| `--from PATH` | The summaries file to read, from `suss extract`. |
| `-o`, `--out PATH` | Folder the docs go in. Default: `intent/`. Docs already there are written over, with a warning first. |
| `--into PATH` | The same folder, for a re-inference you want kept apart from what you have curated: it refuses to write where intent docs already are. |

Re-inference is naive: it writes the docs again from the current code and
takes any curation with them. `--into` is there so you can put a fresh
run beside the curated one and reconcile the two by hand. Merging a
re-inference against a curated baseline is separate work, sketched in
`design/proposals/intent-specs.md`.

### Exit codes

- `0`: at least one doc was written.
- `1`: no boundary in the summaries could be drafted as intent.

## `suss infer prd`

```bash
suss infer prd --from <intent-directory> [-o <directory> | --into <directory>]
```

Writes one PRD per curated boundary intent, with a scenario per outcome
and the link already filled in. The link is the part a machine can
supply, since it is the boundary document's `name` and the outcome's
`id`. The words are not.

```bash
suss infer intent --from summaries/code.json --out intent/
# a person fills in purpose and audience, and renames the outcome ids
suss infer prd --from intent/
```

For the route above, once its outcomes are renamed:

```yaml
# Why get-invoices-invoice-id behaves the way it does, for somebody to write.
# One scenario per outcome it declares, read from intent/.
#
# Each link points at an outcome the boundary document declares, and
# the words beside it are the part nothing but a person can supply:
# the situation, and what should happen in it.
#
# Until the blanks are filled the reader rejects this file and says so,
# which is what keeps an uncurated draft from passing for finished.

kind: prd

title: "" # what this document covers, in your words
purpose: "" # why it matters
audience: "" # who cares about it
source: inferred

scenarios:
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: get-invoices-invoice-id.no-such-invoice
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: get-invoices-invoice-id.already-settled
```

**It reads intent, not summaries, and that ordering is the point.** An
uncurated boundary document has blank purpose and audience, so it does
not load and this refuses the whole folder:

```
2 intent doc(s) in intent/ are inferred drafts with blanks still in them:
  - get-invoices-invoice-id.intent.yaml
  ...

A PRD links to outcome ids, so the boundary documents have to be curated before this can write one.
```

Drafting both at once would link to `200-ok`, and renaming that outcome
is the first thing curation does. The PRD would then point at an id
nothing declares, and `danglingScenarioLink` would fire on a file suss
wrote itself.

Reading intent also means the command needs no summaries at all, which
matches what the checker does: a PRD can be checked before any code
exists.

A boundary intent a scenario already points at is left alone, so running
this again after adding an endpoint writes only what is missing.

| Flag | Description |
|---|---|
| `--from PATH` | The folder of curated boundary intent to read. |
| `-o`, `--out PATH` | Folder the PRDs go in. Default: the folder they were read from. |
| `--into PATH` | The same folder, for a re-draft you want kept apart: it refuses to write where PRDs already are. |

### Exit codes

- `0`: at least one PRD was written.
- `1`: every boundary intent already has a scenario pointing at it.

## Top-level flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Print usage and exit 0. Running `suss` with no command does the same. |
| `-v`, `--version` | Print the installed version and exit 0. |

Every exit code is `0` or `1`. There is no third code to branch on: a
command either did what you asked or it did not.

## Environment variables

Two affect how output looks. Nothing else is configured this way.

| Variable | Effect |
|---|---|
| `NO_COLOR` | Set it to anything and suss writes plain text with no ANSI colour. |
| `TERM=dumb` | Same effect. Colour is also off whenever stdout is not a TTY, so a piped or redirected run is plain without you asking. |

`suss init` also notices when it is running in CI and prints the
commands rather than prompting, the same as `--plain`.

## Where each command writes

| Target | Default |
|---|---|
| stdout | Summary JSON (`extract`, `contract`), human text (`inspect`, `check`, `ask`), finding JSON (`check --json`) |
| stderr | "Wrote N summaries to PATH" acknowledgements, extraction warnings, error messages |
| exit code | Per-command threshold as described above |

Output destinations are composable: `suss extract ... -o file.json` writes
summaries to the file AND a one-line acknowledgement to stderr.
`suss check ... -o findings.txt` writes the formatted report to the file,
nothing to stdout. Piping (`suss extract ... | jq '...'`) works because
non-`-o` mode writes JSON to stdout with nothing else.
