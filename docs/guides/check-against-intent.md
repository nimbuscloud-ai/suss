---
title: Check against your intent
description: Draft intent documents from the code, curate them, and compare what the code does against what your team said it should do.
---

# Check against your intent

Compare the code against what your team said it should do. The other side of this comparison is a document your team wrote, instead of more code or a document somebody else published.

```bash
npx suss check --dir summaries/ --intent intent/
```

An intent document is a YAML file your team writes and commits. There are two kinds:

- **Boundary intent** (`*.intent.yaml`) states what one boundary should do, as in `POST /auth/login` returns 429 with `{ error, retryAfter }`. It is structural, and the checker compares it against the code directly.
- **A PRD** (`*.prd.yaml`) states what should happen for the person using the system, written as scenarios. Each scenario links to an outcome a boundary document declares, or lists the test that covers it.

An OpenAPI document or a Prisma schema covers some of this, but somebody wrote it as a wire contract or a data model. It does not record what the team wanted. An intent document lists what must exist and puts no limit on what else the code may do. When the code does more than the document states, suss reports that as info.

## Write one from the code

<!-- suss:example fixtures=storage-wrapper -->

On a codebase that already exists, `suss infer intent` writes one starting document per boundary from what the code does today. The example here is a small Lambda service that serves `GET /orders/{customer}` over a DynamoDB table, read from both its source and its SAM template:

```bash
suss extract --dir fixtures/storage-wrapper -f aws-lambda -f aws-dynamodb -o summaries/code.json
suss contract --from cloudformation fixtures/storage-wrapper/template.yaml -o summaries/infra.json
suss infer intent --from summaries --out intent/
```

```
Drafted 1 boundary intent doc in intent, each with purpose and audience left blank. Fill them in, rename the outcome ids to what your team calls them, then set source to "inferred, curated". Until then `suss check --intent` says which files are still waiting.

No document for 3 boundaries:
  - function-call:reachable: it has no key the checker could pair intent against: a function-call boundary needs package + exportPath, or module + exportName where the module is one suss.json lists
  - runtime-config:GetOrderFunction: boundary intent declares rest, function-call, message-bus, storage and unit-invocation boundaries, and this one is runtime-config
  - aws.dynamodb:OrdersTable: it has no key the checker could pair intent against: a store has no key at all: write it as `- writes: <store>` on an outcome of the boundary that touches it instead
```

When suss cannot draft a boundary, it reports the reason instead of passing over it. Here is the draft it did write:

```yaml
kind: boundary

name: get-orders-customer
purpose: "" # what this boundary is for, in your words
audience: "" # who observes it: a customer, an operator, another service
source: inferred

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /orders/{customer}

transitions:
  - id: 404-not-found
    when: readRow().Item is null
    response:
      status: 404
      body:
        type: object
        properties:
          error:
            type: string
  - id: 200-ok
    when: readRow().Item is not null
    response:
      status: 200
```

`purpose` and `audience` are blank on purpose. Nobody can tell from the code why the boundary exists or who it is for. An empty string does not satisfy the schema either, so a check over the folder refuses the draft and lists the files that are waiting:

```bash
suss check --dir summaries --intent intent/
```

```
1 intent doc(s) in intent are inferred drafts with blanks still in them:
  - get-orders-customer.intent.yaml
Write them and set source to "inferred, curated", or take those files out of the intent folder until you do.
```

The [`suss infer` reference](/reference/cli/infer) shows the draft for a queue consumer and for a Lambda too, and the `when` grammar.

## Curate it

Curating means filling in the two blanks, renaming the outcome ids to what your team calls them, and setting `source` to `"inferred, curated"`.

`intent/get-orders-customer.intent.yaml`, once somebody has been through it:

```yaml
kind: boundary

name: get-orders-customer
purpose: Let the storefront show a customer their latest order.
audience: the storefront
source: "inferred, curated"

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /orders/{customer}

transitions:
  - id: no-such-order
    when: readRow().Item is null
    response:
      status: 404
      body:
        type: object
        properties:
          error:
            type: string
  - id: the-order
    when: readRow().Item is not null
    response:
      status: 200
```

The checker uses `source` to set severity. It downgrades a finding against bare `inferred` intent by one level, because that document is still a guess taken from the code, and nobody has confirmed it. Curating the document restores the full severity.

Now the check has something to compare:

```bash
suss check --dir summaries --intent intent/
```

<!-- suss:excerpt -->

```
Intent:
  1 boundary intent checked against code
```

Intent findings come back in their own list, under `intent` in the JSON instead of under `findings`, because one side of the comparison is a document and not code. A parser that reads only `findings` never sees them.

## When the code and the document disagree

Say the team decides an archived order should come back as a 410 and writes that down ahead of the code:

`intent/get-orders-customer.intent.yaml`, with one more outcome:

