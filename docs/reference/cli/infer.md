---
title: suss infer
description: "Draft a file for a person to finish: a dependency stub, one boundary intent doc per boundary, or a PRD built from curated intent."
---

# `suss infer`

Write a first draft for a person to finish. Three subcommands: `stub`, `intent` and `prd`.

Every draft leaves blanks, one for each thing reading code cannot tell you. The reader rejects a file that still has one, so an uncurated draft never passes for finished.

## `suss infer stub`

```
suss infer stub <package> [-p <tsconfig> | --dir <directory>] [-o <file | ->]
```

| Flag or argument | Default | What it does |
|---|---|---|
| `<package>` | required | The package to draft a [dependency stub](/guides/teach-a-dependency) for. |
| `-p`, `--project <path>` | the nearest tsconfig | The tsconfig covering the code to read. |
| `--dir <path>` | the working directory | Read this directory, for a project with no tsconfig, or for Python or Ruby. |
| `-o`, `--output <path>` | `suss/stubs/<package>.yaml` under the resolved source root | Where the draft goes. `-o -` prints it instead. An existing file is never written over. |

What counts as evidence, and what one draft file covers, depends on the language:

| Language | What it drafts | From |
|---|---|---|
| TypeScript | One `performs-call` candidate per export the code calls, with the argument shapes seen at each call site as comments, and `system` and `spec` left blank. | The project's calls into the package. |
| Python | A `re-exports` candidate per module the project imports the package, or a submodule of it, from. `of:` is filled in when the imported names all belong to one known pack. | The project's imports. |
| Ruby | An `extends-base` candidate per superclass spelled from the package that a project class extends, with `class:` filled in and `extends:` blank. | The project's requires and superclasses. |

A Ruby class extending one of graphql-ruby's or rails' own root classes directly is skipped, since the pack already stops there; when that leaves nothing, the statement is blank with those root classes in a comment. A Python package can draft one file per imported module, so `-o` is only valid when there is exactly one.

MCP hosts get the same skeleton from the `suss_stub_draft` tool.

```
$ suss infer stub axios -p tsconfig.json -o -
# Draft stub for axios, from 2 observed call sites.
# Fill each blank from the package's own source, then delete the
# notes. The statement kinds are in design/proposals/dependency-stubs.md.
package: "axios"
authored: ""  # who filled the blanks, e.g. agent
from: ""  # what the claims were read from, e.g. crate source at 1.4.2
statements:
  # default.create: 2 calls
  #   src/api-client.ts:7  ({baseURL})
  #   src/petstore-client.ts:15  ({baseURL})
  - kind: performs-call
    export: "default.create"
    system: ""  # what the call reaches: aws.sqs, aws.events, axios
    spec: {}  # argument meanings, e.g. { subject: { at: 0 }, payload: { at: 1 } }
```

## `suss infer intent`

```
suss infer intent --from <summaries.json | directory> [-o <directory> | --into <directory>]
```

| Flag | Default | What it does |
|---|---|---|
| `--from <path>` | required | The summaries to read, from `suss extract`. A folder works too, and every `.json` in it is read, which is what a project with one file per pack has. |
| `-o`, `--out <path>` | `intent/` | Where the docs go. Docs already there are written over, with a warning first. |
| `--into <path>` | none | The same folder, for a re-inference kept apart from what you have curated. It refuses to write where intent docs already are. |

It writes one [boundary intent doc](/why/kinds-of-contract) per boundary in the summaries, from what the code does today. Pick the boundaries at extract time, with `extract`'s own `--files` and `-f`; `infer intent` drafts every boundary in the file it is given.

```bash
suss extract -p tsconfig.json -f express -o summaries/code.json
suss infer intent --from summaries/code.json --out intent/
```

```yaml
# GET /report, as the code has it today.
# Read from src/server.ts, by way of summaries/code.json.
#
# Written from what the code does, so it says nothing about why. Fill in
# purpose and audience, rename this document and its outcome ids to what
# your team calls them, then set source to "inferred, curated" so findings
# against it count at full severity.

kind: boundary

name: get-report
purpose: "" # what this boundary is for, in your words
audience: "" # who observes it: a customer, an operator, another service
source: inferred

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /report

transitions:
  - id: 200-ok
    when: every call reaches this outcome
    response:
      status: 200
      body:
        type: object
        properties:
          report:
            type: string
```

An outcome id comes from the status code, and the body from the shape the handler produces. A body shape the intent schema has no spelling for is left out rather than guessed at.

