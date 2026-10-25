---
title: suss check
description: Pair the two sides of every boundary and report where they disagree, with every flag, what a run prints, and the shape of the JSON report.
---

# `suss check`

`suss check` takes the summaries you already extracted, puts the two sides of each boundary together, and reports where they disagree. This is the command you run in CI, and the one you run while editing a file to see whether a call lines up with what it reaches.

```
# A folder of summary files, paired by boundary
suss check --dir <directory> [--intent <intent-dir>] [--all] [--json] [-o <output>]
           [--fail-on error|warning|info|none] [--allow-empty]
           [--fail-on-unpaired <N|N%>] [--fail-on-unreadable]
           [--sussignore <path>] [--no-suppressions]

# Two summary files
suss check <provider.json> <consumer.json> [--all] [--json] [-o <output>]
           [--fail-on error|warning|info|none] [--sussignore <path>] [--no-suppressions]

# One thing out of that folder
suss check --dir <directory> --at <file[:line] | boundary | summary-id> [--json] [-o <output>]

# What changed since an earlier folder of summaries
suss check --dir <directory> --since <earlier-directory> [--changed-files <file>] [--json] [-o <output>]

# What this branch introduced since it left a git ref
suss check [--dir <directory>] --base <git ref> [--json] [-o <output>]

# The project in the working directory, read first
suss check [--at <target>] [--since <earlier-directory>] [--intent <intent-dir>] ...
```

`--dir` reads every summary file in a folder and pairs them by boundary key, so a provider and its consumer meet whichever file each arrived in. Two positional files skip the pairing and compare every provider in the first against every consumer in the second. Nothing goes unpaired in that form, so a two-file run doesn't report an unpaired count. When either file has no summaries in it, nothing was compared, and the run fails the same way an empty `--dir` run does.

