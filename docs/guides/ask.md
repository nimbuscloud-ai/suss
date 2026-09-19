---
title: Ask about a codebase
description: Six questions a developer asks in a week, each run against a small Lambda service, with the answer suss gives.
---

# Ask about a codebase

Ask one question about code you have already extracted. The answer comes out of the summaries on disk, so nothing is read again and the whole thing takes milliseconds.

```bash
npx suss ask 'what reads aws.dynamodb:OrdersTable' --dir summaries/
```

<!-- suss:example fixtures=storage-wrapper -->

Every answer on this page comes from one small service: a Lambda that serves `GET /orders/{customer}`, a storage layer it calls, and the SAM template that declares the DynamoDB table behind it. Read both sides into one folder first:

```bash
suss extract --dir fixtures/storage-wrapper -f aws-lambda -f aws-dynamodb -o summaries/code.json
suss contract --from cloudformation fixtures/storage-wrapper/template.yaml -o summaries/infra.json
```

The [`suss ask` reference](/reference/cli/ask) has the question grammar and the JSON the answers come back as.

## What does this route touch?

The question before you change a handler.

```bash
suss ask 'what does GET /orders/{customer} reach' --dir summaries/
```

```
GET /orders/{customer}, 1 summary, reaches 1 boundary:
  reads aws.dynamodb:{location.table}  through client.send, by calling readRow
```

The route itself never says which table. The name comes out of an argument its storage layer is handed, and `by calling readRow` is the hop that gets there.

## Who reads this table?

The question before you rename a column or retire a table.

```bash
suss ask 'what reads aws.dynamodb:OrdersTable' --dir summaries/
```

```
1 unit reads aws.dynamodb:OrdersTable:
  readRow (src/orderStore.ts:14)  at aws.dynamodb:{location.table} through client.send, which grounds to orders-v1 via storage-wrapper::src/orders.ts::GetOrderFunction.getOrder

aws.dynamodb:OrdersTable is provided by cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable.
```

The table has two spellings here: `OrdersTable`, the resource in the template, and `{location.table}`, the argument the storage layer reads. Either spelling finds the same unit, and the answer says how the two connect. Ask `what writes` the same way for the other direction.

## Who calls this file?

The question before you change a signature.

```bash
suss ask 'what calls src/orderStore.ts' --dir summaries/
```

```
1 unit calls storage-wrapper::src/orderStore.ts::readRow:
  storage-wrapper::src/orders.ts::GetOrderFunction.getOrder (src/orders.ts:6, provides GET /orders/{customer}) calls readRow
```

Each caller says which boundary it serves, so you can see the route the change reaches without following the call chain yourself. A unit is spelled the way `--at` spells one: a file, a `file:line`, a summary id, or a function name. A bare name that is two functions in two places is refused, with both listed.

## Which boundaries would I break?

Same question as the last one, followed all the way out.

```bash
suss ask 'what reaches readRow' --dir summaries/
```

```
1 boundary reaches readRow:
  GET /orders/{customer}, by calling readRow

warning: 3 calls here resolved to no unit, so a boundary reaching readRow through one of them is missing from this answer.
```

`what calls` is one hop and `what reaches` is every hop, so the answer here is routes and queues rather than the functions between them. The warning is the part worth reading: the answer is complete as far as suss could follow the calls, and it says how far that was.

## What can I ask this table for?

```bash
suss ask 'what can I project from aws.dynamodb:OrdersTable' --dir summaries/
```

```
aws.dynamodb:OrdersTable declares 1 thing you can ask it for:
  field orderId (S)  from cloudformation:fixtures/storage-wrapper/template.yaml::OrdersTable
```

The attributes a DynamoDB table declares live in terraform or a SAM template, where TypeScript cannot see them. Put a contract in place of the table and you get the statuses it declares; put a runtime there and you get the environment variables it takes.

When nothing on disk declares the answer, suss says which file would give it rather than assembling one out of what the call sites happen to ask for.

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

The chain comes from the summaries and the steps under each hop are proved from the source, which the question re-reads for the occasion. That is the one question that goes back to the files, so it takes `--project` to say where they are. Each hop is proved through the adapter for its own language, so a project mixing TypeScript, Python and Ruby proves each hop the right way.

A hop that only an import records, with no written call behind it, prints without resolution steps. A hop through a wrapper a pack declares says what it rests on, as `assuming a pack declares that withSentry from @sentry/serverless passes argument 0 through to its result`. [How suss follows a value](/theory/resolving-values) walks through the facts and the rules behind one of these chains.

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

Both forms take the same spellings and give the same answer, in text and under `--json`. The parts separate on spaces, since `<-`, `->` and a trailing `?` are characters no key, id or path contains.

## Long answers, and answers for something other than a person

A long answer stops after ten items and says how many are left:

<!-- suss:unchecked it runs over summaries of the suss workspace itself, which are built by npm run check:self rather than by a command on this page -->

```
@suss/checker provides 43 boundaries:
  fn:@suss/checker::analyzeFlow, from analyzeFlow (src/flow/reachability.ts:413)
  ...
  ... and 33 more. Run the same command with --all to see them.
```

`--all` writes every item out. `-o FILE` writes the answer to a file instead of stdout, and `--json` gives the same answer as `{ question, shape, subject, found, headline, items, needs, caveats }`, with the chain and the hops added for a why question. `--json` always lists everything, so `--all` changes nothing there.

## From an agent

The same questions arrive over MCP, where an agent asks before it edits a table or changes a signature rather than after. [Give your agent suss](/start/give-your-agent-suss) sets that up. The server keeps its summaries current as files change, so an answer describes the working tree rather than whatever was last extracted.
