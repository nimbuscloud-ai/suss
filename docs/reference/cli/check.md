---
title: suss check
description: Pair the two sides of every boundary and report where they disagree, with every flag, what a run prints, and the shape of the JSON report.
---

# `suss check`

Pair the two sides of every boundary and report what disagrees.

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

# The project in the working directory, read first
suss check [--at <target>] [--intent <intent-dir>] ...
```

`--dir` reads every summary file in a folder and pairs them by boundary key, so a provider and its consumer meet whichever file each arrived in. Two positional files skip the pairing and compare every provider in the first against every consumer in the second, which is why a two-file run has no unpaired count.

Given no files and no `--dir`, `check` reads the project it is run in: every entry in `suss.json`, or what `init` would pick when there is no file, into a temporary folder, then the `--dir` form over that. It prints the commands it ran to stderr.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | none | The folder of summary files, paired by boundary. Every `.json` in it is read, except a `.incomplete.json` note. Does not combine with positional files. |
| `--at <target>` | none | Report on one thing instead of the whole folder. See [Reporting on one thing](#reporting-on-one-thing). Takes `--dir` or no files at all, and does not run with `--intent`. |
| `--intent <path>` | none | A folder of intent docs (`*.intent.yaml`, `.yml`, `.json`, and the same three for `*.prd`), each paired against the summaries in `--dir`. Takes `--dir` or no files at all. |
| `--all` | off | Write out every finding and every list. See [What a run prints](#what-a-run-prints). |
| `--json` | off | Write findings as JSON instead of text. |
| `-o`, `--output <path>` | stdout | Write the report to a file. |
| `--fail-on <severity>` | `error` | Which severity fails the run: `error`, `warning`, `info`, or `none` to never fail. |
| `--allow-empty` | off | Exit `0` from a `--dir` run that paired nothing. Without it that run fails: it has nothing to report, which reads the same as both sides agreeing, so the report gets a `nothingPaired` run finding and the run exits non-zero. Needs `--dir`; a two-file check has no pairing count and refuses the flag. |
| `--fail-on-unpaired <N\|N%>` | off | Fail when more boundaries went unpaired than this: a count (`25`) or a share of all boundaries (`50%`). Needs `--dir`. The report gets a `mostlyUnpaired` run finding with the numbers. |
| `--fail-on-unreadable` | off | Fail when a file in `--dir` could not be read as summaries, instead of skipping it with a warning. The report gets an `unreadableInput` run finding, and `--json` lists the skipped files either way. |
| `--sussignore <path>` | the nearest `.sussignore` | Read this suppressions file instead of searching for one. |
| `--no-suppressions` | off | Report every finding, ignoring any `.sussignore`. |

`--fail-on-empty` is gone. A run that pairs nothing now fails by default, and passing the old flag stops the run and says so.

A finding that points at one transition prints a `.sussignore` rule for it, ready to paste under `rules:`. See [Accept a finding](/guides/accept-a-finding), and [the findings catalog](/reference/findings) for every kind.

## What a run prints

A run prints the errors in full, then counts everything else: the findings below error severity, grouped by kind, and the boundaries that went unpaired.

```
$ suss check --dir summaries/
Compared 4 boundaries.

  13 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

3 findings: 0 error, 2 warning, 1 info

Not shown: 2 boundaryFieldUnknown (warning), 1 boundaryFieldUnused (info). Run the same command with --all to see them.
```

Errors are what `--fail-on error` gates on, so a run leads with them. `--all` writes the rest out in full. Three things do not change with the flag: `--json` always includes every finding and every list, `--at` always prints in full because it is already narrowed to one thing, and the exit code comes from `--fail-on` rather than from what got printed.

Without the collapse, a first run over a repository of any size prints thousands of lines before the first error. Over five public repositories and suss's own packages, the unpaired lists alone were between 66% and 99% of the report.

With `--intent`, an `Intent:` section follows the findings with what was checked and what is still an uncurated draft.

## Reporting on one thing

`--at` runs the same passes over the same folder and prints the part of the report about one target. It is the question you have while editing a file: does this call line up with what it reaches.

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

A target whose unit suss could not fully read ends with a paragraph saying so, whether or not anything was found: "no findings here" means less when part of the unit is missing from the summary.

A target that matches nothing prints what it could not find and exits `1`. An empty report would read as agreement.

## JSON output

`--dir --json` writes one object:

```
{ findings, run, pairs, unmatched, skipped, runtimeNamedCrossings, summariesWithGaps, collisions }
```

with `intent` added when `--intent` was passed. Two positional files write the bare `findings` array instead.

`--at --json` writes `{ at, matched, target, touches, findings, pairs, unmatched, gaps }`, where `touches` is one entry per unit and boundary (`{ boundary, relations, unit, via }`). A target that matched nothing writes `{ at, matched: false, message }`.

[Exit codes](/reference/cli/exit-codes) says what `check` returns to the shell, and how a suppression changes the count.
