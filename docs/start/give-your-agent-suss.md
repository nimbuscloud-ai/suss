---
title: Give your agent suss
description: A coding agent asks what a route returns, what writes a table and what calls a function, from the working tree as it is now.
---

# Give your agent suss

Add this to the host's MCP config and point it at the project:

```json
{
  "mcpServers": {
    "suss": {
      "command": "npx",
      "args": ["-y", "@suss/mcp", "/path/to/project"]
    }
  }
}
```

Claude Code reads `.mcp.json` at the repository root and Cursor reads
`.cursor/mcp.json`, and both take that block unchanged. If you drop the
path argument, the server reads whichever directory the host started it
in.

In Claude Code, [the suss plugin](/guides/supervise-an-agent) starts this
server for you, and also checks each edit the agent makes.

The server reads `suss.json`, which `npx @suss/cli init` writes. The file
lists which packs to read the code with and where your contracts are. If
you do not have one, the server picks the packs `init` would have picked
and prints a note on stderr. When nothing in the project matches a pack,
every answer comes back empty, and `suss_status` explains why.

## The tools

`suss_ask` takes one question about one boundary and works the answer out
from the code as it is right now. The `question` has to be one of ten
forms, and an optional `limit` sets how many results come back before the
rest are counted and left out. Your agent calls this one before it
changes a route, a table or a function signature:

```
what can I project from <boundary>   the statuses a route returns, the fields a store serves
what reads <boundary>                every unit that reads it, with the file, line and call
what writes <boundary>               the same, for writes
what invokes <boundary>              the same, for invocations of a function or a queue
what calls <unit>                    every unit whose calls resolve to this one
what does <unit> reach               every boundary a file or a summary goes through
what reaches <target>                every boundary that ends up going through the target
what does <package or unit> provide  every boundary it provides, one per line
why does <unit> reach <boundary>     the call chain, with each hop proved from source
why does <name> at <file>:<line> resolve to <target>
```

`suss_check` compares both sides of every boundary and reports where the
two disagree, such as a caller reading a field the provider never returns
or a status no caller handles. An agent runs it after writing code that
crosses a boundary. Pass a `boundary` to narrow a whole-project report
down to one thing.

`suss_boundaries` lists the boundaries in three groups: the ones with
both sides present, the ones only something serves, and the ones only
something calls. An agent uses it to get oriented in an unfamiliar
project, and to tell "the two sides agreed" apart from "nothing was
compared" after `suss_check` comes back with no findings.

`suss_stub_draft` handles a `package` your project uses that suss cannot
read into, such as a compiled binding or a private wrapper. It drafts a
stub for that package from your own call sites and leaves the semantic
blanks for you or the agent to fill in from the package's source. [Teach
suss a dependency](/guides/teach-a-dependency) covers the file it writes.

`suss_intent_outcomes` lists the outcomes your boundary intent documents
declare. Each one comes back as `<intent-name>.<outcome-id>`, the string
a PRD scenario puts in its `link`. An agent calls it before it writes or
edits a `link`. The intent name and the outcome id are both declared in
a boundary intent document, so a link made up from the feature
description is a guess. A link to an outcome nothing declares comes
back from `suss_check` as `danglingScenarioLink`. Pass an `intentDir`
when the documents are somewhere other than `intent/`.

`suss_status` shows which extract and contract commands ran, which of
them failed, and whether they came from a `suss.json` or the server
picked them itself. Call it when an answer looks thinner than you would
expect from the code.

Every tool is marked read-only, and none of them changes anything in
your tree, so the host does not have to ask you before it calls one.

## What an answer looks like

An agent about to edit a route asks what it returns today:

```
suss_ask { "question": "what can I project from GET /orders/{reference}" }
```

```json
{
  "question": "what can I project from GET /orders/{reference}",
  "shape": "declares",
  "subject": "GET /orders/{reference}",
  "found": true,
  "headline": "GET /orders/{reference} declares 2 things you can ask it for:",
  "items": [
    {
      "what": "response",
      "name": "404",
      "detail": "error",
      "from": "orders-api::src/api.ts::get"
    },
    { "what": "response", "name": "200", "from": "orders-api::src/api.ts::get" }
  ],
  "needs": [],
  "caveats": []
}
```

Read `found` first. When it is false, `needs` lists the input that would
let suss answer, and that is usually what to go and fix. `caveats`
contains one `warning:` line for every call suss could not follow, with
the file and line of the unit it was in. An agent uses those lines to
tell a complete answer from one that stopped partway.

## Staying current

The server runs one extract when it starts, then watches the tree. When a
source file changes it re-runs the part of the extract that file affects,
so every answer describes your working tree as it is now. Editing one
file only costs one file's worth of work.

## Telling the agent to use it

You have to tell the agent to use it. One line in your project's agent
instructions (`CLAUDE.md`, `.cursorrules` or the equivalent) is enough:

```
Before changing a table, a route or a function's signature, ask the suss MCP
server what reads, writes or calls it, and check the result before editing.
```

The [MCP package README](https://github.com/nimbuscloud-ai/suss/tree/main/packages/mcp)
covers how to mount the server on a transport of your own.
