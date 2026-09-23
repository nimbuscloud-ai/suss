---
title: Adopt it step by step
description: Six steps from reading one service to gating pull requests, with the command for each, what it tells you, what it costs, and what a wrong answer looks like there.
---

# Adopt it step by step

Start on one service, where there is nothing to triage, and take the next step only when the last one has paid for itself. For each step you get the command, what comes back, what it costs, and what a wrong answer looks like.

1. Read one service with `extract` and `inspect`.
2. Question it with `suss ask` or from your agent.
3. Compare it against a document you already keep.
4. Add the other side of a boundary.
5. Gate on it in CI and on pull requests.
6. Reuse the summaries.

[Add suss to a project](/guides/add-to-project) covers the install and the first run. The steps below pick up after that.

## 1. Read one service

<!-- suss:unchecked each step runs in a different project, so no single directory could follow the page from top to bottom -->

```bash
npx suss extract --dir . -f aws-lambda -f aws-sqs -o summaries/code.json
npx suss inspect summaries/code.json
```

**What you get.** One entry per unit, with every path it can take, what it returns on each, and the calls and queues along the way:

```
src/handlers/paidProducer.ts
└─ unit:lambda PaidProducerFunction  (aws-lambda handler | line 12)
     Nothing in the template routes an event here and no call in this run
     names it, so whatever invokes it is outside what suss read.
       -> return { ok }
         + JSON.stringify
         + sqs.send
         + writes bus:aws_sqs {PAID_QUEUE_URL}

src/handlers/paidWorker.ts
└─ bus:aws_sqs (channel named at runtime)  (aws-lambda handler | line 10)
       if  typeof invoiceId !== "string"
         -> throw Error
       else
         -> return { recorded }
```

There is nothing to triage at this step. You get a description of the service that came out of the code, and you find out whether suss reads your stack before you put any more time into it.

**What it costs.** A cold run over a few hundred units takes seconds. Later runs read a per-file cache, so a run after editing one file is faster than the first. suss does not build or start anything.

**What a wrong answer looks like.** A unit with this line under it:

```
!! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
```

means suss found the unit and could not read its body, usually because the response goes through a helper the pack does not recognize. A `Could not follow` line under a unit means one call in it landed somewhere suss could not read, so whatever is behind that call is missing. In both cases suss tells you. When most of your units look like this, [Fix a run that found nothing](/guides/fix-an-empty-run) explains how to tell a setup problem from a stack suss cannot read, and `extract --explain` prints what each pack matched, file by file.

## 2. Question it

```bash
npx suss ask 'what writes bus:aws_sqs PaidQueue' --dir summaries/
npx suss ask 'what calls src/lib/recordRefund.ts' --dir summaries/
npx suss ask 'what reaches recordRefund' --dir summaries/
```

[Ask about a codebase](/guides/ask) works through the questions and the answers. A coding agent can ask the same questions over MCP, and [Give your agent suss](/start/give-your-agent-suss) sets that up.

**What you get.** The file and the line for every unit that reads or writes a store, every boundary a route reaches, and every caller of a function, followed through as many hops as the calls take. An agent that asks before it edits a table or changes a signature knows what it is about to affect, and the person reviewing that change can ask the same question. If your team works with agents, this is the cheapest step to take, because it needs nothing beyond step 1.

**What it costs.** Nothing beyond step 1 from the shell. The MCP server runs one extract when it starts and re-reads the affected part whenever a file changes.

**What a wrong answer looks like.** An answer that ends like this:

```
warning: 3 calls here resolved to no unit, so a boundary reaching readRow through one of them is missing from this answer.
```

