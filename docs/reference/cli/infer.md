---
title: suss infer
description: "Draft the files a person then curates: a dependency stub, a boundary intent document, or a PRD built from curated intent."
---

# `suss infer`

`suss infer` writes a first draft for a person to finish. Three things
can be drafted: a dependency stub, one intent document per boundary, and
a PRD built from intent documents that have already been curated.

## `suss infer stub`

```bash
suss infer stub <package> [-p <tsconfig> | --dir <directory>] [-o <file | ->]
```

Writes a [dependency stub](/guides/teach-a-dependency) skeleton for a package the
project uses but extraction cannot read into. The evidence, and what one
draft file covers, depends on the language suss reads the directory as:

- **TypeScript**: one `performs-call` candidate per export the code
  calls, with the argument shapes observed at each call site as
  comments, and the semantic fields (`system`, `spec`) left blank.
- **Python**: a `re-exports` candidate per module the project imports
  the package (or a submodule of it) from, since the decorator match is
  exact per module. `of:` is filled in when the imported names all
  belong to one known pack, and left blank otherwise.
- **Ruby**: an `extends-base` candidate per superclass spelled from
  the package that a project class extends, with `class:` filled in
  and `extends:` left blank. A class that extends one of graphql-ruby's
  or rails' own root classes directly is skipped, since the pack
  already stops there. When that leaves nothing to draft, the
  statement is blank, with those root classes in a comment.

A TypeScript or Ruby draft lands in `suss/stubs/<package>.yaml` under the
resolved source root; an existing file is never overwritten. A Python
draft lands in one file per imported module, so `-o` is only valid when
there is exactly one. `-o -` prints the draft (or drafts) instead of
writing them. MCP hosts get the same skeleton from the `suss_stub_draft`
tool.

| Flag | Description |
|---|---|
| `-p`, `--project` | Path to the tsconfig covering the code to read. Without it, the nearest tsconfig wins, or the directory is read as-is. |
| `--dir` | Directory to read when there is no tsconfig, or when the code is Python or Ruby. |
| `-o`, `--output` | Where to write the draft; `-` prints it. |

## `suss infer intent`

```bash
suss infer intent --from <summaries.json | directory> [-o <directory> | --into <directory>]
```

Writes one [boundary intent doc](/why/kinds-of-contract) per boundary in a summaries
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

[Exit codes](/reference/cli/exit-codes#suss-infer-stub) says what each
`infer` subcommand returns to the shell.

