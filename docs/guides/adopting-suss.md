---
title: Adopt it step by step
description: Six steps from reading one service to gating pull requests, with the command for each, what it tells you, what it costs, and what a wrong answer looks like there.
---

# Adopt it step by step

Start on one service, with nothing to triage, and take the next step only when the last one paid for itself. Each step below has its command, what you get, what it costs, and what a wrong answer looks like there so you recognize one when you see it.

1. Read one service with `extract` and `inspect`.
2. Question it with `suss ask` or from your agent.
3. Compare it against a document you already keep.
4. Add the other side of a boundary.
5. Gate on it in CI and on pull requests.
6. Reuse the summaries.

[Add suss to a project](/guides/add-to-project) covers the install and the first run. This page is about where to take it after that.

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

There is nothing to triage at this step. You get a description of the service that came out of the code rather than out of somebody's head, and an answer to whether suss reads your stack at all before you invest further in it.

**What it costs.** A cold run over a few hundred units takes seconds. Later runs read a per-file cache, so a run after editing one file is faster than the first. Nothing is built and nothing is started.

**What a wrong answer looks like.** A unit with this line under it:

```
!! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
```

means suss found the unit and could not read its body, usually because the response goes through a helper the pack has never seen. A `Could not follow` line under a unit means one call in it landed somewhere suss could not read, so whatever is behind that call is missing. Neither case is silent. When most units look like this, [Fix a run that found nothing](/guides/fix-an-empty-run) says how to tell the setup apart from the stack, and `extract --explain` prints what each pack matched, file by file.

## 2. Question it

```bash
npx suss ask 'what writes bus:aws_sqs PaidQueue' --dir summaries/
npx suss ask 'what calls src/lib/recordRefund.ts' --dir summaries/
npx suss ask 'what reaches recordRefund' --dir summaries/
```

[Ask about a codebase](/guides/ask) works through the questions and the answers. From a coding agent the same questions arrive over MCP, which [Give your agent suss](/start/give-your-agent-suss) sets up.

**What you get.** The file and the line for every unit that reads or writes a store, every boundary a route reaches, and every caller of a function, followed through as many hops as the calls take. An agent that asks before it edits a table or changes a signature knows what it is about to affect, and the person reviewing that change can ask the same question. A team shipping with agents gets the most here for the least, because this step needs nothing beyond step 1.

**What it costs.** Nothing beyond step 1 from the shell. The MCP server runs one extract when it starts and re-reads the affected part whenever a file changes.

**What a wrong answer looks like.** An answer that ends like this:

```
warning: 3 calls here resolved to no unit, so a boundary reaching readRow through one of them is missing from this answer.
```

