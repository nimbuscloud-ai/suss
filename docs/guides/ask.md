---
title: Ask about a codebase
description: Six questions a developer asks in a week, each run against a small Lambda service, with the answer suss gives.
---

# Ask about a codebase

Ask one question about code you have already extracted. suss works the answer out from the summaries on disk, so it does not read your code again and the answer takes milliseconds.

```bash
npx suss ask 'what reads aws.dynamodb:OrdersTable' --dir summaries/
```

<!-- suss:example fixtures=storage-wrapper -->

Every answer on this page comes from one small service: a Lambda that serves `GET /orders/{customer}`, a storage layer it calls, and the SAM template that declares the DynamoDB table behind it. Read both sides into one folder first:

```bash
suss extract --dir fixtures/storage-wrapper -f aws-lambda -f aws-dynamodb -o summaries/code.json
suss contract --from cloudformation fixtures/storage-wrapper/template.yaml -o summaries/infra.json
```

The [`suss ask` reference](/reference/cli/ask) lists the question grammar and the JSON each answer comes back in.

## What does this route touch?

Ask this before you change a handler.

```bash
suss ask 'what does GET /orders/{customer} reach' --dir summaries/
```

```
GET /orders/{customer}, 1 summary, reaches 1 boundary:
  reads aws.dynamodb:{location.table}  through client.send, by calling readRow
```

The route's own code does not mention a table. The table name comes from an argument passed to the storage layer, and `by calling readRow` shows the call that leads there.

## Who reads this table?

Before you rename a column or retire a table, find out what reads it.

```bash
suss ask 'what reads aws.dynamodb:OrdersTable' --dir summaries/
```

```
1 unit reads aws.dynamodb:OrdersTable:
  readRow (src/orderStore.ts:14)  at aws.dynamodb:{location.table} through client.send, which grounds to orders-v1 via storage-wrapper::src/orders.ts::GetOrderFunction.getOrder

aws.dynamodb:OrdersTable is provided by cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable.
```

The table has two spellings here: `OrdersTable`, the resource in the template, and `{location.table}`, the argument the storage layer reads. Either spelling finds the same unit, and the answer shows how the two connect. Ask `what writes` the same way for the other direction.

## Who calls this file?

A signature change needs this list first.

```bash
suss ask 'what calls src/orderStore.ts' --dir summaries/
```

```
1 unit calls storage-wrapper::src/orderStore.ts::readRow:
  storage-wrapper::src/orders.ts::GetOrderFunction.getOrder (src/orders.ts:6, provides GET /orders/{customer}) calls readRow
```

suss lists each caller with the boundary it serves, so you can see which route the change reaches without following the call chain yourself. You write a unit the same way `--at` takes one: a file, a `file:line`, a summary id or a function name. If a bare name matches two functions in two places, suss refuses the question and lists both.

## Which boundaries would I break?

This is the last question again, followed through every hop until it reaches a boundary.

```bash
suss ask 'what reaches readRow' --dir summaries/
```

```
1 boundary reaches readRow:
  GET /orders/{customer}, by calling readRow

warning: 3 calls here resolved to no unit, so a boundary reaching readRow through one of them is missing from this answer.
```

`what calls` follows one hop and `what reaches` follows every hop, so this answer gives you routes and queues instead of the functions in between. Read the warning at the end. The answer is complete as far as suss could follow the calls, and the warning says how many calls it could not follow.

## What can I ask this table for?

```bash
suss ask 'what can I project from aws.dynamodb:OrdersTable' --dir summaries/
```

```
aws.dynamodb:OrdersTable declares 1 thing you can ask it for:
  field orderId (S)  from cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable
```

The attributes a DynamoDB table declares are in terraform or in a SAM template, where TypeScript cannot see them. Ask the same question about a contract and you get the statuses it declares. Ask it about a runtime and you get the environment variables it takes.

When nothing on disk declares the answer, suss says which file would. It does not build an answer out of whatever the call sites happen to ask for.

## How does it get there?

```bash
suss ask 'why does getOrder reach aws.dynamodb' --dir summaries/ --project fixtures/storage-wrapper
```

```
GetOrderFunction.getOrder reaches aws.dynamodb:
  GetOrderFunction.getOrder -> readRow -> client.send
  GetOrderFunction.getOrder (src/orders.ts:6, provides GET /orders/{customer}) calls readRow, and that call runs readRow (src/orderStore.ts:14):
    readRow (src/orders.ts:9) -> readRow (src/orders.ts:4) -> readRow (src/orderStore.ts:14)
    readRow (src/orders.ts:9) is declared as readRow (src/orders.ts:4)
    readRow (src/orders.ts:4) is imported from src/orderStore.ts under the name readRow
  readRow reads aws.dynamodb:{location.table} through client.send (src/orderStore.ts:14)
```

suss builds the chain from the summaries, then re-reads the source to prove the steps under each hop. This is the only question that goes back to the files, so it takes `--project` to say where they are. suss proves each hop with the adapter for that hop's language, so a project that mixes TypeScript, Python and Ruby gets each hop proved the right way.

When a hop comes only from an import, with no call written in the code, it prints without resolution steps. A hop through a wrapper that a pack declares prints the assumption it depends on, as in `assuming a pack declares that withSentry from @sentry/serverless passes argument 0 through to its result`. [How suss follows a value](/theory/resolving-values) walks through the facts and the rules behind one of these chains.

## The same questions in symbols

Five questions have a symbol form, for asking the same thing often. The arrows point the way the calls go.

| Symbols | The question it means |
|---|---|
| `<- <unit>` | `what calls <unit>` |
| `<unit> ->` | `what does <unit> reach` |
| `<unit> -> <boundary> ?` | `why does <unit> reach <boundary>` |
| `r<- <boundary>` | `what reads <boundary>` |
| `w<- <boundary>` | `what writes <boundary>` |

```bash
suss ask 'r<- aws.dynamodb:OrdersTable' --dir summaries/
```

```
1 unit reads aws.dynamodb:OrdersTable:
  readRow (src/orderStore.ts:14)  at aws.dynamodb:{location.table} through client.send, which grounds to orders-v1 via storage-wrapper::src/orders.ts::GetOrderFunction.getOrder

aws.dynamodb:OrdersTable is provided by cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable.
```

Both forms take the same spellings and give the same answer, in text and under `--json`. suss splits the parts on spaces, because no key, id or path contains `<-`, `->` or a trailing `?`.

## Long answers, and answers for something other than a person

A long answer stops after ten items and prints how many are left:

<!-- suss:unchecked it runs over summaries of the suss workspace itself, which are built by npm run check:self rather than by a command on this page -->

```
@suss/checker provides 43 boundaries:
  fn:@suss/checker::analyzeFlow, from analyzeFlow (src/flow/reachability.ts:413)
  ...
  ... and 33 more. Run the same command with --all to see them.
```

`--all` writes every item out. `-o FILE` writes the answer to a file instead of stdout, and `--json` gives the same answer as `{ question, shape, subject, found, headline, items, needs, caveats }`, with the chain and the hops added for a why question. `--json` always lists everything, so `--all` changes nothing there.

## From an agent

Your agent can ask the same questions over MCP before it edits a table or changes a signature. [Give your agent suss](/start/give-your-agent-suss) sets that up. The server keeps its summaries current as files change, so every answer describes your working tree as it is now.
