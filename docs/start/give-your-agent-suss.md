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

Claude Code reads `.mcp.json` at the repository root. Cursor reads
`.cursor/mcp.json`. Both take that block unchanged, and dropping the path
argument makes the server read the directory the host started it in.

The server reads `suss.json`, which says which packs to read the code
with and where the contracts are. `npx @suss/cli init` writes it. Without
one the server picks the packs `init` would and says on stderr that it
did. When nothing in the project matches a pack, every answer comes back
empty and `suss_status` says why.

## The five tools

`suss_ask` takes one question about one boundary and works the answer out
from the code as it is right now. The `question` has to be one of ten
forms, and an optional `limit` sets how many results come back before the
rest are counted and left out. This is the one an agent reaches for
before it changes a route, a table or a function signature:

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

`suss_check` compares both sides of every boundary and reports where they
disagree: a caller reading a field the provider never returns, or a
status no caller handles. An agent runs it after writing
code that crosses a boundary. Pass a `boundary` to narrow a whole-project
report down to one thing.

`suss_boundaries` lists the boundaries in three groups: the ones with
both sides present, the ones only something serves, and the ones only
something calls. An agent uses it to get oriented in an unfamiliar
project, and to tell "the two sides agreed" apart from "nothing was
compared" after `suss_check` comes back with no findings.

`suss_stub_draft` takes a `package` the project uses but suss cannot read
into, a compiled binding or a private wrapper, and drafts a stub for it
from the project's own call sites. The semantic blanks are for a person
or the agent to fill from the package's source. [Teach suss a
dependency](/guides/teach-a-dependency) covers the file it writes.

`suss_status` says which extract and contract commands ran, which failed,
and whether a `suss.json` chose them or the server picked them itself.
It is the thing to call when an answer looks thinner than the code
suggests it should be.

All five are marked read-only and every one of them leaves the tree
alone, so a host never has to ask a person before calling one.

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

Read `found` first. When it is false, `needs` says which input would let
suss answer, and that is usually the thing to act on. `caveats` is where
a call suss could not follow shows up, one `warning:` line per unit with
its file and line, so an agent can tell a complete answer from one that
stops partway.

## Staying current

The server runs one extract when it starts and watches the tree after
that. When a source file changes it re-runs the affected part, so an
answer describes the working tree rather than whatever was last
extracted. An edit to one file rebuilds one file's worth of work.

## Telling the agent to use it

The agent has to be told to reach for it. A line in the project's agent
instructions (`CLAUDE.md`, `.cursorrules`, or the equivalent) is enough:

```
Before changing a table, a route or a function's signature, ask the suss MCP
server what reads, writes or calls it, and check the result before editing.
```

The [MCP package README](https://github.com/nimbuscloud-ai/suss/tree/main/packages/mcp)
says how to mount the server on a transport of your own.
