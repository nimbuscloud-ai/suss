---
title: Run suss in CI
description: Post what a pull request changes about each boundary as a comment, fail the job when two sides of a boundary disagree, and every input the GitHub Action takes.
---

# Run suss in CI

Post what a pull request changes about each boundary as a comment, so the reviewer reads the behavior instead of the diff, and fail the job when a provider returns a status no client handles.

```yaml
name: suss

on:
  pull_request:
  push:
    branches: [main]

jobs:
  behavior-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
```

The action runs `suss extract` at the head of the pull request, checks the base commit out beside it, runs the same extract there, and posts `suss inspect --diff` between the two as one comment. A later push edits that comment rather than adding another.

## What the comment says

> ### 2 units change behavior in this pull request
>
> ```
> 1 boundary changed: 1 outcome, 1 effect. 1 unit inside the project also changed.
>
> ~ serves POST /users  src/handlers/users.ts::createUser  (1 outcome, 1 effect)
>   outcomes
>     ~ responds 201 { id, email, -name }  otherwise
>   effects
>     + writes postgresql:audit_log  through recordChange
>
> Changes by file
>
> src/handlers/users.ts
>   ~ createUser
>
> src/serializers/user.ts  (changed in this pull request)
>   ~ serializeUser  1 outcome
> ```
>
> <sub>Read by suss at 3f2a1c9. The summaries it compared are the `suss-diff` artifact of the run.</sub>

The first line counts what moved: how many boundaries, how many of their outcomes and effects, and how many units further in are different too. Then comes a block per boundary that moved, with `outcomes` for what it returns and under what test, and `effects` for what a request now reaches or stopped reaching. A unit deeper in the project gets no block of its own, since the boundaries that reach it already show what its change did.

An outcome that reached several routes from one filter, middleware or error handler is printed once, under `From <wrapper>`, with the routes that have it and the routes the wrapper runs on that still do not. Fourteen routes gaining a 401 is printed as the one edit it was.

Last come the files with units that moved. A unit with a couple of lines to its name has them written out, one with more gets a count instead, and a unit in a file the pull request edited gets the count either way, because the reviewer already has that file's diff in front of them. A comment stops at 65,536 characters, so the action renders it with `--budget` and the report counts what it left out. The whole diff is in the run's artifact.

## Choosing the packs

The action reads the packs from the project's `suss.json`, which `suss init` writes. Without one it picks the packs `init` would. To choose them yourself, set `extract` to whatever you would type after `suss extract` on your own machine:

```yaml
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        with:
          extract: -p tsconfig.json -f hono -f prisma
```

For Python that is `--dir src -f fastapi`, and for Ruby `--dir app -f rails`.

## The action's inputs

| Input | Default | What it is |
| --- | --- | --- |
| `extract` | empty | The arguments to `suss extract`, after the command. Empty reads the packs from `suss.json`, or the ones `suss init` would pick when there is no file. |
| `working-directory` | `.` | The directory to run `suss extract` in, relative to the repository root. |
| `version` | `latest` | The version of `@suss/cli` to install. |
| `install` | empty | A shell command that installs dependencies in the base checkout, such as `pnpm install --frozen-lockfile` or `npm ci && npm run build`. When it is empty the base checkout shares the head's `node_modules` directories, which is right when the pull request does not change dependencies. |
| `comment` | `true` | Whether to post the comment. Set it to `false` to read the outputs and do something else with them. |
| `artifact-name` | `suss-diff` | The name of the run artifact that keeps both summary files and the diff. Two uses of the action in one workflow need two names. |
| `cache` | `true` | Whether to keep suss's per-file cache and each commit's summaries in the repository's actions cache. |
| `token` | `github.token` | The token used to post the comment. It needs `pull-requests: write`. |

## The action's outputs

| Output | What it is |
| --- | --- |
| `changed` | How many units changed behavior, as a number. |
| `diff` | The path of the rendered diff. |
| `before` | The path of the summaries read from the base commit. |
| `after` | The path of the summaries read from the head commit. |

`changed` is what a job condition reads:

```yaml
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        id: suss
        with:
          extract: -p tsconfig.json -f hono
      - if: steps.suss.outputs.changed != '0'
        run: echo "::notice::${{ steps.suss.outputs.changed }} units changed behavior"
```

## Caching, and the `push` trigger

Reading a large project takes a while, and the action reads it twice. Two caches cut that down, both in the repository's actions cache and both on by default.

The first is suss's own per-file cache, so a file the pull request did not touch is not read again. A run that changes one file reads that file and whatever depends on it.

