# @suss/cli

Read a codebase and check what it does at every boundary, a route, a table or a queue, against the clients, specs and infrastructure on the other side. TypeScript, Python and Ruby.

This is the command line for [suss](https://github.com/nimbuscloud-ai/suss). It is deterministic and has no model in it.

## Read one service

```bash
npx @suss/cli extract -f hono -o api.json
npx @suss/cli inspect api.json
```

```
src/api.ts
├─ GET /users/{id}  (hono handler | line 5)
│      if  !findUser()
│        -> 404 { error }
│      elif  findUser().deletedAt
│        -> 410 { error }
│      else
│        -> 200 { id, name, email }
│
└─ POST /users  (hono handler | line 19)
       if  !c.req.json().name
         -> 400 "name is required"
       else
         -> 201 { id, name }
```

That is every path each handler can take, with the status and the body fields it produces. Where suss could not follow a call, it says so under the handler instead of leaving the path out.

## Install

```bash
npm install --save-dev @suss/cli
```

Every pack ships inside the CLI, so `-f hono` and `-f rails` need nothing else installed. `suss init` reads your dependencies and writes out the commands for your own project.

## The four commands

| Command | What it does |
|---|---|
| `suss init` | Reads the project and prints the commands to run, or walks you through them |
| `suss extract` | Reads code into summaries, one pack per framework, client or ORM |
| `suss contract` | Reads a declared artifact, an OpenAPI document or a SAM template, into the same summaries |
| `suss check` | Compares every provider against every consumer and reports where they disagree |

Two more read what is already on disk: `suss inspect` renders summaries, including `--diff` between two runs and `--flow` for one request hop by hop, and `suss ask` answers one question about one boundary.

Every command and flag: the [CLI reference](https://nimbuscloud-ai.github.io/suss/reference/cli).

## In a coding agent

The same summaries reach an agent over MCP, so it can ask what a route reaches or what writes a table before it edits either:

```json
{
  "mcpServers": {
    "suss": { "command": "npx", "args": ["-y", "@suss/mcp", "/path/to/project"] }
  }
}
```

The package ships its own `AGENTS.md`, at `node_modules/@suss/cli/AGENTS.md`, so an agent working from an installed copy has the same guide the repository shows.

## More

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Add suss to a project](https://nimbuscloud-ai.github.io/suss/guides/add-to-project)
- [Every pack suss ships](https://nimbuscloud-ai.github.io/suss/reference/packages)
- [What init reads before it suggests anything](./DESIGN.md)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-cli.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
