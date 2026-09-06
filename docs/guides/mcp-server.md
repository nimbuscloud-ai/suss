---
title: Set up the MCP server
description: Give a coding agent a way to ask what a route reaches, what writes a table and what calls a function, from the working tree as it is now.
---

# Set up the MCP server

Add this to the host's MCP config and point it at the project:

```json
{
  "mcpServers": {
    "suss": { "command": "npx", "args": ["-y", "@suss/mcp", "/path/to/project"] }
  }
}
```

For Claude Code that file is `.mcp.json` at the repository root. Cursor reads `.cursor/mcp.json`, and Claude Desktop reads `claude_desktop_config.json`. Each of them takes the block above unchanged.

The project needs a `suss.json`, which says which packs read the code and where the contracts are. `npx @suss/cli init` writes it, and asks before it installs anything. Without one the server starts, says so on stderr, and every answer comes back empty.

## What the agent can ask

The server exposes four tools. `suss_ask` is the one an agent reaches for most, and it takes the same questions as `suss ask` from the shell:

```
what writes postgresql:Article
what reads postgresql:Article
what does GET /articles/:slug reach
what calls src/app/routes/article/article.service.ts
what reaches src/app/routes/article/article.service.ts
what does @suss/checker provide
why does src/editions/dao.ts reach aws.dynamodb:editions
```

Each answer gives file and line for every unit involved, followed through as many hops as the calls take:

```
6 units write postgresql:Article:
  createArticle (src/app/routes/article/article.service.ts:162) through prisma.article.create
  updateArticle (src/app/routes/article/article.service.ts:289) through prisma.article.update
  ...
```

A call suss could not follow ends the answer with a line saying so, such as `suss could not follow next, so a writer could be hiding behind it`. An agent that reads that line knows the answer is complete as far as suss could see, and where it stopped.

The other three tools:

| Tool | What it does |
|---|---|
| `suss_check` | Compares both sides of every boundary and reports where they disagree. Takes a boundary to narrow to. |
| `suss_boundaries` | Lists the boundaries, split into the ones with both sides and the ones with only one. |
| `suss_status` | Says which commands ran, which failed, and whether the project has a `suss.json`. |

All four are read-only, so a host never has to ask a person before calling one.

## Staying current

The server runs one extract when it starts and watches the tree after that. When a source file changes it re-runs the affected part, so an answer describes the working tree rather than whatever was last extracted. An edit to one file rebuilds one file's worth of work.

## Telling the agent to use it

A tool the agent never calls does nothing. A line in the project's agent instructions (`CLAUDE.md`, `.cursorrules`, or the equivalent) is enough:

```
Before changing a table, a route or a function's signature, ask the suss MCP
server what reads, writes or calls it, and check the result before editing.
```

The [MCP package README](https://github.com/nimbuscloud-ai/suss/tree/main/packages/mcp) says how to mount the server on a transport of your own.
