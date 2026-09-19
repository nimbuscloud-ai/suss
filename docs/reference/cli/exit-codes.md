---
title: suss CLI exit codes
description: What each suss command returns to the shell, so a CI job can tell a finding from a crash.
---

# Exit codes

Every code is `0` or `1`. There is no third code to branch on: a command either did what you asked or it did not.

| Command | Exits `0` | Exits `1` |
|---|---|---|
| `suss --help`, `suss --version`, `suss` with no command | Always. Any command given `--help` prints the usage and exits `0` too. | Never, though a command name suss does not have makes it print the usage and exit `1`. |
| [`init`](/reference/cli/init) | Always. Declining every question, cancelling, and a failed install all end the same way. A failed install prints what npm said and leaves you the command to retry. | Never. |
| [`extract`](/reference/cli/extract) | It produced at least one summary, or ran with `--allow-empty`, and neither `--gaps strict` nor `--fail-on-pack-error` found something to fail on. | It produced nothing and `--allow-empty` was not passed; `--gaps strict` recorded a gap; a pack threw while `--fail-on-pack-error` was on; an unknown pack, a `-p` path with no tsconfig, a `--dir` that does not exist, a bad `--lang` or `--gaps` value, a pack config the pack cannot read; or extraction threw. |
| [`contract`](/reference/cli/contract) | The source loaded, even when it declares no boundary suss could read. | No `--from`, a source that is not one of the ten, no path, a fetch that failed, or a file suss could not parse. |
| [`check`](/reference/cli/check) | Nothing at or above `--fail-on` (`error` by default), after suppressions. | Something at or above the threshold; `--at` matched nothing; a `--dir` run paired nothing without `--allow-empty`; `--fail-on-unpaired` or `--fail-on-unreadable` fired; or the arguments do not make a form (one positional file, `--at` with two files, `--allow-empty` without `--dir`, `--at` together with `--intent`). |
| [`inspect`](/reference/cli/inspect) | It rendered. | The file is missing or is not valid summary JSON; a flag `inspect` does not take; `--changed-files`, `--budget` or `--chain` without `--diff`; `--diff` with fewer than two files; or, given nothing, a project where nothing matched a pack. |
| [`inspect --flow`](/reference/cli/inspect#suss-inspect-flow) | It worked out an answer, including when nothing serves the request. | The request would not parse, there were no summaries to read, or the entry node is ambiguous. |
| [`ask`](/reference/cli/ask) | The question is one of the ten and its subject is in the summaries it read, even when the answer is empty. Running `suss ask` with no question prints the list and exits `0`. | The question is not one of the ten, nothing in the summaries is at the boundary it asked about, or a why question's chain is not one the run contains. |
| [`corroborate`](/reference/cli/corroborate) | Every claim that could be tried held up, or nothing was in scope. | A claim was refuted by execution; `--experimental` was left off; `--runs` or `--attempts` was not a positive whole number; or the project has no packs to read with. |
| [`infer stub`](/reference/cli/infer#suss-infer-stub) | A draft was written, or printed with `-o -`. | The project shows no evidence of the package: no calls, no imports, no requires, no superclass. Also when the target file already exists, or `-o` points at one path for a Python package that drafts several. |
| [`infer intent`](/reference/cli/infer#suss-infer-intent) | At least one doc was written. | No boundary in the summaries could be drafted as intent, or `--into` points at a folder that already has intent docs. |
| [`infer prd`](/reference/cli/infer#suss-infer-prd) | At least one PRD was written. | Every boundary intent already has a scenario pointing at it, a document in the folder is still an uncurated draft, or `--into` points at a folder that already has PRDs. |

When `--json` is among the arguments, the reason for a usage failure arrives on stdout as `{"error": "..."}` as well as on stderr, so a caller parsing stdout gets it rather than a truncated stream.

`--fail-on-empty` is gone from both `extract` and `check`. A run that finds or pairs nothing now fails by default; passing the old flag exits `1` and says to use `--allow-empty` instead.

## Suppressions and the check threshold

A `.sussignore` rule changes what counts toward `--fail-on`. A finding suppressed with `mark` or `hide` does not count; one suppressed with `downgrade` counts at the downgraded severity. See [Accept a finding](/guides/accept-a-finding).
