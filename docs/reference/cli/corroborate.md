---
title: suss corroborate (experimental)
description: Run each handler against the claims suss derived for it, and record what execution said beside the derived claim.
---

# `suss corroborate` (experimental)

`suss corroborate` extracts your code as usual, then executes each handler to see whether it behaves the way the summary says it does. Run it when you want evidence that a summary is right before you trust a finding built on it. It writes the same summaries `extract` writes, with a verdict added to each claim it was able to test.

```
suss corroborate --experimental [-p <tsconfig> | --dir <directory>] [-f <pack> ...]
                 [-o <output.json>] [--runs <n>] [--attempts <n>]
```

| Flag | Default | What it does |
|---|---|---|
| `--experimental` | required | The command is early, and its scope and output will change. Without this flag the run stops. |
| `-p`, `--project <path>` | the nearest tsconfig | The tsconfig covering the code to read. |
| `--dir <path>` | the working directory | Read this directory, for a project with no tsconfig. |
| `-f`, `--framework <name>` | the packs in `suss.json`, or what `init` would pick | Which pack to read with. Repeatable, and the same names [`extract`](/reference/cli/extract#pack-names) takes. |
| `--runs <n>` | `25` | Verdict-producing executions to aim for per claim. |
| `--attempts <n>` | `300` | Sampling attempts per claim before giving up. |
| `-o`, `--output <path>` | stdout | Write the annotated summaries to a file. |

## What it does

It runs a normal extraction. Then, for every summary in scope, it generates request inputs that satisfy a transition's own extracted conditions, executes the handler in a sandbox with a stub response object, and compares the status it observed with the one the summary claimed. The verdict lands on `transition.confidence.corroboration`:

| Verdict | What it means |
|---|---|
| `observed` | Every satisfying run produced the claimed status. |
| `refuted` | Some run produced a different status. The counterexample, with the request, the observed status and the claimed one, is attached to the summary and printed. Either suss read the handler wrongly, or the handler returns a status its summary doesn't claim. |
| `untested` | No satisfying input was found, or every run hit a dependency the sandbox cannot supply, such as a database or another service. The claim keeps its static confidence. |

## Scope today

`handler` summaries the express or fastify pack recognized, and only claims with a literal status code. Everything else is skipped untouched. That is why `--experimental` is required: the scope and the report format will both change as coverage grows.

## Example

```
$ suss corroborate --experimental --dir fixtures/express -f express
Ran 4 of 4 summaries against their own code.
  GET /users/:id: 4 claims, 1 held, 3 untried
  GET /old-profile: 1 claim, 1 held
  GET /moved: 1 claim, 1 held
  /webhooks/:source: 1 claim, 1 held
Every claim that could be tried held up.
Untried claims need a dependency the sandbox does not have, or an input the sampler did not find. They stay at their static confidence.
```

[Exit codes](/reference/cli/exit-codes) lists what `corroborate` returns to the shell.
