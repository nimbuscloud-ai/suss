---
title: suss intent
description: List the outcome ids a PRD scenario can link to, check a change against the change list written before it, and keep that list as intent documents.
---

# `suss intent`

`suss intent` works with intent. `outcomes` lists the outcome ids in a folder of intent documents. `check` compares a change list, the behavior changes somebody said they would make, with the summaries from before and after the change. `keep` writes a change list's entries as boundary intent documents.

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

<!-- suss:unchecked it compares readings of a project from before and after a change, and no fixture keeps both; the plugin's cancelOrder demo plays the same session and its test checks this output -->

## `suss intent check`

```
suss intent check <change-list> --before <dir | file> --after <dir | file> [--prompts <file>] [--json]
```

| Flag | Default | What it does |
|---|---|---|
| `--before <path>` | required | The summaries from before the change: a folder, whose files pair with the other side's by name and are compared together, or one file. |
| `--after <path>` | required | The summaries from after it, the same kind of path. |
| `--prompts <file>` | none | The developer's messages, to check each entry's quote against. A `.jsonl` file has one JSON object per line with the message under `prompt`, which is what the suss plugin records. Any other file is one message. |
| `--json` | off | Write the verdicts as JSON. |

A change list says, before the work starts, which behavior changes it will make. [Intent format](/reference/intent-format#the-change-list) goes through its fields. This command reads the list and the two readings, and says for each entry whether it is done, not done, or something suss cannot check, and which changes no entry asked for.

`changes.yaml`:

```yaml
asked: "Add POST /orders/:id/cancel. Cancelling sets cancelled_at ... 404 when the order does not exist."
changes:
  - adds: POST /orders/:id/cancel
    outcomes: [200, 404]
  - adds: { writes: postgresql:orders, fields: [cancelled_at] }
    at: POST /orders/:id/cancel
  - changes: Order.status
    note: gains the value "cancelled"
```

```bash
suss intent check changes.yaml --before .suss/before --after .suss/after
```

```
2 done, 1 unchecked and 1 boundary changed where nobody asked.

done        + POST /orders/{id}/cancel responds 200, 404  src/orders/cancel.ts::post
            + POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]  src/orders/cancel.ts::post
unchecked   ~ Order.status gains the value "cancelled"
              suss has no boundary spelled Order.status, so it cannot check this entry.
not asked   serves POST /orders  src/orders/create.ts::post
              + responds 409 { error }  when  !(!req.body.sku || !req.body.quantity) && orders.findOpen()
```

### What counts as done

| Entry | Done when |
|---|---|
| `adds: <boundary>` | The diff shows the boundary added or changed, and each outcome the entry lists is an outcome of a unit that serves the boundary now. |
| `changes: <boundary>` | The diff shows the boundary changed, and each outcome the entry lists is one that is new or changed there. |
| `removes: <boundary>` | With no outcomes, the diff shows the boundary removed. With outcomes, each one was an outcome of the boundary before the change and is not one after it. |
| `adds: { writes: S, fields: F }` at `B` | A request through B now reaches a write of S that states every field in F, and did not before. With no `at`, any boundary counts. |
| `removes: <effect>` at `B` | A request through B reached the effect before and does not now. |
| `changes: <effect>` at `B` | The diff shows B changed, and a request through B reaches the effect now. |

A boundary is spelled the way [`suss ask`](/reference/cli/ask) spells one, and it has to pick out one boundary exactly: `POST /orders` is not `POST /orders/:id/cancel`, and `:id` and `{id}` are the same. An effect is compared the way the `results` line of an intent document is, through whatever the request calls on the way.

An entry is unchecked when its subject is no boundary on either side and is not spelled like one: a route such as `POST /refunds`, or a `system:name` such as `postgresql:refunds`. A member of a type, such as `Order.status`, is unchecked. An unchecked entry never fails the run.

### What counts as not asked

Each line of the diff at a boundary, the lines [`inspect --diff`](/reference/cli/inspect#reading-a-diff) prints, is either asked for by some entry or not asked.

- A line at a boundary that no entry is about, through its subject or its `at`, is not asked.
- At a boundary an entry is about, every effect is asked for, and so is every line of a client calling it. An outcome of the handler's own body is asked for by a boundary entry that lists that outcome, or lists none. An outcome the handler had before as well, whose condition moved because of a new branch beside it, is asked for by any entry about the boundary.
- An effect entry with no `at` asks for that effect at every boundary, which covers a helper that many routes call.
- An outcome a wrapper brought is listed apart under `wrapper` and never counts either way.

A line that no entry asks for, and that an `explained` entry covers by the same rules, is listed under `explained` with the reason. Anything left over is not asked, one item per boundary.

### Whether the developer asked

With `--prompts`, the quote an entry gives, its own `asked` or else the list's, is checked against the messages. Case, spacing and the kind of quote mark do not matter, and `...` in a quote matches any stretch of the message. An entry whose quote is in no message, or that quotes nothing, is listed under `unrequested` with its verdict, for the developer to read. It does not fail the run.

### Reading it from a program

`--json` writes `{ version, entries, notAsked, explained, fromWrappers, text }`. Each entry has `said`, `verdict` (`done`, `notDone` or `unchecked`), `reason`, `units`, `asked` and `requested`. Each `notAsked` item is one boundary with its `lines`, and an `identity` that stays the same for as long as those lines do, so a caller can act on each change once. `text` is the report the command prints without `--json`. From Node, the same comparison is `checkIntent` in `@suss/cli`.

When the change list itself is missing, does not parse or does not fit its schema, `--json` writes `{ version, error, rejected }` instead, where `rejected` is `{ file, problems }` and each problem is `{ path, message }`. Any other failure writes `{ error }` alone, or nothing when suss did not get as far as writing. So a caller can tell a list somebody has to fix from a run that failed.

The [suss plugin for Claude Code](/guides/supervise-an-agent#the-change-list) runs this at every stop, against the change list the agent wrote before its first edit.

### Exit codes

| Code | When |
|---|---|
| 0 | Every entry is done or unchecked, and every change is one an entry asked for or an `explained` entry keeps. |
| 1 | An entry is not done, or a boundary changed where nobody asked. |
| 1 | The change list does not fit its schema, or `--before` and `--after` are missing, are one folder and one file, or have no summaries file in common. |

## `suss intent keep`

```
suss intent keep <change-list> --dir <dir | file> --audience <text> [--into <directory>]
```

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | required | The summaries of the code as it is now, a folder or one file. |
| `--audience <text>` | required | Who calls these boundaries, for each document's `audience`. |
| `--into <directory>` | `intent/` | Where the documents go. A document already there is left alone. |

Once the work is done, `keep` writes one `kind: boundary` document for each boundary the list's `adds` and `changes` entries are about. Each outcome a boundary entry lists compiles to one transition, and an effect entry compiles to one transition with its `results` line. A `removes` entry compiles to nothing, because a document states what a boundary does. The document's `purpose` is the request the entries quote, its `source` is `author`, and each `when` is the condition the code has for that outcome now, written the way [`suss infer intent`](/reference/cli/infer#suss-infer-intent) writes one.

```yaml
kind: boundary

name: post-orders-id-cancel
purpose: Add POST /orders/:id/cancel. Cancelling sets cancelled_at ... 404 when the order does not exist.
audience: the web client
source: author

boundary:
  transport: http
  semantics: rest
  method: POST
  path: /orders/:id/cancel

transitions:
  - id: 200-ok
    when:
      - reads: postgresql:orders
        where: rowCount is not 0
    response:
      status: 200
  - id: 404-not-found
    when:
      - reads: postgresql:orders
        where: rowCount is 0
    response:
      status: 404
  - id: writes-postgresql-orders
    when:
      - reads: postgresql:orders
        where: rowCount is not 0
    results:
      - writes: postgresql:orders
        fields:
          - cancelled_at
```

It leaves out a boundary nothing in `--dir` serves, a boundary whose entries quote no request, an effect entry with no `at`, and a file that is already there, and says so for each.

### Exit codes

| Code | When |
|---|---|
| 0 | At least one document was written. |
| 1 | No document was written, or `--dir` or `--audience` is missing. |

[Exit codes](/reference/cli/exit-codes) lists the other commands.