The second is the summaries of each commit, and that one is why the workflow at the top has a `push` trigger. On a push to the default branch the action reads the commit, saves its summaries under it, and stops: no diff, no comment, and `changed` comes back empty. A pull request whose base is that commit restores those summaries and skips the base checkout entirely. A pull request whose base was never read this way reads the base itself and saves it for its own later pushes.

Both caches are keyed on the installed version of `@suss/cli` and on `extract` and `working-directory`, so a new release or a change to the packs starts them over. Set `cache: false` to read everything on every run.

## A pull request from a fork

A fork's pull request gets a read-only token, so the comment step fails there. The diff is still in the job log and in the artifact. Turn the comment off for forks if the failure is unwelcome:

```yaml
        with:
          extract: -p tsconfig.json -f hono
          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
```

## Without the Action

Any CI system runs the same three commands. Extract each side of your boundaries into one directory, then compare them:

```yaml
name: suss

on: [pull_request]

jobs:
  boundary-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci

      - name: Read every side into one folder
        run: |
          npx suss extract -p tsconfig.json -f express -o summaries/api.json
          npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
          npx suss contract --from openapi openapi.yaml -o summaries/contract.json

      - name: Compare them
        run: npx suss check --dir summaries/ --fail-on error
```

`check --dir` pairs every provider summary with every consumer summary that shares a boundary key, `GET /users/:id` or `bus:aws_sqs PaidQueue`. The two sides do not have to come from the same kind of source: a provider read out of an OpenAPI document pairs with a consumer read out of axios call sites.

With a `suss.json` committed, all of that collapses to `npx suss check`. It runs every extract and every contract read that the file lists, then compares what came back. [Add suss to a project](/guides/add-to-project) covers what `init` writes.

## The exit code as the gate

`check` exits 1 when it finds something at or above the severity you give `--fail-on`, and `error` is the default. Warnings and info findings print without failing the build. Move to `--fail-on warning` once every accepted finding is in `.sussignore.yml` and a new warning means something.

Two other exits matter here. A run that paired nothing exits non-zero, because having nothing to report looks exactly like both sides agreeing; pass `--allow-empty` when an empty run is expected, such as checking one side before the other has been extracted. `--at` exits non-zero when it matches nothing, for the same reason. [Exit codes](/reference/cli/exit-codes) lists what every command returns.

Do not gate on `--fail-on info`. Info findings are advisory, and failing on them produces churn with no signal behind it.

## Findings as JSON

`--json` writes findings for a dashboard or a reporting step of your own:

```yaml
- id: check
  run: npx suss check --dir summaries/ --json -o findings.json
  continue-on-error: true

- name: Count the errors
  if: always()
  run: node -e 'const r = require("./findings.json"); console.log(r.findings.filter((f) => f.severity === "error").length)'
```

`check --json` writes one object rather than a bare array. `findings` is the IR's `Finding[]`, the same type the checker exports, and the other keys describe the run around it: `pairs`, `unmatched`, `runtimeNamedCrossings`, `summariesWithGaps` and `collisions`. A downstream tool wants `.findings`, and can validate it against `@suss/behavioral-ir`'s exported schema.

A red check with nothing parseable behind it gives an automated fixer nothing to act on, so write the JSON somewhere the same job can read it.

## Accepted findings

Not every finding should fail the build. A legacy endpoint returns 500 on a timeout and the team has accepted it; a `deadConsumerBranch` covers a status the server has never produced. `.sussignore.yml` at the project root keeps those, each with a written reason:

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: GET /legacy/health
    reason: legacy handler kept for the load balancer
    effect: mark
  - kind: boundaryFieldUnknown
    boundary: POST /users
    effect: downgrade
    reason: planned work in JIRA-1234
```

[Accept a finding](/guides/accept-a-finding) has the full rule syntax and the three effects. Commit the file: it is a curated list of decisions, unlike `summaries/`, which is derived and belongs out of the repository.

## Before you push

The jobs on this page run after the code is written and pushed. The same commands work on a local checkout, where a finding costs an edit rather than a failed build:

```bash
npx suss check --dir summaries/
npx suss inspect --diff summaries/before.json summaries/after.json
```

`before.json` is an extract from the commit you branched from and `after.json` is one from the working tree.

If an agent writes the code, put those commands in the instructions it reads, or set up the [MCP server](/start/give-your-agent-suss) so it can ask before it edits. Keep the CI jobs as well, because they are what catches the change that skipped the local run.

suss runs this on its own pull requests, reading the workspace through the `package-exports` pack. [behavior-diff.yml](https://github.com/nimbuscloud-ai/suss/blob/main/.github/workflows/behavior-diff.yml) is the whole workflow.
