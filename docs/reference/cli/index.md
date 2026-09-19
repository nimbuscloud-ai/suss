---
title: suss CLI reference
description: Every suss command with a page of its own, plus the top-level flags, the environment variables and where each command writes.
---

# CLI reference

Every command, every flag. For prose-style usage see the
[Quickstart](/start/quickstart) and the [guides](/guides/add-to-project).

Placeholder notation: `<...>` marks a required value, `[...]` marks
optional. Example: `suss extract -f FRAMEWORK [-o OUTPUT]`.

## What each command is for

suss has four commands. They form one pipeline:

| Command | Inputs | Output | When you reach for it |
|---|---|---|---|
| [`extract`](/reference/cli/extract) | TypeScript or JavaScript source + a framework pack | `BehavioralSummary[]` JSON | You have code and want a structured description of every execution path. |
| [`contract`](/reference/cli/contract) | A specification (OpenAPI, CFN, Storybook, ...) | `BehavioralSummary[]` JSON | You have a spec instead of code, or want to compare code against a spec. Contract summaries have the same structure as `extract`'s output, so they pair against extracted summaries. |
| [`check`](/reference/cli/check) | One or more summary files | Findings (text or JSON) | You have summaries from two sides of a boundary, provider + consumer, contract + handler, and want to know where they disagree. |
| [`inspect`](/reference/cli/inspect) | A summary file | Human-readable text | You want to read what the summaries say without parsing JSON. The output is the form you paste into a code review or an AI prompt. |

The summary JSON is the canonical artifact. `inspect` is a renderer
over it; `check` is a comparator. Anything you can do in `inspect` or
`check` you can also do by reading the JSON yourself, they're
conveniences, not parsing layers. The one command that computes an
answer rather than rendering one is
[`inspect --flow`](/reference/cli/inspect#suss-inspect-flow), which walks
the routing a set of summaries declares to work out who serves a request.

Five more commands are outside the pipeline:

| Command | What it does |
|---|---|
| [`init`](/reference/cli/init) | Works out which packs your project needs and offers to set them up. |
| [`ask`](/reference/cli/ask) | Answers one question about one boundary from summaries already on disk. |
| [`corroborate`](/reference/cli/corroborate) | Experimental. Executes handlers against their own summaries. |
| [`infer`](/reference/cli/infer) | Writes a draft for a person to curate: a [dependency stub](/guides/teach-a-dependency) from the project's calls into a package extraction cannot read, an intent doc per boundary, or a PRD from intent docs that have been curated. |

[Exit codes](/reference/cli/exit-codes) collects what every command
returns to the shell.

## Top-level flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Print usage and exit 0. Running `suss` with no command does the same. |
| `-v`, `--version` | Print the installed version and exit 0. |

Every exit code is `0` or `1`. There is no third code to branch on: a
command either did what you asked or it did not.

## Environment variables

Two affect how output looks. Nothing else is configured this way.

| Variable | Effect |
|---|---|
| `NO_COLOR` | Set it to anything and suss writes plain text with no ANSI colour. |
| `TERM=dumb` | Same effect. Colour is also off whenever stdout is not a TTY, so a piped or redirected run is plain without you asking. |

`suss init` also notices when it is running in CI and prints the
commands rather than prompting, the same as `--plain`.

## Where each command writes

| Target | Default |
|---|---|
| stdout | Summary JSON (`extract`, `contract`), human text (`inspect`, `check`, `ask`), finding JSON (`check --json`) |
| stderr | "Wrote N summaries to PATH" acknowledgements, extraction warnings, error messages |
| exit code | The per-command threshold in [Exit codes](/reference/cli/exit-codes) |

Output destinations are composable: `suss extract ... -o file.json` writes
summaries to the file AND a one-line acknowledgement to stderr.
`suss check ... -o findings.txt` writes the formatted report to the file,
nothing to stdout. Piping (`suss extract ... | jq '...'`) works because
non-`-o` mode writes JSON to stdout with nothing else.