That answer is complete as far as suss could read, and it tells you where it stopped. If an answer has no such line and a unit you know about is missing from it, that is a bug in suss or in a pack; see [Is it a miss or a bug](#is-it-a-miss-or-a-bug) below.

## 3. Compare it against a document you already keep

Most services keep at least one document that describes what they do, such as a Prisma schema or a CloudFormation template. `suss contract` reads that document and writes it in the same format as the code's summaries, and `check` compares the two:

```bash
npx suss contract --from cloudformation template.yaml -o summaries/template.json
npx suss check --dir summaries/
```

**What you get.** Your first findings. Each one says two halves of one deployment disagree:

```
[ERROR] boundarySelectorMismatch
  readRow picks items on OrdersTable by "customerId", which is not one of its key attributes (orderId). aws.dynamodb refuses a request keyed on anything else, so this fails when it runs.
  provider: cloudformation:template.yaml::OrdersTable (cloudformation:template.yaml:1)
  consumer: src/orderStore.ts::readRow (src/orderStore.ts:14)
  boundary: cloudformation (aws-sdk)
```

The template declares the table's key attributes, and the code picks rows by something else. Neither file is wrong on its own, and TypeScript cannot catch it, because the storage layer is passed a string.

Today, suss compares these:

- A Prisma schema against every query. The `prisma` pack reads the schema during `extract`, so this one needs no `contract` command at all. The schema is the provider and each query is a consumer, so a column no query reads, or a field no model declares, is a finding.
- A CloudFormation or SAM template against the code it deploys. suss compares the routes, queues and environment variables the template wires up against what the handler does with them.
- A contract written in the code, a ts-rest router or a `createRoute` under hono-openapi, against the handler behind it.
- An OpenAPI document against the handlers that serve it and the clients that call it. [Check against OpenAPI](/guides/check-against-openapi) covers both directions.
- A document your team wrote about what the code should do. [Check against your intent](/guides/check-against-intent) covers that one.

**What it costs.** One more command, and your first decisions. Each finding is a bug in the code, a document that fell behind, or something you accept. The third kind goes in `.sussignore.yml` with a reason, so it does not come back.

**What a wrong answer looks like.** The contract declares a `401` and suss reports that no path produces it. Usually that `401` comes from middleware or from an error handler registered around the route, not from the handler itself. suss composes those in when it can see the registration. When it cannot, because the middleware is built by a call it could not follow, the route looks as though it never produces the status. Accept it with a suppression rule, or open an issue with the `inspect` output for that route. A wrapper suss cannot see is a gap in a pack, and those get fixed.

## 4. Add the other side of a boundary

Read the code on the other side into the same directory, such as the frontend that calls the API or the worker that drains the queue.

```bash
# the web client that calls the API
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json

# or the service that drains the queue
npx suss extract --dir services/billing -f aws-lambda -f aws-sqs -o summaries/billing.json

npx suss check --dir summaries/
```

A client pairs with a handler when the method and the path match, so a client in `apps/web` and a handler in `services/api` are compared against each other without anyone declaring anything. For a queue, suss reads from the template which consumer a producer reaches.

**What you get.** A finding that points at the caller that breaks:

```
[WARNING] boundaryFieldUnknown
  PaidWorkerFunction.handler reads "data.invoiceId" off a message on aws_sqs channel "PaidQueue" but no producer in the analysed scope sends "data.invoiceId". Likely a producer/consumer drift: the producer renamed or removed the field, or the consumer expects a field that was never sent.
  provider: cloudformation:template.yaml::PaidWorkerFunction.FromPaid (cloudformation:template.yaml:1)
  consumer: src/handlers/paidWorker.ts::PaidWorkerFunction.handler (src/handlers/paidWorker.ts:10)
  boundary: cloudformation (aws_sqs)
```

Before you remove a field or change a status, run this and read the list. If the list is empty and every caller is in the repository, the change is safe as far as the code can show.

**What it costs.** One extract per consumer, and a bigger pile of findings the first time. Expect a first run over an old codebase to produce more than you want to read in one sitting. `check --at 'GET /users/:id'` narrows a run to one boundary. The severity split means that first run does not have to be all or nothing: errors fail the build and warnings only print.

**What a wrong answer looks like.** `unhandledProviderCase` reports that a client never branches on a status the handler produces. A client that handles every non-2xx status in one shared interceptor does handle it, and suss still reports the warning when it could not follow the interceptor through to the branch. This is the finding teams accept most often, and a suppression rule scoped to the kind and the boundary covers it. [Accept a finding](/guides/accept-a-finding) has the patterns.

## 5. Gate on it

Two things go into CI. The `inspect-diff` action reads the base and the head of a pull request and posts what the change did to each unit, and `check --fail-on error` fails the build on an error-severity finding:

```yaml
- uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
  with:
    extract: --dir . -f aws-lambda -f aws-sqs

- name: Read every side into one folder
  run: npx suss extract --dir . -f aws-lambda -f aws-sqs -o summaries/code.json

- name: Check the boundaries
  run: npx suss check --dir summaries/ --fail-on error
```

[Run suss in CI](/guides/ci-integration) has the whole workflow and every input the action takes.

**What you get.** On a pull request too large to read in full, the diff is what a reviewer reads first:

```
1 boundary changed: 2 outcomes.

~ serves bus:aws_sqs (channel named at runtime)  src/handlers/shippedWorker.ts::ShippedWorkerFunction.handler  (2 outcomes)
  outcomes
    + return { shipped }  when  typeof invoiceId !== "string"
    - throw Error  when  typeof invoiceId !== "string"
```

Those two lines show that a message with no `invoiceId` now comes back as a successful `{ shipped }` instead of throwing, whichever of the changed lines did it. When the diff is quiet, no unit changed what it does. For a refactor, that is the result you want.

**What it costs.** Two extracts per pull request instead of one, and the decision of what fails the build. Start at `error`. Tighten to `warning` once every accepted finding is in `.sussignore.yml` and a new warning means something.

**What a wrong answer looks like.** A quiet diff after a change you know altered behavior. The changed code is behind a call suss could not follow, and the `Could not follow` line from step 1 tells you which call.

## 6. Reuse the summaries

Every command above reads one JSON file per extract, and anything else you write can read the same file.

- **Agent context.** Hand `AGENTS.md` to the agent (it ships in the package, at `node_modules/@suss/cli/AGENTS.md`), or run the MCP server from step 2. The agent can find out what a route does without reading the handler.
- **Endpoint documentation.** `inspect` over a service describes every route, and re-running it keeps that current. `suss infer intent` drafts a behavior document from the summaries for people to edit.
- **Test cases.** Each path in a summary is a case a test could cover: the predicate is the setup and the transition is the assertion. A route with five paths and two tests has three that nothing exercises.

[Summary format](/reference/summary-format) documents that file, and the format is stable.

## Triaging a finding

A finding has a kind, a severity, a provider, a consumer and a boundary. Read it as a claim about the two sides, then decide which of three things it is.

- A bug in the code. Fix the code, and the finding goes away on the next run.
- A document that fell behind. Fix the document.
- Something you accept. Add a rule to `.sussignore.yml` with a `reason`. suss prints the rule under the finding, so you can paste it.

Errors are findings where the code on one side cannot work against the other, such as reading a field the other side never sends. Warnings are judgement calls, such as a status with no branch for it. `check --json` writes the same findings for tooling to read, and `--at` narrows a run to one boundary while you work through it.

## Is it a miss or a bug

suss tells you when it could not read something, and that is the first thing to look for.

- A `Could not follow` line under a unit in `inspect` output, or a `could not follow` sentence at the end of an `ask` answer, means a call landed somewhere suss could not read. Whatever is behind it is missing from the answer, and the answer tells you so.
- `confidence: low` on a summary or a finding means the same thing about the summary as a whole.
- `extract --explain` prints what each pack matched, file by file, so for a service that came out thin you can see where the reading stopped.

When something is missing and one of those markers is on it, suss missed it and said so. When the output shows a path the code does not have, or something is missing with no marker at all, that is a bug. Report it on the [issue tracker](https://github.com/nimbuscloud-ai/suss/issues) with the `inspect` output for the unit pasted in.