Given no files and no `--dir`, `check` reads the project it is run in: every entry in `suss.json`, or what `init` would pick when there is no file, into a temporary folder, then the `--dir` form over that. In a workspace, `init` picks one read for each package. See [Reading every read of a project](#reading-every-read-of-a-project) for how the reads run and what a failed one does to the report.

When no pack matches anything in the project, there is nothing to read. If the project has TypeScript, JavaScript, Python or Ruby source, the run gets a `noPackMatched` run finding and exits `4`. If it has none, as in a dbt project of SQL and YAML, `check` prints one line saying suss does not cover the project and exits `0`, and `--json` writes a `notCovered` run finding.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | none | The folder of summary files, paired by boundary. Every `.json` in it is read, except a `.incomplete.json` note. Given together with positional files, the run stops with a usage error, since the files would go unread. |
| `--at <target>` | none | Report on one thing instead of the whole folder. See [Reporting on one thing](#reporting-on-one-thing). Takes `--dir` or no files at all, and does not run with `--intent`. |
| `--intent <path>` | none | A folder of intent docs (`*.intent.yaml`, `.yml`, `.json`, and the same three for `*.prd`), each paired against the summaries in `--dir`. Takes `--dir` or no files at all. |
| `--since <path>` | none | A folder of summaries from an earlier run. The report narrows to what changed since then, and the run fails only on new findings. See [Comparing with an earlier run](#comparing-with-an-earlier-run). Takes `--dir` or no files at all, and does not run with `--at` or `--intent`. |
| `--changed-files <file>` | none | With `--since`, a file listing the paths a change touched, one per line, the way `git diff --name-only` writes them. The report keeps the findings the change touched. See [Checking a pull request](#checking-a-pull-request). |
| `--base <git ref>` | none | Reads the commit the current branch left this ref at into a temporary folder and checks against it, with the files changed since then as the list. See [Checking a pull request](#checking-a-pull-request). Does not run with `--since`, `--changed-files`, `--at` or `--intent`. |
| `--all` | off | Write out every finding and every list. See [What a run prints](#what-a-run-prints). |
| `--json` | off | Write findings as JSON instead of text. |
| `-o`, `--output <path>` | stdout | Write the report to a file. |
| `--fail-on <severity>` | `error` | Which severity of finding fails the run: `error`, `warning`, `info`, or `none` so that no finding fails it. A run that compared nothing still fails under `none`, because `--fail-on` applies to findings and `nothingPaired` is in the `run` list. Pass `--allow-empty` for that case. |
| `--allow-empty` | off | Exit `0` from a run that compared nothing: a folder whose summary files paired nothing or have no summaries in them, or two files where one has no summaries. Without it that run fails, because a report with nothing in it looks exactly like a report where both sides agreed. The run gets a `nothingPaired` run finding and exits `3`, which no finding uses. A folder with no `.json` files, or with none that read as summaries, fails with a usage error either way. |
| `--fail-on-unpaired <N\|N%>` | off | Fail when more boundaries went unpaired than this: a count (`25`) or a share of all boundaries (`50%`). It counts boundaries the way the report's first line does, so a route that two summaries serve counts once. It applies to a run over `--dir` and to a bare `check`. The two-file form pairs nothing, so it ignores the flag. The report gets a `mostlyUnpaired` run finding with the numbers. |
| `--fail-on-unreadable` | off | Fail when a file in `--dir` could not be read as summaries, instead of skipping it with a warning. The report gets an `unreadableInput` run finding, and `--json` lists the skipped files either way. |
| `--cache-dir <path>` | `.suss/cache` under the project, or `SUSS_CACHE_DIR` | Where the extraction cache goes when `check` reads the project itself. See [Where suss writes](/reference/cli/#where-suss-writes). |
| `--jobs <n>` | up to 4 | When `check` reads the project itself, how many reads run at once. The default is 4, or fewer when the machine has fewer cores or not enough memory for that many reads at `--read-memory`. |
| `--read-timeout <minutes>` | `20` | When `check` reads the project itself, how long one read may run before it is stopped. `0` turns the limit off. |
| `--read-memory <MB>` | the heap one `suss` run gets, at most 8192 | When `check` reads the project itself, the heap one read may grow to. |
| `--sussignore <path>` | the nearest `.sussignore` | Read this suppressions file instead of searching for one. |
| `--no-suppressions` | off | Report every finding, ignoring any `.sussignore`. |

`--fail-on-empty` is gone. A run that pairs nothing now fails by default, and passing the old flag stops the run and points you at `--allow-empty`.

## Reading every read of a project

A bare `check`, a bare [`suss map`](/reference/cli/map) and [`suss extract --out-dir`](/reference/cli/extract#the-whole-project-into-a-folder) run every read the project has. Each extract runs as its own `suss` process, up to `--jobs` at once, and stderr gets a line as each one starts and as each one ends:

```
No suss.json in /work/shop, so this reads what `suss init` would pick. Run `suss init` to write that down.
3 reads, 3 at a time, each stopped after 20m 0s:
  started  suss extract --lang typescript --dir apps/api -p apps/api/tsconfig.json -f express -f pg -f node
  started  suss extract --lang typescript --dir apps/web -p apps/web/tsconfig.json -f react -f fetch
  started  suss contract --from openapi apps/api/openapi.yaml
  [1/3] suss contract --from openapi apps/api/openapi.yaml: 14 summaries in 310ms
  [2/3] suss extract --lang typescript --dir apps/web -p apps/web/tsconfig.json -f react -f fetch: 212 summaries in 18.4s
  [3/3] suss extract --lang typescript --dir apps/api -p apps/api/tsconfig.json -f express -f pg -f node: failed after 20m 0s
      was stopped after 20m 0s, the time limit for one read. Pass --read-timeout with more minutes to give it longer, or 0 for no limit.
```

A read that runs past `--read-timeout` is stopped, and one that grows past its `--read-memory` heap dies on its own. Either one, or one that exits with an error, is left out while the others carry on. The check compares what the finished reads wrote, and the report gets a `readFailed` run finding for each read that did not finish, so a run that left part of the project out says so. It is a warning, so it fails the run only under `--fail-on warning`. The same note is left in an `--out-dir` folder, beside the file the read would have written, so a later `check --dir` over that folder reports it too.

A finding that points at one transition prints a `.sussignore` rule for it, ready to paste under `rules:`. See [Accept a finding](/guides/accept-a-finding), and [the findings catalog](/reference/findings) for every kind.

## What a run prints

A run opens with how many boundaries paired, out of every boundary it read, and counts the ones that went unpaired on each side. Then it prints every error and warning in full, and counts the info findings by kind. A `lowConfidence` finding says only that suss could not compare something it read, so the run leaves it out of the finding count as well and counts it on the `Not shown:` line. Over the [quickstart](/start/quickstart) project:

```
$ suss check --dir summaries/
Compared 2 of 3 boundaries.

  1 provider-side boundary has no client to compare against.
  Run the same command with --all to list them.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:7)
  consumer: src/client.ts::loadOrder (src/client.ts:1)
  boundary: hono (http) GET /orders/:reference
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /orders/{reference}"
      provider: { transitionId: "get:response:404:ca40ca7" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[WARNING] boundaryFieldUnused
  Order declares "placedAt" and code here writes to it, but no query reads it. suss counts a column as read only when a query selects it, so before you treat the write as pointless, look for code that takes "placedAt" off a record it already fetched.
  provider: prisma/schema.prisma::Order (prisma/schema.prisma:1)
  consumer: prisma/schema.prisma::Order (prisma/schema.prisma:1)
  boundary: prisma (postgresql)
────────────────────────────────────────────────────────────
2 findings: 0 error, 2 warning, 0 info
```

A run with no findings says "Every compared boundary agreed" only when every boundary it read paired. When some went unpaired, it says how many were left unchecked instead, because an empty finding list says nothing about a boundary nobody compared. `--all` lists every pair and every unpaired boundary, and writes the info findings out in full. Three things do not change with the flag: `--json` always includes every finding and every list, `--at` always prints in full because it is already narrowed to one thing, and the exit code comes from `--fail-on` rather than from what got printed.

Without the collapse, a first run over a repository of any size prints thousands of lines before the first error. Over five public repositories and suss's own packages, the unpaired lists alone were between 66% and 99% of the report.

### One cause at many boundaries

When one piece of provider code gives the same finding at several boundaries, such as a middleware that sends 401 on every route behind it, the report prints that finding once. The block says where the outcome is written, lists the first three boundaries, and counts the rest. `--all` lists all of them.

```
────────────────────────────────────────────────────────────
[ERROR] providerContractViolation at 5 boundaries
  Handler produces status 401 which the openapi document does not declare
  comes from: requireAuth (src/auth.ts:5)
  boundary: express (http) GET /orders
    provider: src/app.ts::get (src/app.ts:8)
    consumer: openapi:openapi.yaml::listOrders (openapi:openapi.yaml:0)
  boundary: express (http) GET /invoices
    provider: src/app.ts::get (src/app.ts:12)
    consumer: openapi:openapi.yaml::listInvoices (openapi:openapi.yaml:0)
  boundary: express (http) GET /accounts
    provider: src/app.ts::get (src/app.ts:16)
    consumer: openapi:openapi.yaml::listAccounts (openapi:openapi.yaml:0)
  and 2 more. Run the same command with --all to list them.
  to silence it at all 5, add to the rules in .sussignore.yml:
    - kind: providerContractViolation
      provider: { transitionId: "requireAuth:response:401:2cc14e6" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
5 findings: 5 error, 0 warning, 0 info
5 of them come from 1 shared cause, each printed once with the boundaries it reaches.
```

Two findings share a cause when they are the same kind with the same description and severity, and each provider transition they cite was written at the same file and line. suss knows where an outcome was written because composition records which wrapper added it to the route: a Rails filter or `rescue_from` handler, Express or Hono middleware, or a FastAPI dependency. A transition from a handler's own body counts as written in that handler. A finding that cites a consumer path keeps a block of its own, because that path is part of what it says.

Only the printed report groups findings, and it groups them the same way under `--at`, `--since`, `--base` and `--changed-files`. `--json`, the finding count, `--fail-on` and `.sussignore` still see each finding, so a rule written for one boundary accepts that finding alone and the rest stay in the group. The rule printed under a group leaves the boundary out, so it accepts every finding in the group. When that rule would also accept a finding outside the group, the report prints the rule for the first boundary instead and says how many others the shorter rule would reach.

With `--intent`, an `Intent:` section follows the findings with what was checked and what is still an uncurated draft.

## Reporting on one thing

`--at` runs the same passes over the same folder and prints the part of the report about one target. Use it while editing a file, to see whether a call lines up with what it reaches.

A target is one of four spellings, resolved in this order:

| Spelling | Example | What it picks out |
|---|---|---|
| Summary id | `app::src/editions/dao.ts::byPublication` | That one summary. A tail of the id works too, so the workspace in front is optional. |
| File and line | `src/editions/dao.ts:43` | The units covering line 43, and the branches that line falls in. Findings about other branches of the same function are left out. |
| File | `src/editions/dao.ts` | Every unit in that file. Matching is on whole path segments, so `dao.ts` finds it and `ao.ts` does not. |
| Boundary | `dynamodb:editions#by-publication` | Everything either side of that boundary, whichever file it is in. |

A file wins over a boundary, so a path is never read as a boundary whose words happen to line up. A boundary is spelled the way reports spell it, and a shorter spelling covers more: `dynamodb:editions` covers the table and every index on it, and `/editions` covers `GET /editions`.

```
$ suss check --dir summaries/ --at src/orderArchive.ts
src/orderArchive.ts (src/orderArchive.ts, 1 summary)

What it touches:
  function-call:reachable
    provides terraform-stores::src/orderArchive.ts::archiveOrder
  s3:acme-archive
    writes terraform-stores::src/orderArchive.ts::archiveOrder  via client.send

Compared 1 boundary here:
  s3:archive
    main.tf::aws_s3_bucket.archive <-> terraform-stores::src/orderArchive.ts::archiveOrder

No findings here.
```

When suss could not fully read the unit a target covers, the report ends with a paragraph telling you so, whether or not it found anything. Otherwise you would take "no findings here" at face value while part of the unit was missing from the summary.

A target that matches nothing prints what it could not find and exits `1`, so you don't mistake it for a target where both sides agreed.

## Comparing with an earlier run

`--since` checks the earlier folder the same way as `--dir`, with the same `.sussignore`, and reports three things:

- the findings that are new since then,
- the findings the earlier run had that are gone,
- the boundaries the code changed at.

A boundary changed when a unit on it was added, removed, or now behaves differently, or when a changed path of any unit reads, writes or calls across it. A unit whose lines moved and whose behavior did not is not a change, so a comment added above a handler changes nothing.

A finding is the same finding in both runs when its kind, its boundary, the summary and transition on each side, and its description match, with whitespace in the description collapsed. Line numbers are left out, and a transition id is built from the function name, the terminal, the status and the guards, so an edit elsewhere in the file leaves a finding alone.

```
$ suss extract --out-dir .suss/before
$ # ... edit the code ...
$ suss extract --out-dir .suss/after
$ suss check --dir .suss/after --since .suss/before
Compared 1 boundary.

Since /home/dana/shop/.suss/before:
  1 boundary changed: POST /orders
  1 new finding, 0 resolved.
```

The exit code counts only the new findings, so a CI job can pass `--since` with the base branch's summaries and fail a pull request on what it introduced, while the findings already on the base branch wait.

## Checking a pull request

`--base` reports the findings a branch introduced, in one command:

```
$ suss check --base origin/main
Compared with 9020c28, where this branch left origin/main. 1 file changed:
  1 boundary changed: POST /orders
  1 new finding, 0 resolved.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 409 but no consumer branch handles it
  provider: src/orders/create.ts::post (src/orders/create.ts:10)
  consumer: web/orders/submitOrder.ts::submitOrder (web/orders/submitOrder.ts:1)
  boundary: express (http) POST /orders
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "POST /orders"
      provider: { transitionId: "post:response:409:4b7ea21" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 0 error, 1 warning, 0 info
```

The base is the commit `git merge-base origin/main HEAD` gives, so commits that landed on `origin/main` after the branch left it are not counted as the branch's. In a shallow clone git cannot find that commit, and the run compares with the ref itself and says so. `git archive` writes the base into a temporary folder, so your checkout, its index and its list of worktrees are left alone. The base shares the working tree's `node_modules` folders, `suss.json` and pack config files, even when those are not committed yet, and it is read with the same reads as the working tree: what `suss.json` lists, or what `init` would pick. A read whose folder did not exist at the base is skipped, and when none of them existed, everything in the working tree counts as new. A read that fails there stops the run, because every unit it covers would otherwise look new.

`--dir` can point at the project or at a folder of summaries. When it points at a project, suss reads that project at both revisions and finds the base in the git repository the project is in, wherever you run the command from. A project outside any git repository is refused. When `--dir` points at a folder of summaries, those are the working tree's side and the base comes from the repository you run the command in, and a folder from a different repository is refused. Without `--dir`, the working tree is read the way a bare `check` reads it.

The changed files are what `git diff --name-only` lists against the base, plus untracked files, so an edit you have not committed counts. A new finding is reported when any of these is true:

- a summary on either side is in a changed file,
- a summary on either side is a unit that was added, removed or behaves differently, which catches a route that changed because a helper in another file did,
- its boundary is one the code changed at, which catches a finding between two unchanged summaries that a third unit's new read or write produced.

The same test applies to the resolved findings. The rest of what moved is counted on a `Left out` line and listed under `addedElsewhere` and `resolvedElsewhere` in the JSON. Those findings touch nothing the change edited, and they usually come from reading the two revisions differently, such as a generated file the working tree has and the base does not.

A finding keeps its identity when only its lines moved, so lines added above a route leave its findings alone. A finding about a deployed resource also keeps it when the resource moves to another template or into a nested stack, since suss identifies the resource by its logical id alone. The report prints the errors and warnings in full, counts the info findings, and lists each resolved finding in one line with the file and line on both sides. The pairing counts and unpaired lists describe the whole repository, so they are left out. When nothing paired, no finding can be new, so the report lists the units that changed and their outcomes, the way `inspect --diff` prints them. The run fails only on new findings at the `--fail-on` severity.

`--since` with `--changed-files` gives the same report when you already have both folders of summaries, which is how the [pull request action](/guides/ci-integration) runs it:

```
suss check --dir .suss/after --since .suss/before --changed-files changed.txt
```

The first read of a base commit costs as much as a full extract. When `SUSS_CACHE_DIR` or `--cache-dir` moves the cache out of the project, the base gets one cache folder per commit and project, and a second `--base` against the same commit reads from it: on dub, a second run took 16 seconds where the first took 7 minutes. Without either, the base's cache is inside the temporary copy and is removed with it. The MCP server's `suss_check` takes the same `base` and reads each base commit once while it runs.

## JSON output

`--dir --json` writes one object:

```
{ findings, run, pairs, unmatched, unchecked, skipped, runtimeNamedCrossings, summariesWithGaps, collisions }
```

with `intent` added when `--intent` was passed. `unchecked.runtimeConfig` lists the environment reads the check did not judge, one `{ runtime, reader, variable, reason }` each: a read in a file the runtime loads that no call from its handler reaches (`notReached`), or one that only a call through a table reaches (`possibleCall`). Only a read that would otherwise have been a finding is listed, and the text report prints one line per runtime that has any. Two positional files write the bare `findings` array instead. When one of the two files was empty and the run failed for it, they write `{ findings, run }` so the `nothingPaired` finding has a place in the report.

`--at --json` writes `{ at, matched, target, touches, findings, pairs, unmatched, gaps }`, where `touches` is one entry per unit and boundary (`{ boundary, relations, unit, via }`). A target that matched nothing writes `{ at, matched: false, message }`.

`--since --json` writes the `--dir` object with `findings` narrowed to the new ones, and three keys added: `since`, the earlier folder; `resolved`, the findings that went away; and `changedBoundaries`, one `{ key, label, units }` per boundary the code changed at. `label` is what to show a person: the boundary's own label, followed by any variable whose read or declaration came or went, as in `runtime-config ACCOUNTS_REGION` or `runtime-config:GetAccountFunction ACCOUNTS_REGION`. It is null for a boundary with no name of its own and no name moving on it, such as a call from one function in the project to another; `units` says which functions moved. A deployable counts as changed when the variables its template declares change. Each finding in `findings` and `resolved` also has:

| Key | What it is |
|---|---|
| `identity` | A string that is equal for the same finding in both runs. |
| `boundaryKey` | The boundary's key, the one `.sussignore` rules and `changedBoundaries` use. |
| `atChangedBoundary` | Whether that boundary is in `changedBoundaries`. |
| `rule` | The `.sussignore` rule that accepts this finding and no other, without its `reason`. Absent when the finding points at no transition, since a rule without one would accept more. |

`--changed-files --json` and `--base --json` add four keys. `changedFiles` is the list the report narrowed to, `addedElsewhere` and `resolvedElsewhere` are the findings it left out, described the same way, and each finding gets `touchedByChange`, the parts of it the change touched: any of `provider`, `consumer` and `boundary`. `--base` writes `base`, as `{ ref, commit, branchPoint }`, in place of `since`, because the folder it read is gone by the time the report is read. `branchPoint` is false when git could not find where the branch left the ref.

`findingIdentity`, `findingsSince`, `changedBoundaries` and `changesWithin` in `@suss/checker` compute the same things from a program.

A bare `check` that found nothing to read writes `{ findings: [], run }`, with one `noPackMatched` or `notCovered` entry in `run`.

`check` exits `0` when nothing reached `--fail-on`, `1` on a finding that did, `3` when nothing was compared, and `4` when no pack matched the project's source. [Exit codes](/reference/cli/exit-codes) has the full table, and says how a suppression changes the count.
