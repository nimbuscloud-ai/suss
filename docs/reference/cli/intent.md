---
title: suss intent
description: List the outcome ids a PRD scenario can link to, from the boundary intent documents in a folder.
---

# `suss intent`

`suss intent` reads the intent documents in a folder. It has one subcommand today, `outcomes`.

## `suss intent outcomes`

```
suss intent outcomes --from <intent-directory> [--json]
```

| Flag | Default | What it does |
|---|---|---|
| `--from <path>` | required | The folder of intent documents to read. |
| `--json` | off | Write the rows as JSON instead of prose. |

A PRD scenario points at an outcome with `link: <intent-name>.<outcome-id>`. The name is a boundary intent document's `name` and the id is one of the ids under its `transitions`, so both halves are written inside a document somebody else wrote. This command lists them, so whoever writes the scenario can pick a link off the list. A link nothing declares comes back from `suss check --intent` as `danglingScenarioLink`.

A PRD in the folder is skipped, since a PRD links to outcomes rather than declaring any.

<!-- suss:example -->

`intent/archive-order.intent.yaml` states what one route should do:

```yaml
kind: boundary

name: archive-order
purpose: Take an order off the active list once it has shipped.
audience: the operations console
source: author

boundary:
  transport: http
  semantics: rest
  method: POST
  path: /orders/:id/archive

transitions:
  - id: archived
    when:
      - reads: aws.dynamodb:Orders
        finds: something
    response:
      status: 200
  - id: no-such-order
    when:
      - reads: aws.dynamodb:Orders
        finds: nothing
    response:
      status: 404
```

```bash
suss intent outcomes --from intent/
```

```
intent/archive-order.intent.yaml
  archive-order.archived       POST /orders/{id}/archive  responds 200 when reads aws.dynamodb:Orders finds something
  archive-order.no-such-order  POST /orders/{id}/archive  responds 404 when reads aws.dynamodb:Orders finds nothing
```

The three columns are the link to write, the boundary the document is about, and how the outcome ends and what it turns on. The format has no description field, so the last column is built from the outcome's ending and its `when`.

## Reading it from a program

`--json` writes one object per outcome, with the file and the line the id is written on:

```bash
suss intent outcomes --from intent/ --json
```

<!-- suss:excerpt -->

```
  {
    "link": "archive-order.archived",
    "intent": "archive-order",
    "boundary": "POST /orders/{id}/archive",
    "outcomeId": "archived",
    "description": "responds 200 when reads aws.dynamodb:Orders finds something",
    "file": "intent/archive-order.intent.yaml",
    "line": 15
  },
```

MCP hosts get the same rows from the `suss_intent_outcomes` tool. [Give your agent suss](/start/give-your-agent-suss) sets that up.

## Outcomes an uncurated draft declares

`suss infer intent` gives each outcome it drafts the status code as its id, and renaming those is the first thing curation does. A link to `get-report.200-ok` written today points at nothing once somebody renames that outcome, so a draft's ids are listed under a line of their own and left out of `--json`:

```
These ids are not settled. Curation renames the outcomes of an inferred draft, so a link to one of these can break:

intent/get-report.intent.yaml
  get-report.200-ok  GET /report  responds 200 when every call reaches this outcome
```

Curating a document means filling in its `purpose` and `audience`, renaming its outcome ids to what your team calls them, and setting `source: "inferred, curated"`. [`suss infer`](/reference/cli/infer) describes the drafting that comes before this.

## Exit codes

| Code | When |
|---|---|
| 0 | At least one curated boundary intent document declares an outcome. |
| 1 | The folder has no boundary intent, or everything in it is still an uncurated draft. |
| 1 | There is no folder at the path `--from` gives. |

A file in the folder that cannot be read at all is reported on stderr and passed over, so one broken document does not hide the rest.

[Exit codes](/reference/cli/exit-codes) lists the other commands.
