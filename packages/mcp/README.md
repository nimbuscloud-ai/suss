# @suss/mcp

An MCP server over suss. A coding agent can ask what a route serves,
what reads a table, and where two sides of a boundary disagree, at the
moment it decides the question is worth asking.

The server keeps its summaries current while it runs, so an answer
describes the working tree rather than whatever was last extracted.

## Run it

```bash
npx @suss/mcp /path/to/project
```

With no path it reads the working directory. The project needs a
`suss.json`, which `suss init` writes. Without one the server starts,
says so on stderr, and every answer comes back empty.

In a host that reads a config file:

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

## The tools

| Tool | What to use it for |
|---|---|
| `suss_ask` | One question about one boundary. The seven question forms are in the tool description. |
| `suss_check` | Compare both sides of every boundary and report where they disagree. Takes a boundary to narrow to. |
| `suss_boundaries` | Every boundary in the project and which ones have both sides. |
| `suss_status` | Which commands ran, which failed, and whether the project has a `suss.json`. |

Every tool reads. None of them change a file, and all four are marked
read-only, so a host never has to ask a person before calling one.

An answer is trimmed to leave the model room to act on it. `suss_check`
over a repository of any size produces hundreds of findings, so it
shows the first twenty, counts every kind in `findingCounts`, and says
to ask again about one boundary for the rest.

`suss_ask` is the one to reach for first. Ask about a table before
changing it, ask what calls a function before changing its signature.
When it cannot answer, `needs` says which input would let it, which is
usually the thing to act on.

## Staying current

On start the server reads `suss.json`, runs the extract and contract
commands it says, and keeps the summaries in a directory of its own. It
then watches the tree, and re-runs those commands when a source file
changes, after the writes stop for 400ms.

Re-extracting is cheap after the first run. `suss extract` keeps a
per-file cache keyed on content, so an edit to one file rebuilds one
file's worth of work.

Writes under `node_modules`, `dist`, `.git`, `coverage`, `.next`,
`.turbo`, and `build` are ignored. A watcher that rebuilt on those would
never stop rebuilding.

## Mounting it yourself

`createServer` builds the server without connecting it, so a host can
put it on its own transport:

```ts
import { createServer } from "@suss/mcp";

const { server, project } = await createServer({ root: "/path/to/project" });
await server.connect(myTransport);
```

Pass `watch: false` to extract once and leave it. Pass `summaryDir` to
put the summaries somewhere you choose instead of a temporary
directory.
