---
title: suss check
description: Pair the two sides of every boundary and report where a provider and its consumer disagree, with every flag and the shape of the JSON report.
---

# `suss check`

Pair providers with consumers and report cross-boundary findings.

**What it does.** It reads summary files, groups them into
provider/consumer pairs by their boundary key (e.g. `(GET,
/users/:id)`), and runs each pair through a set of agreement
checks: does every status the provider produces have a consumer
branch that handles it? Does every status the contract declares
have a producer? Are the body shapes structurally compatible?

The "two sides of a boundary" framing is general:
- **Two extracted summaries**: handler vs. fetch client.
- **A contract vs. an extracted summary**, OpenAPI spec vs. handler;
  Storybook story vs. component.
- **Two contracts**, OpenAPI vs. CloudFormation, when both describe
  the same API.

Every finding tells you the boundary, the two sides, and what
disagrees. There's no global "compliance score", every finding is
a concrete pair.

```
# Two explicit summary files
suss check PROVIDER.json CONSUMER.json [--all] [--json] [-o OUTPUT] [--fail-on THRESHOLD]

# A whole directory, auto-pairs by boundary key
suss check --dir DIR [--intent INTENT_DIR] [--all] [--json] [-o OUTPUT]
           [--fail-on THRESHOLD] [--allow-empty] [--fail-on-unpaired N|N%]
           [--fail-on-unreadable] [--sussignore PATH] [--no-suppressions]

# One thing out of that directory
suss check --dir DIR --at TARGET [--json] [-o OUTPUT] [--fail-on THRESHOLD]

# The project in the current directory, read first
suss check [--at TARGET] [--intent INTENT_DIR] ...
```

Given no files and no `--dir`, `check` reads the project it is run in
first, the way the MCP server does: every entry in `suss.json`, or what
`init` would pick when there is no file, into a temporary directory,
then the directory form over that. It prints the commands it ran to
stderr.

