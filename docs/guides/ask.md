---
title: Ask about a codebase
description: Ask suss what writes a table, what a route reaches and why, and read the chain it proves from source.
---

# Ask about a codebase

Ask a question about code you have already extracted. The answer comes
out of the summaries on disk, so nothing is read again.

```bash
npx suss ask 'what writes postgresql:Article' --dir summaries/
```

The ten question forms and the words each one takes are in the
[`suss ask` reference](/reference/cli/ask). This page walks through what
the answers look like.

## The same questions in symbols

Five of the questions have a symbol form, for somebody asking the same
thing often. The arrows point the way the calls go:

| Symbols | The question it means |
|---|---|
| `<- <unit>` | `what calls <unit>` |
| `<unit> ->` | `what does <unit> reach` |
| `<unit> -> <boundary> ?` | `why does <unit> reach <boundary>` |
| `r<- <boundary>` | `what reads <boundary>` |
| `w<- <boundary>` | `what writes <boundary>` |

```
$ suss ask '<- src/orderStore.ts' --dir .suss
$ suss ask 'getOrder -> aws.dynamodb:orders-v1 ?' --dir .suss
```

The words are the documentation and the symbols are an alias for them,
so both take the same spellings and both give the same answer, in text
and under `--json`. The parts separate on spaces, since `<-`, `->` and
a trailing `?` are characters no key, id, or path contains.

A store has two spellings when its name is filled in at deploy time:
the reference the code states (`aws.dynamodb:{SUBSCRIBER_TABLE}`) and
the deployed name (`aws.dynamodb:prod-subscribers-v1`). When the
summaries contain what grounds one to the other, a wrangler `[vars]`
value or the argument a caller passed, either spelling finds the same
pairs, and the answer says how the two connect:

```
$ suss ask 'what writes aws.dynamodb:prod-subscribers-v1' --dir .suss
1 unit writes aws.dynamodb:{env.SUBSCRIBERS_TABLE}:
  src/index.ts::fetch (src/index.ts:11) through dynamo.send, which grounds to prod-subscribers-v1 via wrangler:wrangler.toml
```

When the grounding input is missing, the answer says which input would
connect the two spellings, in place of an empty list.

A calls question takes the reverse direction of `reach`: which units'
calls arrive at this one. An empty answer distinguishes "nothing calls
this" from "a call suss could not follow could reach it", from the
unfollowed-call gaps the summaries record:

```
$ suss ask 'what calls src/orderStore.ts' --dir .suss
1 unit calls storage-wrapper::src/orderStore.ts::readRow:
  storage-wrapper::src/orders.ts::GetOrderFunction.getOrder (src/orders.ts:6) calls readRow
```

A provides question lists what a package or a file exports, one
boundary per line, so an agent that needs a package's whole surface
gets it in one call instead of reading every export's own summary:

```
$ suss ask 'what does @suss/checker provide' --dir .suss
@suss/checker provides 2 boundaries:
  fn:@suss/checker::analyzeFlow, from analyzeFlow (packages/checker/src/flow/reachability.ts:400)
  fn:@suss/checker::checkAll, from checkAll (packages/checker/src/index.ts:12)
```

```
$ suss ask 'what can I project from dynamodb:editions#by-publication' --dir .suss
dynamodb:editions#by-publication declares 3 things you can ask it for:
  field publicationId (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication
  field editionId (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication
  field title (S)  from infra/editions.tf::aws_dynamodb_table.editions#by-publication

$ suss ask 'what reads dynamodb:editions' --dir .suss
2 units read dynamodb:editions#by-publication:
  src/editions/dao.ts::byPublication (src/editions/dao.ts:30) through docClient.query
  src/editions/dao.ts::forDashboard (src/editions/dao.ts:70) through docClient.query

dynamodb:editions#by-publication is provided by infra/editions.tf::aws_dynamodb_table.editions#by-publication.
```

An answer that cannot be given from what is on disk says which input
would give it, rather than assembling one out of what the call sites
happen to ask for:

```
$ suss ask 'what can I project from dynamodb:editions#by-publication' --dir .suss
Nothing here declares what dynamodb:editions#by-publication serves.
  code here reads it through docClient.query, in src/editions/dao.ts::byPublication

No summary here provides dynamodb:editions#by-publication. Read the schema or deploy
template that declares it: suss contract --from terraform <path> -o summaries/infra.json
```

A why question is answered from two layers. The summaries say which
unit calls which and where the boundary is touched, and the chain is
the shortest one the call facts behind `what reaches` contain. The
chain under each hop is proved from source: the question re-reads the
relevant files and re-evaluates the resolution rules under the witness
algebra, when asked and never during a normal run. `--project` says
where the source is when it is not the working directory.

A hop can be one the caller writes, `getOrder calls readRow`, or one
only the caller's import records, as `analyzeFlow is bound to
fn:@suss/datalog::evaluate, which evaluate provides`. A bound hop has
no written call to prove, so it prints without resolution steps.
Proving a hop reads that hop's own file through its language's
adapter, so a project mixing TypeScript, Python and Ruby proves each
hop through the adapter that reads it. When an adapter cannot make
sense of the source, a broken tsconfig for instance, the answer says
so in a caveat.
[How suss follows a value](/theory/resolving-values) walks through the
facts, the rules and the proof behind one of these chains.

```
$ suss ask 'why does getOrder reach aws.dynamodb' --dir .suss
GetOrderFunction.getOrder reaches aws.dynamodb:{location.table}:
  GetOrderFunction.getOrder -> readRow -> client.send
  GetOrderFunction.getOrder (src/orders.ts:6) calls readRow, and that call runs readRow (src/orderStore.ts:14):
    readRow (src/orders.ts:9) -> readRow (src/orders.ts:4) -> readRow (src/orderStore.ts:14)
    readRow (src/orders.ts:9) is declared as readRow (src/orders.ts:4)
    readRow (src/orders.ts:4) is imported from src/orderStore.ts under the name readRow
  readRow reads aws.dynamodb:{location.table} through client.send (src/orderStore.ts:14)
```

A hop through a pack-declared wrapper says what it rests on, as
`assuming a pack declares that withSentry from @sentry/serverless
passes argument 0 through to its result`.

