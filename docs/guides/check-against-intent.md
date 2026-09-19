---
title: Check against your intent
description: Draft intent documents from the code, curate them, and compare what the code does against what your team said it should do.
---

# Check against your intent

Compare the code against what your team said it should do, rather than against another piece of code or a document somebody else published.

```bash
npx suss check --dir summaries/ --intent intent/
```

An intent document is a YAML file your team writes and commits. There are two kinds:

- **Boundary intent** (`*.intent.yaml`) states what one boundary should do, as in `POST /auth/login` returns 429 with `{ error, retryAfter }`. It is structural, and the checker compares it against the code directly.
- **A PRD** (`*.prd.yaml`) states what should happen for the person using the system, written as scenarios, and each scenario links to an outcome a boundary document declares.

An OpenAPI document or a Prisma schema expresses some of this, but somebody wrote it as a wire contract or a data model, not as a statement of what the team wanted. An intent document is an open specification: it states what must exist, and it does not limit what else the code may do. When the code does more than the document states, suss reports that as info.

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
  - function-call:reachable: it has no key the checker could pair intent against: a function-call boundary needs package + exportPath
  - runtime-config:cloudformation: boundary intent declares rest, function-call, message-bus, storage and unit-invocation boundaries, and this one is runtime-config
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

`purpose` and `audience` are blank on purpose. Nobody can read out of the code why the boundary exists or who it is for. An empty string does not satisfy the schema either, so a check over the folder refuses the draft and lists the files that are waiting:

```bash
suss check --dir summaries --intent intent/
```

```
1 intent doc(s) in intent are inferred drafts with blanks still in them:
  - get-orders-customer.intent.yaml
Write them and set source to "inferred, curated", or take those files out of the intent folder until you do.
```

The [`suss infer` reference](/reference/cli/infer) has the drafted shape for a queue consumer and a Lambda as well, and the `when` grammar.

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

The checker reads `source` to decide severity. It downgrades a finding against bare `inferred` intent by one level, because that declaration is still a guess read off the code and nobody has confirmed it. Curating the document restores the full severity.

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

That is `uncoveredOutcome`. It stays until the branch exists, and it reads the same whether nobody ever built the outcome or somebody built it and then took it out.

An outcome can also declare what it did, not only what it returned, using `results`. Take a queue consumer whose intent has an outcome that results in `- writes: aws.dynamodb:Invoices`. If no transition of that consumer writes the table, you get the same finding. The key is the verb, and the value is the boundary spelled the way `suss ask` takes one, so the question and the assertion use the same words.

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

`infer prd` reads intent documents, not summaries, and it refuses a folder that still has uncurated boundary documents in it. If it drafted both at once, it would link to an id like `200-ok`, and renaming those ids is the first thing curation does, so the PRD would end up pointing at an id nothing declares.

A boundary intent that a scenario already points at is left alone, so running this again after adding an endpoint writes only what is missing.

## Say what the boundary receives

A document says what a boundary returns and what it does. A `receives` block says what it is handed. Add one to the boundary block, with a line per field:

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

The name is the parameter, and a dot reaches inside one, so `options.stream` says the boundary reads `stream` off the `options` argument. Naming a field is a complete declaration on its own: `consumer: {}` says the field is there and nothing more. `required: true` says the boundary needs it. A message-bus boundary writes its block the same way, with the fields of the message body.

The checker compares the block against the paths the unit actually reads. A declared field nothing reads is `unreadInputField`, at warning when it is required and info otherwise. A read of a path the block leaves out is `undeclaredInputRead`, at info, because a block lists what the author wanted checked and is never a full description of the input. A document with no block says nothing about the input, and produces neither finding.

Rename the read in `checkPair` from `consumer` to something else and the run says so:

```
[warning] fn:@suss/checker::checkPair: Intent "checker-check-pair" says fn:@suss/checker::checkPair receives consumer and needs it; checkPair never reads it.
```

A REST boundary writes its block in a section per part of the request. `headers`, `query` and `params` are maps from a name to a field; `body` is a shape, because a body is one value with properties under it:

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

Which of a handler's reads is which part of a request is the framework's vocabulary, so each pack says how its handlers spell one. Express, Fastify and AWS Lambda under a proxy integration all say it field by field. Hono reads a field through a method with the name in the argument (`c.req.header("x-tenant-id")`), and a read records the method without the argument, so a Hono section can only be compared whole: reading any header satisfies every declared header, and no read of one is reported as undeclared. A route from a pack that says nothing about its request is not compared, the same way a document with no block is not.

Two things a REST route does are not a mismatch. A handler that passes the body to a validator (`schema.parse(req.body)`) has used it whole, so the block's body fields are not reported against it, and the other sections still compare. A read under `body` is never `undeclaredInputRead` when the block declares a body, because the shape is where the body gets described.

A required header is often checked in middleware rather than in the handler. The reads of every wrapper registered around a route count as the route's, so a route that never touches the header its middleware demands is quiet.

## What the checker reports

The [findings catalog](/reference/findings#intent-findings) lists the intent finding kinds, with what makes each one legitimate and what makes it a bug. The severity follows what is being compared:

- **Error**: the code does not do what an authored document says. `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch`, `renamedBoundary`.
- **Warning**: the documents have a gap, or nothing reads a field the document declares the boundary needs. An intent nothing can be paired against, a scenario linking to an outcome that does not exist, a link that resolves to two documents, `unreadInputField` on a required field.
- **Info**: the code does more than the documents claim. A status no outcome mentions, a store no outcome mentions, an input field no `receives` block lists, an outcome no scenario explains.

## A boundary with no key to pair on

Some boundaries have no identity the checker can match a document against, and suss reports that instead of going quiet. A function-call boundary needs a package and an export path, and a message-bus boundary needs a channel. `unkeyableBoundary` is the warning for both, and the message tells you what that protocol would need.

A store is the one case where filling in fields does not help, because a container name can be a pattern that only a caller or the deployment resolves. Instead, put `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches the store, and the checker compares that.

## suss checks its own intent

<!-- suss:unchecked it runs over this repository's own packages, whose summaries npm run check:self builds rather than a command on this page -->

The `intent/` directory in this repository has a boundary document for each public export of the two checker packages, and `npm run check:self` extracts those packages with the `package-exports` pack and pairs each document against them. Every step goes through the shipped CLI, so a change that breaks `suss extract` or `suss check` breaks the self-check with it.

`intent/checker-checkPair.intent.yaml` is one of them:

```yaml
kind: boundary

name: checker-check-pair
purpose: Run the provider/consumer checks for one summary pair and return the findings.
audience: downstream-consumers
source: author

boundary:
  transport: in-process
  semantics: function-call
  package: "@suss/checker"
  exportPath: ["checkPair"]
  receives:
    provider: { type: object, required: true }
    consumer: { type: object, required: true }

transitions:
  - id: findings
    when: called with a provider summary and a consumer summary
    returns:
      body:
        type: array
        items:
          type: object
          properties:
            kind: { type: string }
            severity: { type: string }
```

This one says `source: author` instead of `inferred, curated`, because a person wrote it from scratch rather than editing a draft. On a green run the tail reads:

```
Intent:
  5 boundary intents checked against code
```