| Flag | Description |
|---|---|
| `--dir PATH` | Directory containing summary JSON files. suss reads every `.json` in the dir and auto-pairs by boundary. Mutually exclusive with positional args. |
| `--at TARGET` | Report on one thing instead of the whole folder. See [Reporting on one thing](/reference/cli/check#reporting-on-one-thing). Takes `--dir` or no files at all, and does not run with `--intent`. |
| `--intent PATH` | Directory of team-authored intent docs (`*.intent.yaml`, `*.intent.yml`, `*.intent.json`, and the same three for `*.prd`). Each boundary intent is paired against the summaries in `--dir`, adding intent-coverage findings to the report. Takes `--dir` or no files at all. |
| `--all` | Write out every finding and every list. See [What a run prints](#what-a-run-prints). |
| `--json` | Emit findings as JSON rather than human-readable text. Default: human text. |
| `-o`, `--output PATH` | Write findings to file. Default: stdout. |
| `--fail-on THRESHOLD` | `error` (default), exit non-zero when any error-severity finding exists. `warning`, also fail on warnings. `info`, fail on any finding. `none`, never fail (still prints). |
| `--allow-empty` | Let a run over `--dir` that paired nothing exit 0. Without it, that run fails: it has nothing to report and would read as a pass, the same as when both sides agree, so the report gets a `nothingPaired` run finding saying what happened and what to do, and the run exits non-zero. Needs `--dir`; a two-file check has no pairing count, and refuses the flag. |
| `--fail-on-unpaired N\|N%` | Fail the run when more boundaries went unpaired than this: a count (`25`) or a share of all boundaries (`50%`). Needs `--dir`. A run that pairs three boundaries out of hundreds otherwise exits the same as one that paired everything; the report gets a `mostlyUnpaired` run finding with the numbers. |
| `--fail-on-unreadable` | Fail the run when a file in `--dir` could not be read as summaries, instead of skipping it with a warning. The report gets an `unreadableInput` run finding, and `--json` output lists the skipped files either way. |
| `--sussignore PATH` | Use this `.sussignore` file instead of searching for one nearby. |
| `--no-suppressions` | Report every finding, ignoring any `.sussignore`. Useful for auditing what the suppressions are hiding. |

A finding that points at one transition prints a `.sussignore` rule for
it, ready to paste under `rules:`. The rule identifies the transition on
whichever side has it, so it matches that finding and no other. See
[Accept a finding](/guides/accept-a-finding).

## What a run prints

A run prints the errors in full, then counts everything else. The
counted parts are the findings below error severity, grouped by kind,
and the boundaries that went unpaired.

```
Compared 194 boundaries.

  400 provider-side boundaries have no client to compare against.
  10 client-side boundaries have no provider to compare against.
  11248 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

167 findings: 0 error, 167 warning, 0 info

Not shown: 167 boundaryFieldUnknown (warning). Run the same command with --all to see them.

4862 of 12229 summaries record something suss could not read, so what this run knows about those units is partial. Run `suss inspect` over the same files to see what.
```

Errors are what `--fail-on error` gates on, so they are what a run
leads with. The rest is there in a count, and `--all` writes all of it
out. Three things do not change with the flag. `--json` always includes
every finding and every list. `--at` always prints in full, because it
is already narrowed to one thing. The exit code is decided by
`--fail-on` rather than by what got printed.

Without the collapse, a first run over a repository of any size prints
thousands of lines before the first error. Over five public
repositories and suss's own packages, the unpaired lists alone were
between 66% and 99% of the report.

## Reporting on one thing

`--at` runs the same passes over the same folder and prints the part of
the report about one target. It is the question you have while editing a
file: does this call line up with what it reaches.

A target is one of four spellings, resolved in this order:

| Spelling | Example | What it picks out |
|---|---|---|
| Summary id | `app::src/editions/dao.ts::byPublication` | That one summary. A tail of the id works too, so the workspace in front is optional. |
| File and line | `src/editions/dao.ts:43` | The units covering line 43, and the branches that line falls in. Findings about other branches of the same function are left out. |
| File | `src/editions/dao.ts` | Every unit in that file. Matching is on whole path segments, so `dao.ts` finds it and `ao.ts` does not. |
| Boundary | `dynamodb:editions#by-publication` | Everything either side of that boundary, whichever file it is in. |

A file wins over a boundary, so a path is never read as a boundary whose
words happen to line up.

A boundary is spelled the way reports spell it, and a shorter spelling
covers more: `dynamodb:editions` covers the table and every index on it,
and `dynamodb:editions#by-publication` narrows it to the one index. The
same goes for a route, where `/editions` covers `GET /editions`.

```
$ suss check --dir .suss --at 'src/editions/dao.ts:45'
src/editions/dao.ts:45 (src/editions/dao.ts line 45, 1 summary, 1 branch over that line)

What it touches:
  dynamodb:editions#by-publication
    reads    src/editions/dao.ts::byPublication  via docClient.query

Compared 1 boundary here:
  dynamodb:editions#by-publication
    infra/editions.tf::aws_dynamodb_table.editions#by-publication <-> src/editions/dao.ts::byPublication

────────────────────────────────────────────────────────────
[ERROR] boundaryFieldUnknown
  byPublication selects "wordCount" on editions#by-publication (dynamodb) but the contract declares no wordCount field.
  ...
────────────────────────────────────────────────────────────
1 finding: 1 error, 0 warning, 0 info

1 thing here suss could not read, so what it knows about this target is partial:
  src/editions/dao.ts::byPublication
    suss met a call to loadCursor and could not settle which function it is, so whatever it does is missing from this summary.
```

The last paragraph is there whether or not anything was found: "no
findings here" means less when part of the unit could not be read, so a
target with a gap on it says so either way.

A target that matches nothing prints what it could not find and exits
`1`. An empty report would read as agreement.

`--json` writes the same report as `{ at, matched, target, touches,
findings, pairs, unmatched, gaps }`, where `touches` is one entry per
unit and boundary (`{ boundary, relations, unit, via }`) and `findings`
is the finding shape [`check --json`](/reference/cli/check) already
writes. A target that matched nothing writes
`{ at, matched: false, message }`.

[Exit codes](/reference/cli/exit-codes#suss-check) says what `check`
returns to the shell, and how a suppression changes the count.