```yaml
kind: boundary

name: get-orders-customer
purpose: Let the storefront show a customer their latest order.
audience: the storefront
source: "inferred, curated"

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /orders/{customer}

transitions:
  - id: no-such-order
    when: readRow().Item is null
    response:
      status: 404
      body:
        type: object
        properties:
          error:
            type: string
  - id: the-order
    when: readRow().Item is not null
    response:
      status: 200
  - id: archived-order
    when: the order has been archived
    response:
      status: 410
      body:
        type: object
        properties:
          error:
            type: string
```

```bash
suss check --dir summaries --intent intent/
```

<!-- suss:excerpt -->

```
Intent:
  1 boundary intent checked against code
  [error] GET /orders/{customer}: Intent "get-orders-customer" declares status 410 at GET /orders/{customer}; GetOrderFunction.getOrder has no transition that produces it.
```

This finding is `uncoveredOutcome`. It stays until the branch exists. The message is the same whether nobody ever built the outcome or somebody built it and later took it out.

With `results`, an outcome can also declare what the boundary did, in addition to what it returned. Take a queue consumer whose intent has an outcome that results in `- writes: aws.dynamodb:Invoices`. If no transition of that consumer writes the table, you get the same finding. The key is the verb, and the value is the boundary spelled the way `suss ask` takes one, so the question and the assertion use the same words.

## Write the PRD from the curated intent

```bash
suss infer prd --from intent/
```

```
Drafted 1 PRD in intent, each with a scenario per outcome and the words left blank. Write the situation and what should happen, then set source to "inferred, curated". Until then `suss check --intent` says which files are still waiting.
```

```yaml
kind: prd

title: "" # what this document covers, in your words
purpose: "" # why it matters
audience: "" # who cares about it
source: inferred

scenarios:
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: get-orders-customer.no-such-order
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: get-orders-customer.the-order
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: get-orders-customer.archived-order
```

suss can supply the link, which is the boundary document's `name` plus the outcome's `id`. You write the words.

`infer prd` reads intent documents instead of summaries, and it refuses a folder that still has uncurated boundary documents in it. If it drafted both at once, it would link to an id like `200-ok`, and renaming those ids is the first thing curation does, so the PRD would end up pointing at an id nothing declares.

A boundary intent that a scenario already points at is left alone, so running this again after adding an endpoint writes only what is missing.

## Back a scenario with a test

Some scenarios promise something about which values come back, and no outcome can say that: an archived order is left out of the list, a second cancel changes nothing. For those, the scenario lists the test that covers it, spelled the way the runner prints it, and says what the test has to reach:

```yaml
  - title: a second cancel
    when: a customer cancels an order that is already cancelled
    expect: nothing changes, and the customer is told it was already cancelled
    coveredBy: src/orders.test.ts > cancel > changes nothing the second time
    about: POST /orders/:id/cancel
```

Without `about`, the test has to reach one of the boundaries the PRD's other scenarios link to. Then read the tests your PRDs list along with the code, and check as before:

```bash
suss extract -f express -f vitest --intent intent/ -o .suss/code.json
suss check --dir .suss --intent intent/
```

