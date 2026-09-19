---
title: suss ask
description: The ten questions suss answers about a codebase from summaries on disk, how each one is written, the flags, and the JSON it produces.
---

# `suss ask`

`suss ask` takes one question about a codebase and works out the answer from the summaries `suss extract` already wrote. You write the question in one of the ten forms below, naming a boundary or a unit, and you get one answer back.

```
suss ask "<question>" [--dir <directory> | <summaries.json>] [--project <directory>]
         [--all] [--json] [-o <output>]
```

| Flag or argument | Default | What it does |
|---|---|---|
| `"<question>"` | none | One of the ten forms below. Run `suss ask` with no question to print the list and exit `0`. |
| `--dir <path>` | none | The folder of summary files to read. |
| `<summaries.json>` | none | One summary file, as a second positional argument after the question. |
| `--project <path>` | the working directory | Where the source is, for a why question. A why question reads source as well as summaries, and reports it when the two do not line up. |
| `--all` | off | List every unit the answer picked out. Without it a long answer stops after ten and reports how many are left. |
| `--json` | off | Write the answer as JSON instead of text. Unaffected by `--all`: it always lists every item. |
| `-o`, `--output <path>` | stdout | Write the answer to a file. |

## The ten questions

Each one is written in these words. The placeholders are yours; everything else is the grammar.

| Question | What comes back |
|---|---|
| `what can I project from <boundary>` | What the boundary declares: the fields a store serves, the statuses a contract declares, the env vars a runtime takes. Also written `what does <boundary> declare`. |
| `what reads <boundary>` | Every unit that reads it, with the file, the line and the call. |
| `what writes <boundary>` | The same, for writes. |
| `what invokes <boundary>` | Every unit that calls a deployed unit by name, such as one Lambda invoking another. |
| `what calls <unit>` | Every unit whose calls the run resolved to it, with the file, the line and the call. |
| `what does <unit> reach` | Every boundary a file or a summary goes through, and whether it reads, writes or invokes each. |
| `what reaches <target>` | Every boundary whose unit ends up going through the target, however many calls away, and the calls it took to get there. A unit appears only when it serves a boundary of its own, so you get routes, queues and package exports, not the functions in between. The answer also counts the calls that didn't resolve to a unit, because a boundary that reaches the target through one of those is missing from the list. |
| `what does <package or unit> provide` | Every boundary it provides, one per line, sorted by boundary key. A package is spelled by its name, `@suss/checker`, and the answer gathers its exports wherever they are in the run. Also written `what does <package> export`. |
| `why does <unit> reach <target>` | The shortest call chain from the unit to a boundary, a function or a package export, with each written hop's resolution proved from source. |
| `why does <name> at <file>:<line> resolve to <target>` | The chain from a written name to the function it comes down to, one reason per hop. |

```bash
suss ask 'what can I project from aws.dynamodb:editions#by-publication'
suss ask 'what reads aws.dynamodb:editions'
suss ask 'what writes aws.dynamodb:editions'
suss ask 'what invokes unit:lambda ReportBuilder'
suss ask 'what calls src/editions/dao.ts'
suss ask 'what does src/editions/dao.ts reach'
suss ask 'what reaches src/editions/dao.ts'
suss ask 'what does @suss/checker provide'
suss ask 'why does src/editions/dao.ts reach aws.dynamodb:editions'
suss ask 'why does handler at src/app.ts:12 resolve to createHandler'
```

[Ask about a codebase](/guides/ask) walks through what each answer looks like on a working project.

### Symbol shorthand

Five of the forms have a symbol spelling, for a question you type often. The operators are symbols such as `<-` and `->` because a boundary key already contains `:`, `.`, `#` and `/`, and suss needs a separator that can never turn up inside the subject you are asking about.

| Shorthand | The question it means |
|---|---|
| `<- <unit>` | `what calls <unit>` |
| `<unit> ->` | `what does <unit> reach` |
| `r<- <boundary>` | `what reads <boundary>` |
| `w<- <boundary>` | `what writes <boundary>` |
| `<unit> -> <boundary> ?` | `why does <unit> reach <boundary>` |

### Spelling the subject

A boundary is spelled the way reports spell it, and a shorter spelling covers more, exactly as under [`check --at`](/reference/cli/check#reporting-on-one-thing): `dynamodb:editions` covers every index on that table. When a spelling covers several boundaries at once, suss lists them instead of picking one for you. A spelling that exactly matches one boundary's name takes that boundary, so `GET /articles` is the collection route and not the comments route under it.

A unit is spelled the way `--at` spells one: a file, a `file:line`, a summary id, or a function name. A package export such as `fn:@suss/datalog::evaluate` resolves to the function behind it, so that spelling, the bare name, and `what reads` on the export all give one answer. A bare name that is two functions in different places is refused, with both listed.

A service call counts as both a read and a write, since a request sends a body out and gets a response back. Calling a deployed unit by name does the same two things and is reported as `invokes`, because a service made of Lambdas would otherwise read as every function reading and writing every other one.

When the unit an item is about provides a boundary itself, the item gives that boundary after the location: `discoverUnits (src/discovery.ts:150, provides fn:@suss/adapter-python::discoverUnits) calls builtSubjects`. Read the boundary from there. The summary id only spells it out when two summaries share a name.

## Example

```
$ suss ask "what writes s3:acme-archive" --dir summaries/
1 unit writes s3:acme-archive:
  archiveOrder (src/orderArchive.ts:7) through client.send

s3:acme-archive is provided by main.tf::aws_s3_bucket.archive.
```

## JSON output

`--json` writes one object:

```json
{
  "question": "what writes s3:acme-archive",
  "shape": "writes",
  "subject": "s3:acme-archive",
  "found": true,
  "headline": "1 unit writes s3:acme-archive:",
  "items": [
    {
      "unit": "terraform-stores::src/orderArchive.ts::archiveOrder",
      "file": "src/orderArchive.ts",
      "line": 7,
      "via": "client.send"
    }
  ],
  "needs": [
    "s3:acme-archive is provided by main.tf::aws_s3_bucket.archive."
  ],
  "caveats": []
}
```

`shape` is which of the ten was asked: `declares`, `reads`, `writes`, `invokes`, `calls`, `reaches`, `reachedBy`, `provides`, `whyReaches` or `whyResolves`. `found` is false when the subject is not in these summaries at all. Each entry in `items` has the fields that shape reports, plus `provides` when the unit serves a boundary of its own. `needs` lists what this run would need in order to report more. `caveats` lists what could make the answer wrong, such as a unit suss could not fully read. A why answer adds the chain, the hops with their resolution steps, and what the re-evaluation cost.

A question suss does not recognize writes `{ question, answer: null, message }` instead.

[Exit codes](/reference/cli/exit-codes) lists what `ask` returns to the shell.