`when` says what the branch turned on, in the same verbs `results` takes. The subject is a boundary verb whose value is the boundary's name, or `input:` with the path the caller sent; the check is one of `finds`, `is`, `equals` or `has`, and `where` narrows it:

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
```

The last branch states its own condition rather than saying `otherwise`, since the summary records its guards as the negations of the ones above it. A word meaning "not the branches above" would change what it claims the moment somebody inserts a transition over it, and these files are hand-edited. `otherwise` is left for a default branch whose guards the summary never recorded. A guard that maps to none of that keeps a sentence, and a `when` written as one plain string stays valid.

A boundary that is not HTTP gets a doc the same way, and then `results` says what the transition did at other boundaries:

```yaml
    results:
      - writes: aws.dynamodb:Invoices
        by: [invoiceId]
```

The key is the verb and the value is the boundary's own name, which is the same string [`suss ask`](/reference/cli/ask) takes. A clause can also say `fields`, the columns the access touches, and `by`, what it picks the item out by; both are drafted when the summary has them. The checker compares `results` both ways: a declared write the code never makes is an error, and a boundary the code reaches that no outcome mentions is info.

Boundary intent covers REST, function-call, message-bus, storage and unit-invocation boundaries. Anything else, a GraphQL, runtime-config or metric boundary, or a boundary whose summaries never record a transition producing a response, a return, a throw or an effect, is reported with the reason instead of drafted:

```
$ suss infer intent --from summaries/code.json --out intent/
Drafted 4 boundary intent docs in /home/dana/shop/intent, each with purpose and audience left blank. Fill them in, rename the outcome ids to what your team calls them, then set source to "inferred, curated". Until then `suss check --intent` says which files are still waiting.

No document for 1 boundary:
  - function-call:reachable: it has no key the checker could pair intent against: a function-call boundary needs package + exportPath
```

A store is reported too, for a different reason: storage has no identity key, so a doc naming one could never be paired. The reported reason points at the alternative, which is to write `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches the store.

Curating a doc means filling in purpose and audience, renaming the outcome ids to what your team calls them, and setting `source: "inferred, curated"`. `source` is what the checker reads to decide severity: a finding against bare `inferred` intent is downgraded one level, and curation restores it. Until then `suss check --intent` reports the drafts still waiting rather than checking them.

Re-inference is naive. It writes the docs again from the current code and takes any curation with them. `--into` is there so you can put a fresh run beside the curated one and reconcile the two by hand.

## `suss infer prd`

```
suss infer prd --from <intent-directory> [-o <directory> | --into <directory>]
```

| Flag | Default | What it does |
|---|---|---|
| `--from <path>` | required | The folder of curated boundary intent to read. |
| `-o`, `--out <path>` | the folder they were read from | Where the PRDs go. |
| `--into <path>` | none | The same folder, for a re-draft kept apart. It refuses to write where PRDs already are. |

It writes one PRD per curated boundary intent, with a scenario per outcome and the link already filled in. The link is the part a machine can supply, since it is the boundary document's `name` and the outcome's `id`. The words are not.

```bash
suss infer intent --from summaries/code.json --out intent/
# a person fills in purpose and audience, and renames the outcome ids
suss infer prd --from intent/
```

```yaml
# Why archive-order behaves the way it does, for somebody to write.
# One scenario per outcome it declares, read from intent/.

kind: prd

title: "" # what this document covers, in your words
purpose: "" # why it matters
audience: "" # who cares about it
source: inferred

scenarios:
  - when: "" # the situation, in your words
    expect: "" # what should happen, in your words
    link: archive-order.order-accepted-for-archiving
```

It reads intent rather than summaries, and refuses the whole folder when any document in it is still an uncurated draft:

```
$ suss infer prd --from intent/
4 intent doc(s) in /home/dana/shop/intent are inferred drafts with blanks still in them:
  - get-report.intent.yaml
  - get-sessions-id.intent.yaml
  - post-orders-id-archive.intent.yaml
  - post-report.intent.yaml
Write them and set source to "inferred, curated", or take those files out of the intent folder until you do.

A PRD links to outcome ids, so everything in the folder has to load before this can write one.
```

Drafting both at once would link to `200-ok`, and renaming that outcome is the first thing curation does. The PRD would then point at an id nothing declares, and `danglingScenarioLink` would fire on a file suss wrote itself. Reading intent also means the command needs no summaries at all, which matches what the checker does: a PRD can be checked before any code exists.

A boundary intent a scenario already points at is left alone, so running this again after adding an endpoint writes only what is missing.

[Exit codes](/reference/cli/exit-codes) says what each `infer` subcommand returns to the shell.
