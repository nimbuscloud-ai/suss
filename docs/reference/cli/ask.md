---
title: suss ask
description: The eleven questions suss answers about a codebase from summaries on disk, how each one is written, the flags, and the JSON it produces.
---

# `suss ask`

`suss ask` takes one question about a codebase and works out the answer from the summaries `suss extract` already wrote. You write the question in one of the eleven forms below, naming a boundary or a unit, and you get one answer back.

```
suss ask "<question>" [--dir <directory> | <summaries.json>] [--project <directory>]
         [--all] [--json] [-o <output>]
```

| Flag or argument | Default | What it does |
|---|---|---|
| `"<question>"` | none | One of the eleven forms below. Run `suss ask` with no question to print the list and exit `0`. |
| `--dir <path>` | none | The folder of summary files to read. A note an incomplete extract left in it is read for what it says, not as summaries. Given neither `--dir` nor a file, `ask` reads the project first, the way a bare `suss check` does, and answers from what it read. |
| `<summaries.json>` | none | One summary file, as a second positional argument after the question. |
| `--project <path>` | the working directory | Where the source is, for a why question. A why question reads source as well as summaries, and reports it when the two do not line up. It loads the packs a bare `suss extract` of that directory would load, the ones `suss.json` lists or the ones `suss init` would pick, so a step only a pack declares, such as a finder giving back its model, is explained too. |
| `--cache-dir <path>` | `.suss/cache` under the project, or `SUSS_CACHE_DIR` | Where the extraction cache goes when a why question reads source. See [Where suss writes](/reference/cli/#where-suss-writes). |
| `--all` | off | List every unit the answer picked out. Without it a long answer stops after ten and reports how many are left. |
| `--json` | off | Write the answer as JSON instead of text. Unaffected by `--all`: it always lists every item. |
| `-o`, `--output <path>` | stdout | Write the answer to a file. |

## The eleven questions

Each one is written in these words. You fill in the placeholders, and the other words have to match.

| Question | What comes back |
|---|---|
| `what can I project from <boundary>` | What the boundary declares: the fields a store serves, the statuses a contract declares, the env vars a runtime takes. Also written `what does <boundary> declare`. |
| `what reads <boundary>` | Every unit that reads it, with the file, the line and the call. |
| `what writes <boundary>` | The same, for writes. |
| `what invokes <boundary>` | Every unit that calls a deployed unit by name, such as one Lambda invoking another. |
| `what calls <unit or boundary>` | For a unit, every unit whose calls the run resolved to it, with the file, the line and the call. A call that takes its function out of a table, or picks a method by a name it works out at run time, may run the unit or another function, and its line says so. For a route, a table or a queue, every unit that calls it from outside, the units `what reads` and `what writes` list, each with what it does there, then any unit that calls the code serving it as a function. For a GraphQL field, the client operations whose document selects it, the same ones `check` pairs with it. A name such as `Query.listing` that matches both a resolver and a schema file's entry for its field means the resolver, and the answer says which schema entry also declares the field. |
| `what does <unit> reach` | Every boundary a file or a summary goes through, and whether it reads, writes or invokes each. When a call on the way takes its function out of a table, the chain says which function it may run, and the JSON item has `possible: true`, since the call may pick another one. `what reaches` marks such a call the same way. |
| `what reaches <target>` | Every boundary whose unit ends up going through the target, however many calls away, and the calls it took to get there. A unit appears only when it serves a boundary of its own, so you get routes, queues and package exports, and the functions in between are left out. The answer also counts the calls that didn't resolve to a unit, because a boundary that reaches the target through one of those is missing from the list. |
| `what does <package or unit> provide` | Every boundary it provides, one per line, sorted by boundary key. A package is spelled by its name, `@suss/checker`, and the answer gathers its exports wherever they are in the run. Also written `what does <package> export`. |
| `how is <unit or boundary> used` | Every call into a helper, a class or a boundary, grouped by what each call passes into the boundary, then the callers by class or module with the routes and jobs that reach each one, the condition each call runs under, how the helper can fail, and the calls around it suss could not follow. [How a helper is used](#how-a-helper-is-used) has an example. |
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
suss ask 'how is src/editions/dao.ts used'
suss ask 'why does src/editions/dao.ts reach aws.dynamodb:editions'
suss ask 'why does handler at src/app.ts:12 resolve to createHandler'
```

[Ask about a codebase](/guides/ask) walks through what each answer looks like on a working project.

### Symbol shorthand

Five of the forms have a symbol spelling, for a question you type often. The operators are symbols such as `<-` and `->` because a boundary key already contains `:`, `.`, `#` and `/`, and suss needs a separator that cannot appear inside the subject you are asking about.

| Shorthand | The question it means |
|---|---|
| `<- <unit or boundary>` | `what calls <unit or boundary>` |
| `<unit> ->` | `what does <unit> reach` |
| `r<- <boundary>` | `what reads <boundary>` |
| `w<- <boundary>` | `what writes <boundary>` |
| `<unit> -> <boundary> ?` | `why does <unit> reach <boundary>` |

`how is <unit> used` has no symbol form. Each arrow asks about one direction of the calls, and this question looks both ways, at the calls into the helper and at the routes that reach them, so a variant of `<-` would be easy to mistake for `what calls`.

### Spelling the subject

A boundary is spelled the way reports spell it, and a shorter spelling covers more, exactly as under [`check --at`](/reference/cli/check#reporting-on-one-thing): `dynamodb:editions` covers every index on that table. When a spelling covers several boundaries at once, suss lists them all so you can narrow it. A spelling that exactly matches one boundary's name picks that boundary.

A route written out in full, a method and a path such as `GET /articles`, means that route and no other. It matches a route with the same method and the same path, whatever each side calls its parameters, the way `check` pairs a client with a route: `POST /comments/{id}/delete` is the route a client writes as `/comments/{commentId}/delete`. `GET /articles` leaves out `GET /articles/{slug}/comments` and `GET /admin/articles`, which only share its words. Write the path alone, `/articles`, to cover every route with those words.

For a route or a GraphQL field, `what calls` lists every consumer `check` pairs with it, with the path each one wrote. A client that requests `/search.json` is listed under the Rails route `GET /search`, which serves both.

A unit is spelled the way `--at` spells one: a file, a `file:line`, a summary id, or a function name. A package export such as `fn:@suss/datalog::evaluate` resolves to the function behind it, so that spelling, the bare name, and `what reads` on the export all give one answer. A bare name that is two functions in different places is refused, with both listed.

A module that [`suss.json`](/reference/cli/extract#modules-of-one-application) lists is spelled by its name, and means every unit in it: `what does billing reach` walks from all of them, and `what does billing provide` lists its public exports. The name is tried after a file and before a function name, and a name that is both a module and a function is refused, with both listed. When the units in an answer to `what reads`, `what writes` or `what invokes` belong to modules, each line starts with its module in brackets, the lines are grouped by module, and the JSON adds `modules`, each module with the units it contributed.

A service call counts as both a read and a write, since a request sends a body out and gets a response back. Calling a deployed unit by name does the same two things and is reported as `invokes`, because a service made of Lambdas would otherwise read as every function reading and writing every other one.

When the unit an item is about provides a boundary itself, the item gives that boundary after the location: `discoverUnits (src/discovery.ts:172, provides fn:@suss/adapter-python::discoverUnits) calls decoratedUnits`. Read the boundary from there. The summary id only spells it out when two summaries share a name.

## Example

```
$ suss ask "what writes s3:acme-archive" --dir summaries/
1 unit writes s3:acme-archive:
  archiveOrder (src/orderArchive.ts:7) through client.send

s3:acme-archive is provided by main.tf::aws_s3_bucket.archive.
```

## How a helper is used

`how is` takes a function, every method of a class by the class's name, a file or a module, or a boundary. A class name is tried before a table of the same name, so `how is Setting used` asks about the class. Spell the table, `postgresql:settings`, to ask about the table.

```
$ suss ask "how is Setting used" --dir summaries/
Setting (app/models/setting.rb:5) reads or writes storage (ruby-storage). 4 calls from 3 files go into it.

  Through    calls  passes
  enabled?   1      "sync:orders"
  lookup  3      "user:#{@user.id}:theme" or "user:#{current_user_id}:theme" (2), "site:banner"

  Caller              calls  reached by
  OrdersController    2      GET /orders, GET /orders/{id}
  AccountsController  1      GET /account
  SyncJob             1      bus:activejob SyncJob, POST /orders
```

The calls are grouped by what each one passes for the parameters that reach the boundary. `lookup` selects rows by its `key`, and `enabled?` passes its own `key` on to `lookup`, so both count `key`. A parameter that reaches no boundary plays no part, since grouping on every argument would give one group per call. Each value prints as the source writes it. A part worked out at run time is a hole, and two calls whose values match with the holes blanked are one group, so the two `user:...:theme` keys above are one. A call that leaves a counted parameter out says `nothing for <parameter>`.

A function can have several summaries over the same lines, such as the client the net-http pack recognized and the summary reach built. They are one helper here. Its callers are the callers of either, and how it can fail comes from the pack's summary. A method of the same class that calls the helper is listed as a way through, the way `fetch_quietly` is for `fetch`.

The reach is the reach `what reaches` uses. An entry point reached only through a call that picks its function at run time is listed after the others, as possible. Below the callers come the calls that run only under a condition, and then what suss could not follow around the helper: a call inside it that suss stopped at, a caller no entry point in these summaries reaches, and a call suss could not follow elsewhere that has the name of one of the helper's methods, with the entry points that reach the unit making it.

An HTTP method or host that a client takes from a parameter, and a parameter's default, are not in the summaries yet, so a client's calls group only by which of its methods they go into. Which `rescue`, `except` or `catch` covers a call is not read either.

In `--json`, each entry in `items` has a `kind`:

| `kind` | Fields |
|---|---|
| `group` | `through`, the method the calls go into; `calls`; `values`, one `{ parameter, value }` per counted parameter with holes as `_`, and `value: null` when the calls leave it out; `spellings`, each way the calls spell those values with its count. |
| `caller` | `owner`, the class or module, or the file for code in neither; `calls`; `units`; `files`; `reachedBy`, each `{ boundary, unit, through, possible? }`, certain ones first. |
| `call` | `caller`, `file`, `line`, `call` as written, `through`, `count`, `values` as written, `group`, `conditions` as printed, and `possible: true` for a call that may run another function instead. |
| `gap` | `gap`, which is `inside`, `unreached` or `unfollowed`; `unit`, `name`, `file`, `line`; `callee` for a call suss stopped at; and `reachedBy` for an `unfollowed` one. |

The answer also has `construct`, with `label`, `file`, `line`, `members`, `touches` (each `{ class, recognition }`, where `class` is `service-call`, `storage-access`, `message-send`, `config-read` or `wrapper`), `outcomes` (`throws`, `returnsNothing` or `responds` with a status and its conditions), `calls`, `files` and `entryPoints`.

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

`shape` is which of the eleven was asked: `declares`, `reads`, `writes`, `invokes`, `calls`, `reaches`, `reachedBy`, `provides`, `usedBy`, `whyReaches` or `whyResolves`. `found` is false when the subject is not in these summaries at all. Each entry in `items` has the fields that shape reports, plus `provides` when the unit serves a boundary of its own. `needs` lists what this run would need in order to report more, such as a pack the extract left out for want of an option. `caveats` lists what could make the answer wrong: a listed unit suss could not fully read, a request whose URL suss could not read when the subject is a route, a call suss could not follow that uses the subject's name for `what calls <unit>`, and a call it could not follow in the code the subject calls for `what does <unit> reach`. A why answer adds the chain, the hops with their resolution steps, and what the re-evaluation cost.

A question suss does not recognize writes `{ question, answer: null, message }` instead.

[Exit codes](/reference/cli/exit-codes) lists what `ask` returns to the shell.