`--intent` on `extract` hands the vitest pack the test files the PRDs list, so the run reads those and no others. The check then reports a listed test that is gone or renamed, one marked skip or todo, and one whose calls never reach the route, or reach it only through something the test replaced with `vi.mock`. The [intent format](/reference/intent-format#covering-tests) says how a test is spelled and what counts as reaching.

## Say what the boundary receives

The rest of the document says what a boundary returns and what it does. A `receives` block says what the boundary is passed. Add one to the boundary block, with a line per field:

```yaml
boundary:
  transport: in-process
  semantics: function-call
  package: "@suss/checker"
  exportPath: ["checkPair"]
  receives:
    provider: { type: object, required: true }
    consumer: { type: object, required: true }
```

Each key is a parameter name, and a dot goes inside a parameter, so `options.stream` says the boundary reads `stream` off the `options` argument. Listing a field is a complete declaration on its own: `consumer: {}` says the field is there and nothing more. `required: true` says the boundary needs it. A message-bus boundary writes its block the same way, with the fields of the message body.

The checker compares the block against the paths the unit actually reads. A declared field nothing reads is `unreadInputField`, at warning when it is required and info otherwise. A read of a path the block leaves out is `undeclaredInputRead`, at info, because a block lists what the author wanted checked and is not meant to describe the whole input. A document with no block says nothing about the input, and produces neither finding.

Rename the read in `checkPair` from `consumer` to something else and the run reports it:

```
[warning] fn:@suss/checker::checkPair: Intent "checker-check-pair" says fn:@suss/checker::checkPair receives consumer and needs it; checkPair never reads it.
```

A REST boundary writes its block in a section per part of the request. `headers`, `query` and `params` are maps from a name to a field. `body` is a schema, because a body is one value with properties under it:

```yaml
boundary:
  transport: http
  semantics: rest
  method: GET
  path: /invoices/:id
  receives:
    headers:
      x-tenant-id: { type: string, required: true }
    query:
      dryRun: { type: boolean }
    body:
      properties:
        note: { type: string }
```

Header names compare case-insensitively, since HTTP treats them that way and Node lowercases them before a handler sees one.

Each framework reads the parts of a request its own way, so each pack declares how its handlers read them. The Express, Fastify and AWS Lambda packs (Lambda under a proxy integration) declare it field by field. Hono reads a field through a method call with the name as the argument (`c.req.header("x-tenant-id")`). suss records the method but not the argument, so it can only compare a Hono section as a whole. Reading any header satisfies every declared header, and no header read is reported as undeclared. suss does not compare a route whose pack declares nothing about its request, the same way it skips a document with no block.

suss does not count two things a REST route does as a mismatch. A handler that passes the body to a validator (`schema.parse(req.body)`) has used the whole body, so suss does not report the block's body fields against it, and the other sections still compare. A read under `body` is never `undeclaredInputRead` when the block declares a body, because the body schema is where the body gets described.

A required header is often checked in middleware instead of in the handler. suss counts the reads of every wrapper registered around a route as the route's own, so it reports nothing for a route that never touches the header its middleware requires.

## What the checker reports

The [findings catalog](/reference/findings#intent-findings) lists the intent finding kinds, with what makes each one legitimate and what makes it a bug. The severity follows what is being compared:

- **Error**: the code does not do what an authored document says. `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch`, `renamedBoundary`, `pathWithoutEffect`.
- **Warning**: the documents have a gap, or nothing reads a field the document declares the boundary needs. An intent nothing can be paired against, a scenario linking to an outcome that does not exist, a link that resolves to two documents, a scenario with neither a link nor a test, a covering test that is missing, skipped or never reaches its subject, `unreadInputField` on a required field.
- **Info**: the code does more than the documents claim. A status no outcome mentions, a store no outcome mentions, an input field no `receives` block lists, an outcome no scenario explains.

## A boundary with no key to pair on

Some boundaries have no identity the checker can match a document against, and suss reports that instead of going quiet. A function-call boundary needs a package and an export path, and a message-bus boundary needs a channel. `unkeyableBoundary` is the warning for both, and the message tells you what that protocol would need.

A store is the one case where filling in fields does not help, because a container name can be a pattern that only a caller or the deployment resolves. Instead, put `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches the store, and the checker compares that.

## suss checks its own intent

<!-- suss:unchecked it runs over this repository's own packages, whose summaries npm run dogfood builds rather than a command on this page -->

The `intent/` directory in this repository says what suss promises the people who use it. Seven PRDs state features such as "A run that compares nothing fails and says why", and boundary documents state what the exports behind them do: the library functions a program calls, the functions the agent supervisor and the MCP server call, and the helpers a pack author calls. `npm run check:self` runs `suss check --intent` over the summaries `npm run dogfood` writes for every package, so a change that breaks `suss extract`, `suss check` or one of those exports breaks the self-check too.

`intent/contract-intent-loadChangeListFile.intent.yaml` says how suss reads the change list an agent writes, with one outcome for each way the function can end:

```yaml
kind: boundary

name: contract-intent-load-change-list
purpose: >-
  Read the change list an agent wrote before its first edit, or reject
  it with every problem listed, so the agent can fix them all in one go.
  suss intent check reads a change list through it, and tells a list
  somebody has to fix apart from any other failure by the error it
  throws.
audience: the suss agent supervisor, and programs that read change lists
source: author

boundary:
  transport: in-process
  semantics: function-call
  package: "@suss/contract-intent"
  exportPath: ["loadChangeListFile"]
  receives:
    filepath: { type: string, required: true }

transitions:
  - id: loaded
    when: the file parses and fits the change list schema
    returns:
      body:
        type: object
        properties:
          changes: { type: array }
          explained: { type: array }
        required: [changes, explained]

  - id: rejected
    when: the file is missing, does not parse, or does not fit the change list schema
    throws:
      errorType: ChangeListRejected
```

A scenario in `intent/checkAnAgentsEdit.prd.yaml` links to the rejection:

```yaml
  - title: the agent's change list does not fit
    when: the change list the agent wrote before its first edit does not fit the schema
    expect: suss rejects it and lists every problem, so the agent can fix them in one go
    link: contract-intent-load-change-list.rejected
```

If `loadChangeListFile` stopped throwing `ChangeListRejected`, the self-check would report `uncoveredOutcome` against the document and fail. A scenario whose promise is about which values come back lists the test that covers it under `coveredBy`, and so, for now, does a scenario about what a command prints, since suss has no boundary for a command's output yet. The dogfood run reads those test files with the vitest pack, and the self-check fails when one is renamed, skipped, or stops reaching its subject. On a green run the intent section starts with:

```
Intent:
  22 boundary intents checked against code
  7 PRDs checked: 39 scenarios, 16 resolved, 16 covered by tests, 2 unlinked
```

The two unlinked scenarios have no test yet, and `intent/self.sussignore.yml` accepts each one by its title, with the reason.
