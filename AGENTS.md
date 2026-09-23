# AGENTS.md

suss reads a codebase and writes down what each execution path does:
which routes it serves, which stores it touches, which fields it reads
and writes, which statuses it returns. It then compares two sides of a
boundary and reports where they disagree. A coding agent can drive all
of it from the commands below.

Everything suss produces starts from the summary JSON. Every command
either prints it or compares it, so you can get anything a command
tells you by reading the file yourself.

## Set a project up once

```
suss init
```

It reads `package.json`, finds the frameworks and the spec files, and
offers to write `suss.json` with the commands this project needs. Say
yes. Later runs read that file. Without it, a boundary whose other side
is in an OpenAPI spec goes unpaired, and nobody notices. In CI, `init`
prints the commands instead of prompting.

## Which command to use

| You want | Run |
|---|---|
| A structured description of what the code does | `suss extract` |
| The same, from a spec instead of code | `suss contract --from openapi` |
| Where two sides of a boundary disagree | `suss check` |
| To read what the summaries say | `suss inspect` |
| One question about one boundary | `suss ask` |

A normal run is `extract`, then `contract` once for every spec, then
`check` over the directory both of them wrote to:

```
suss extract -f express --dir src -o .suss/code.json
suss contract --from openapi openapi.yaml -o .suss/spec.json
suss check --dir .suss --json
```

A run that pairs nothing exits non-zero by default. Otherwise
automation could not tell it apart from a run where both sides agreed,
because both would print "no findings". The report also gets a
`nothingPaired` finding under `run` that describes what happened and
what to do next, so whatever reacts to the failed exit has something to
act on. Pass `--allow-empty` when you expect an empty run.

The flags for every command are in [docs/reference/cli/index.md](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/cli/index.md).

## Asking one question

`suss ask` reads the summaries already on disk. A question costs one
file read, and nothing is extracted again.

```
suss ask "what writes aws.dynamodb:orders" --dir .suss --json
```

It takes ten questions, worded like this:

- `what can I project from <boundary>`, also `what does <boundary> declare`
- `what reads <boundary>`
- `what writes <boundary>`
- `what invokes <boundary>`
- `what calls <unit>`
- `what does <unit> reach`
- `what reaches <target>`
- `what does <package or unit> provide`, also `what does <package> export`
- `why does <unit> reach <boundary>`
- `why does <name> at <file>:<line> resolve to <target>`

Run `suss ask` with no question and it prints this list back.

Five of them also have a symbol form, such as `<- <unit>` and
`<unit> ->`. The reference for
[`suss ask`](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/cli/ask.md)
lists the rest, along with the spellings a boundary accepts.

`--dir` points at the summaries to read. `--project` points at the
source for a why question, when the source is not in the working
directory. `--json` returns `{ question, shape, subject, found,
headline, items, needs, caveats }`, and a why answer adds the chain and
how each hop was resolved. When `found` is false, act on `needs`. It
lists the input that would let suss answer, so you are not left
guessing at an empty list.

A why question reads the file it asks about again, using the adapter
for that file's language. TypeScript, Python and Ruby each have one.
When the adapter cannot read the source, the answer includes a caveat
saying so.

Exit code 0 means the question parsed and its subject is in these
summaries, even when the answer is empty. Exit code 1 means the
question was not one of the ten, or nothing in these summaries is at
the boundary it named.

## Reading a finding

Every finding kind has an entry in
[docs/reference/findings.md](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/findings.md).
The entry lists what emits it, shows an example of the output, and
explains when the finding is legitimate and when it points at a bug.

A run produces up to three lists, and each has its own format.
`findings` lists places where two sides of a boundary disagree.
`intent` lists places where the code and a document your team wrote
disagree, and it appears when you pass `--intent`. `run` lists the
reasons a run could not get far enough to compare anything. Read all
three. A parser that reads only `findings` will miss a run that failed
because it compared nothing.

Before acting on a finding, read the legitimate case in its entry.
Several kinds have no single fix. `unhandledProviderCase` fires when a
provider can return something no consumer handles. You might change
the consumer, change the provider, or leave it alone, and the choice
depends on whether that branch is reachable in your deployment. suss
cannot see that.

Severity decides the exit code, and it does not tell you what to do.
The default threshold is `error`, so warnings and info findings print
without failing the run. When a finding points at one transition, suss
prints a `.sussignore` rule you can paste. Accepting that finding then
goes on record once, and nobody has to make the same call again on the
next run.

## Running it as an MCP server

`@suss/mcp` offers the same questions to a model as MCP tools, so the
model can ask one in the middle of a task without having to remember
this file:

```bash
npx @suss/mcp /path/to/project
```

`suss_ask` takes the ten questions. `suss_check` compares both sides
of every boundary. `suss_boundaries` lists the boundaries.
`suss_status` reports which commands the server ran and which of them
failed.

The server extracts again whenever a source file changes. What it
returns describes the tree as it is now, even if nobody has run
`extract` since the last edit. That matters most in the loop described
next.

## Where to run it

By the time CI runs, the code is already written, and all CI can do
is reject it. Run extract and check while the code is being written,
and keep the merge gate as a backstop.

For an agent, that means reading a file's summary before changing the
file, and asking `what reads` or `what calls` before changing
something other code depends on. Use `--json` and act on the findings
in it. A failed check with nothing parseable behind it gives whoever
has to fix it nothing to go on.

## What is safe to parse

The summary format is versioned. Pin to `v0` and check the schema
version before parsing:
[docs/reference/summary-format.md](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/summary-format.md).

The text `inspect` and `check` print for people is not a stable
interface. Use `--json` on `check`, `ask`, `inspect --diff`, and
`inspect --flow`. What each language and module system supports is in
[docs/reference/compatibility.md](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/compatibility.md).

## Calling it as a library

The CLI wraps these libraries, and you can call them from Node:

```ts
import { parseSummaries, diffSummaries } from "@suss/behavioral-ir";
import { checkAll, checkPair } from "@suss/checker";
```

`parseSummaries` validates the JSON and narrows its type. `checkAll`
pairs a whole set of summaries by boundary, and `checkPair` compares
two. `diffSummaries` reports what changed between two runs.

## When a run finds nothing

An empty report has three possible causes, and you can tell them
apart.

- Nothing paired. This exits non-zero by default and reports how many
  summaries were read. Pass `--allow-empty` when you expect an empty
  run.
- A pack read your files and recognised none of them. The pack health
  block shows this; see
  [docs/guides/fix-an-empty-run.md](https://github.com/nimbuscloud-ai/suss/blob/main/docs/guides/fix-an-empty-run.md).
- Both sides agree. This is the only case where an empty report means
  the two sides match.

## Where the rest lives

- [Docs site](https://suss.sh/)
- [What a boundary is](https://github.com/nimbuscloud-ai/suss/blob/main/docs/theory/boundary-semantics.md)
- [Write a pack](https://github.com/nimbuscloud-ai/suss/blob/main/docs/packs/write-a-pack.md) for a framework suss
  does not read yet
- [Accept a finding](https://github.com/nimbuscloud-ai/suss/blob/main/docs/guides/accept-a-finding.md)
