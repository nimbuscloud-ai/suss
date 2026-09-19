---
title: suss corroborate (experimental)
description: Run each handler locally against the claims suss derived for it, and record what execution said beside the derived claim.
---

# `suss corroborate` (experimental)

Extract, then run each handler against its own claims.

**What it does.** It runs a normal extraction, then for every summary in
scope it generates request inputs that satisfy a transition's own
extracted conditions, executes the actual handler function in a sandbox
with a stub response object, and compares the observed status with
the claimed one. Verdicts land on
`transition.confidence.corroboration`:

- `observed`: every satisfying run produced the claimed status.
- `refuted`: some run produced a different status. The concrete
  counterexample (request, observed status, claimed status) is
  attached and printed. Either the extraction is wrong there or the
  code surprises its own summary, and both are findings.
- `untested`: no satisfying input was found, or every run hit a
  dependency the sandbox cannot supply (a database, another service).
  The claim keeps its static confidence.

**Scope today** (why the flag is mandatory): `handler` summaries
recognized by the express or fastify packs, and only claims with a
literal status code. Everything else is skipped untouched. The scope
and the report format will change as coverage grows.

```
suss corroborate --experimental [-p TSCONFIG | --dir DIR] -f express
                 [-o ANNOTATED.json] [--runs N] [--attempts N]
```

| Flag | Description |
|---|---|
| `--experimental` | Required. Acknowledges the command is early. |
| `-p, --project PATH` | tsconfig covering the code to read. Same resolution as `extract`. |
| `--dir PATH` | Directory to read when there is no tsconfig. |
| `-f, --framework NAME` | Pack to use. Repeatable, same names as `extract`. |
| `--runs N` | Verdict-producing executions to aim for per claim (default 25). |
| `--attempts N` | Sampling attempts per claim before giving up (default 300). |
| `-o, --output PATH` | Write the annotated summaries to a file. |

[Exit codes](/reference/cli/exit-codes#suss-corroborate) says what
`corroborate` returns to the shell.

