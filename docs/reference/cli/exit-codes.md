---
title: suss CLI exit codes
description: What each suss command returns to the shell, so a CI job can tell a finding from a crash.
---

# Exit codes

What each command returns to the shell, command by command.

## `suss init`

`0`, always. Declining every question, cancelling, and a failed install
all end the same way. A failed install stops there, prints what npm said,
and leaves you the command so you can retry it yourself.

## `suss extract`

- `0`: extraction succeeded, produced at least one summary or ran with `--allow-empty`, and neither `--fail-on-pack-error` nor `--gaps strict` found something to fail on.
- Non-zero: extraction threw (invalid tsconfig, unknown framework, missing files), it produced no summaries and `--allow-empty` was not passed, or one of those flags fired.

## `suss contract`

- `0`: contract source loaded.
- `1`: unknown source, file not found, parse error.

## `suss check`

- `0`: no findings at or above the threshold (after suppressions).
- `1`: at least one finding at or above the threshold, or, under `--at`,
  a target that matched nothing.

Suppressions (`.sussignore`) affect counting: `mark` and `hide`
effects don't count toward the threshold; `downgrade` counts at
the downgraded severity. See [Accept a finding](/guides/accept-a-finding).

## `suss ask`

- `0`: the question was one of the ten and its subject is in these
  summaries, including when the answer is empty.
- `1`: the question was not one of the ten, nothing here is at the
  boundary it asked about, or a why question's chain is not one the
  run contains.

## `suss inspect`

- `0`: rendered successfully.
- Non-zero, input file missing or not valid summary JSON.

## `suss corroborate`

- `0`: every claim that could be tried held up (or nothing was in scope).
- Non-zero: at least one claim was refuted by execution.

## `suss infer stub`

- `0`: a draft was written (or printed).
- `1`: no calls into the package were found, so there was nothing to draft.

## `suss infer intent`

- `0`: at least one doc was written.
- `1`: no boundary in the summaries could be drafted as intent.

## `suss infer prd`

- `0`: at least one PRD was written.
- `1`: every boundary intent already has a scenario pointing at it.