is complete as far as suss could read, and it says where it stopped. An answer with no such line and a unit you know is missing is a bug in suss or in a pack; see [Is it a miss or a bug](#is-it-a-miss-or-a-bug) below.

## 3. Compare it against a document you already keep

Most services keep one document that says what they do: a Prisma schema, a CloudFormation or SAM template, a ts-rest router, an OpenAPI file. `suss contract` reads it into the same form as the code, and `check` compares the two:

```bash
npx suss contract --from cloudformation template.yaml -o summaries/template.json
npx suss check --dir summaries/
```

**What you get.** The first findings, and they are about the two halves of one deployment disagreeing:

```
[ERROR] boundarySelectorMismatch
  readRow picks items on OrdersTable by "customerId", which is not one of its key attributes (orderId). aws.dynamodb refuses a request keyed on anything else, so this fails when it runs.
  provider: cloudformation:template.yaml::OrdersTable (cloudformation:template.yaml:1)
  consumer: src/orderStore.ts::readRow (src/orderStore.ts:14)
  boundary: cloudformation (aws-sdk)
```

The template declares the table's key attributes and the code picks rows by something else. Neither file is wrong on its own, and TypeScript has nothing to say about it, because what the storage layer is handed is a string.

What compares against what, today:

- A Prisma schema against every query. The `prisma` pack reads the schema during `extract`, so this one needs no `contract` command at all. The schema is the provider and each query is a consumer, so a column no query reads, or a field no model declares, is a finding.
- A CloudFormation or SAM template against the code it deploys. The routes, the queues and the environment variables it wires all get compared against what the handler does with them.
- A contract written in the code, a ts-rest router or a `createRoute` under hono-openapi, against the handler behind it.
- An OpenAPI document against the handlers that serve it and the clients that call it. [Check against OpenAPI](/guides/check-against-openapi) covers both directions.
- A document your team wrote about what the code should do. [Check against your intent](/guides/check-against-intent) covers that one.

**What it costs.** One more command, and the first decisions. A finding is a bug in the code, a document that fell behind, or something you accept, and the third kind goes in `.sussignore.yml` with a reason so it does not come back.

**What a wrong answer looks like.** The contract declares a `401` and suss says no path produces it. Usually the `401` comes from middleware or an error handler registered around the route rather than from the handler itself. suss composes those in when it can see the registration, and when it cannot, because the middleware is built by a call it could not follow, the route looks as though it never produces the status. Accept it with a suppression rule, or open an issue with the `inspect` output for that route, since a wrapper suss cannot see is a pack gap and gets fixed.

## 4. Add the other side of a boundary

Read the code on the other side into the same directory: the frontend that calls the API, the worker that drains the queue, the other service.

```bash
# the web client that calls the API
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json

# or the service that drains the queue
npx suss extract --dir services/billing -f aws-lambda -f aws-sqs -o summaries/billing.json

npx suss check --dir summaries/
```

A client pairs with a handler when the method and the path match, so a client in `apps/web` and a handler in `services/api` compare against each other with nothing declared anywhere. On a queue the template is what says which consumer a producer reaches.

**What you get.** A finding that says which caller breaks:

```
[WARNING] boundaryFieldUnknown
  PaidWorkerFunction.handler reads "data.invoiceId" off a message on aws_sqs channel "PaidQueue" but no producer in the analysed scope sends "data.invoiceId". Likely a producer/consumer drift: the producer renamed or removed the field, or the consumer expects a field that was never sent.
  provider: cloudformation:template.yaml::PaidWorkerFunction.FromPaid (cloudformation:template.yaml:1)
  consumer: src/handlers/paidWorker.ts::PaidWorkerFunction.handler (src/handlers/paidWorker.ts:10)
  boundary: cloudformation (aws_sqs)
```

Before you remove a field or change a status, run this and read the list. An empty list, with every caller in the repository, means the change is safe as far as the code can say.

**What it costs.** One extract per consumer, and a bigger pile of findings the first time. Expect a first run over an old codebase to produce more than you want to read in one sitting. `check --at 'GET /users/:id'` narrows to one boundary, and the severity split is there so that first run is not all or nothing: errors fail, warnings print.

**What a wrong answer looks like.** `unhandledProviderCase` says a client never branches on a status the handler produces. A client that handles every non-2xx status in one shared interceptor does handle it, and suss reports the warning anyway when it could not follow the interceptor to the branch. This is the most commonly accepted finding, and a suppression rule scoped to the kind and the boundary covers it. [Accept a finding](/guides/accept-a-finding) has the three patterns.

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

**What you get.** On a pull request too large to read in full, the diff is the thing a reviewer reads first:

```
1 boundary changed: 2 outcomes.

~ serves bus:aws_sqs (channel named at runtime)  src/handlers/shippedWorker.ts::ShippedWorkerFunction.handler  (2 outcomes)
  outcomes
    + return { shipped }  when  typeof invoiceId !== "string"
    - throw Error  when  typeof invoiceId !== "string"
```

Two lines say that a message with no `invoiceId` now comes back as a successful `{ shipped }` rather than throwing, whichever of the changed lines did it. A quiet diff says the change altered nothing any unit does. That is what a reviewer wants to hear about a refactor.

**What it costs.** Two extracts per pull request instead of one, and the decision of what fails the build. Start at `error`. Tighten to `warning` once every accepted finding is in `.sussignore.yml` and a new warning means something.

**What a wrong answer looks like.** A quiet diff after a change you know altered behavior. The changed code is behind a call suss could not follow, and step 1's `Could not follow` line under that unit says which call.

## 6. Reuse the summaries

Everything above reads one JSON file per extract, and so can anything else.

- **Agent context.** Hand `AGENTS.md` to the agent (it ships in the package, at `node_modules/@suss/cli/AGENTS.md`), or run the MCP server from step 2. The agent learns what a route does without reading the handler.
- **Endpoint documentation.** `inspect` over a service describes every route, and re-running it keeps that current. `suss infer intent` drafts a behavior document from the summaries for people to edit.
- **Test cases.** Each path in a summary is a case a test could cover: the predicate is the setup and the transition is the assertion. A route with five paths and two tests has three that nothing exercises.

[Summary format](/reference/summary-format) documents the file, and it is stable.

## Triaging a finding

A finding has a kind, a severity, a provider, a consumer and a boundary. Read it as a claim about the two sides, then decide which of three things it is.

- A bug in the code. Fix the code, and the finding goes away on the next run.
- A document that fell behind. Fix the document.
- Something you accept. Add a rule to `.sussignore.yml` with a `reason`. The finding prints the rule, so this is a paste.

Errors are findings where the code on one side cannot work against the other, such as reading a field the other side never sends. Warnings are judgement calls, such as a status with no branch for it. `check --json` writes the same findings for tooling to read, and `--at` narrows a run to one boundary while you work through it.

## Is it a miss or a bug

suss says when it could not read something, and that is the first thing to look for.

- A `Could not follow` line under a unit in `inspect` output, or a `could not follow` sentence at the end of an `ask` answer, means a call landed somewhere suss could not read. Whatever is behind it is missing from the answer, and the answer says so.
- `confidence: low` on a summary or a finding says the same thing about the summary as a whole.
- `extract --explain` prints what each pack matched, file by file, so a service that came out thin shows where the reading stopped.

A miss is an absence with one of those markers on it. A bug is a path in the output the code does not have, or an absence with no marker at all. The [issue tracker](https://github.com/nimbuscloud-ai/suss/issues) is the place for one, with the `inspect` output for the unit pasted in.
