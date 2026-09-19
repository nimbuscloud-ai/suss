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

- **Boundary intent** (`*.intent.yaml`) says what one boundary should do: `POST /auth/login` returns 429 with `{ error, retryAfter }`. Structural, and the checker compares it against the code directly.
- **A PRD** (`*.prd.yaml`) says what should happen for the person using it, as scenarios, and each scenario links to an outcome a boundary document declares.

An OpenAPI document or a Prisma schema expresses some of this, but it was written as a wire contract or a data model, not as a statement of what the team wanted. Intent documents are open specifications: they say what must exist, not what is allowed. Code that does more than the document says is reported as info rather than as a violation.

## Write one from the code

<!-- suss:example fixtures=storage-wrapper -->

On a codebase that already exists, `suss infer intent` writes one starting document per boundary from what the code does today. The example below is a small Lambda service, `GET /orders/{customer}` over a DynamoDB table, read from both its source and its SAM template:

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

A boundary that could not be drafted is reported with the reason rather than passed over. The draft it did write:

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

`purpose` and `audience` are blank on purpose. Why the boundary exists and who it is for cannot be read out of code, and an empty string does not satisfy the schema, so a check over the folder refuses the draft and says which files are waiting:

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

`source` is what the checker reads to decide severity. A finding against bare `inferred` intent is downgraded one level, since the declaration is still a guess read off the code rather than something a person confirmed. Curation restores the full severity.

Now the check has something to compare:

```bash
suss check --dir summaries --intent intent/
```

<!-- suss:excerpt -->

```
Intent:
  1 boundary intent checked against code
```

Intent findings travel in their own list, under `intent` in the JSON rather than under `findings`, because one side is a document rather than code. A parser reading only `findings` never sees them.

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

That is `uncoveredOutcome`. It stays until the branch exists, and it reads the same whether the outcome was never built or was built once and then removed.

An outcome can also declare what it did rather than what it returned, with `results`. A queue consumer whose intent says an outcome results in `- writes: aws.dynamodb:Invoices`, where no transition of it writes that table, produces the same finding. The key is the verb and the value is the boundary spelled the way `suss ask` takes one, so the question and the assertion use the same words.

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

The link is the half a machine can supply: the boundary document's `name` and the outcome's `id`. The words are the half it cannot.

`infer prd` reads intent rather than summaries, and refuses a folder with uncurated boundary documents in it. Drafting both at once would link to `200-ok`, which renaming is the first thing curation does, and the PRD would then point at an id nothing declares.

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

A REST boundary accepts a block with a section per part of the request (`headers`, `query`, `params` and `body`), and nothing is compared against it yet, because which of a handler's reads is which part of a request is the framework's vocabulary and no pack says it.

## What the checker reports

Twelve intent finding kinds, each with what makes it legitimate and what makes it a bug, are in the [findings catalog](/reference/findings#intent-findings). The severity follows what is being compared:

- **Error**: the code does not do what an authored document says. `unimplementedBoundary`, `uncoveredOutcome`, `outcomeShapeMismatch`, `renamedBoundary`.
- **Warning**: the documents have a gap, or nothing reads a field the document says the boundary needs. An intent nothing can be paired against, a scenario linking to an outcome that does not exist, a link that resolves to two documents, `unreadInputField` on a required field.
- **Info**: the code does more than the documents claim. A status no outcome mentions, a store no outcome mentions, an input field no `receives` block lists, an outcome no scenario explains.

## A boundary with no key to pair on

Some boundaries have no identity the checker can match a document against, and it says so rather than going quiet. A function-call boundary needs a package and an export path. A message-bus boundary needs a channel. `unkeyableBoundary` is the warning for both, and the message says what that protocol would need.

A store is the one case where filling fields in does not help, because a container name can be a pattern only a caller or the deployment settles. Say what the store is for by putting `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches it, and the checker compares that.

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

`source: author` rather than `inferred, curated`, because a person wrote it rather than editing a draft. On a green run the tail reads:

```
Intent:
  5 boundary intents checked against code
```
