# AGENTS.md

suss reads a codebase and writes down what each execution path does:
which routes it serves, which stores it touches, which fields it reads
and writes, which statuses it returns. It then compares two sides of a
boundary and reports where they disagree. This file says how to drive
it from a coding agent and where to look for each question.

The canonical artifact is the summary JSON. Everything else in the tool
renders it or compares it, so anything a command tells you is also
available by reading the file yourself.

## Set a project up once

```
suss init
```

It reads `package.json`, finds the frameworks and the spec files, and
offers to write `suss.json` with the commands this project needs. Say
yes. Later runs read that file, so a boundary whose other side lives in
an OpenAPI spec gets compared instead of going unpaired without anybody
noticing. In CI it prints the commands instead of prompting.

## Which command to use

| You want | Run |
|---|---|
| A structured description of what the code does | `suss extract` |
| The same, from a spec instead of code | `suss contract --from openapi` |
| Where two sides of a boundary disagree | `suss check` |
| To read what the summaries say | `suss inspect` |
| One question about one boundary | `suss ask` |

A normal loop is extract, then contract for every spec, then check over
the directory both wrote into:

```
suss extract -f express --dir src -o .suss/code.json
suss contract --from openapi openapi.yaml -o .suss/spec.json
suss check --dir .suss --fail-on-empty --json
```

`--fail-on-empty` matters for automation. Without it a run that paired
nothing exits 0 and prints the same "no findings" as a run where both
sides agreed. With it on, the report gets a `nothingPaired` finding
under `run` saying what happened and what to do, so a fixer reacting to
the red exit has something to act on.

Full flags for every command: [docs/reference/cli.md](docs/reference/cli.md).

## Asking one question

`suss ask` reads summaries already on disk, so it costs one file read
rather than a re-extract.

```
suss ask "what writes aws.dynamodb:orders" --dir .suss --json
```

Seven questions, in these words:

- `what can I project from <boundary>`, also `what does <boundary> declare`
- `what reads <boundary>`
- `what writes <boundary>`
- `what calls <unit>`
- `what does <unit> reach`
- `why does <unit> reach <boundary>`
- `why does <name> at <file>:<line> resolve to <target>`

Five have a symbol form: `<- <unit>`, `<unit> ->`, and the rest under
[`suss ask`](docs/reference/cli.md#suss-ask), which also gives the
spellings a boundary accepts.

`--json` returns `{ question, shape, subject, found, headline, items,
needs, caveats }`. A why answer adds the chain and each hop's
resolution. `needs` is the part to act on when `found` is false: it
says which input would let suss answer, rather than leaving an empty
list to interpret.

Exit code 0 means the question parsed and its subject is in these
summaries, including when the answer is empty. Exit code 1 means the
question was not one of the seven, or nothing here is at the boundary
it named.

## Reading a finding

Every kind suss emits has an entry in
[docs/reference/findings.md](docs/reference/findings.md): what emits
it, an example of the output, and when it is legitimate versus when it
is a defect.

A run produces up to three lists and they have different shapes.
`findings` says two sides of a boundary disagree. `intent` says code and
a document your team wrote disagree, and appears when you pass
`--intent`. `run` says the run could not get far enough to compare
anything. Read all three: a parser that reads only `findings` misses a
run that failed because it compared nothing.

Read the legitimate case before acting. Several kinds have no universal
fix. `unhandledProviderCase` fires when a provider can return something
no consumer handles, and whether to change the consumer, change the
provider, or leave it depends on whether that branch is reachable in
your deployment, which suss cannot see.

Severity decides the exit code. It does not say what to do. The default
threshold is `error`, so warnings and info findings print without
failing the run. A finding that points at one transition prints a
`.sussignore` rule you can paste, so a decision to accept a finding is
recordable rather than repeated.

## Running it as an MCP server

`@suss/mcp` puts the same questions in front of a model as tools, so it
can ask one mid-task instead of remembering this file:

```bash
npx @suss/mcp /path/to/project
```

`suss_ask` takes the eight questions. `suss_check` compares both sides
of every boundary. `suss_boundaries` lists them. `suss_status` says
which commands the server ran and which failed.

The server re-extracts when a source file changes, so an answer
describes the tree as it is rather than the last time somebody ran
`extract`. That matters most in the loop below.

## Where to run it

By the time CI runs, the code is written and the only move left is to
reject it. Run extract and check in the loop that writes the code, and
keep the merge gate as a backstop.

For an agent this means reading the summary for a file before changing
it, and asking `what reads` or `what calls` before changing something
other code depends on. A red check with nothing parseable behind it
gives a fixer nothing to work with, so prefer `--json` and act on the
findings rather than on the exit code.

## What is safe to parse

The summary format is versioned. Pin to `v0` and check the schema
version before parsing:
[docs/behavioral-summary-format.md](docs/behavioral-summary-format.md).

Human text from `inspect` and `check` is not a stable interface. Use
`--json` on `check`, `ask`, `inspect --diff`, and `inspect --flow`.
What each language and module system supports is in
[docs/reference/compatibility.md](docs/reference/compatibility.md).

## Calling it as a library

The CLI is a wrapper. From Node:

```ts
import { parseSummaries, diffSummaries } from "@suss/behavioral-ir";
import { checkAll, checkPair } from "@suss/checker";
```

`parseSummaries` validates and narrows the JSON, `checkAll` pairs a
whole set by boundary, `checkPair` compares two, and `diffSummaries`
reports what changed between two runs.

## When a run finds nothing

An empty report has three causes and they are distinguishable.

- Nothing paired. `--fail-on-empty` exits non-zero and says how many
  summaries were read.
- A pack read your files and recognised none of them. The pack health
  block says so; see
  [docs/guides/pack-health.md](docs/guides/pack-health.md).
- Both sides agree. This is the only one that means what it looks like.

## Where the rest lives

- [Docs site](https://nimbuscloud-ai.github.io/suss/)
- [What a boundary is](docs/boundary-semantics.md)
- [Writing a pack](docs/guides/writing-a-pack.md) for a framework suss
  does not read yet
- [Suppressions](docs/suppressions.md)
