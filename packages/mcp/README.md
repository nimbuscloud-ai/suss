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
| `suss_boundaries` | The boundaries, split into the ones with both sides and the ones with only one. |
| `suss_status` | Which commands ran, which failed, and whether the project has a `suss.json`. |

Every tool reads. None of them change a file, and all four are marked
read-only, so a host never has to ask a person before calling one.

An answer is trimmed to leave the model room to act on it. `suss_check`
over a repository of any size produces hundreds of findings, so it
shows the first twenty, counts every kind in `findingCounts`, and says
to ask again about one boundary for the rest. `suss_boundaries` does
the same with its three lists and keeps the totals in `counts`.

`suss_ask` is the one to reach for first. Ask about a table before
changing it, ask what calls a function before changing its signature.
When it cannot answer, `needs` says which input would let it, which is
usually the thing to act on.

## Staying current

The server connects to its host first and reads `suss.json` in the
background, so a host with a short connect timeout never waits on a
cold extract. A tool call that arrives before that first build finishes
waits for it rather than answering from nothing; `suss_status` says a
build is in flight rather than waiting.

Once the first build finishes, the server keeps the summaries in a
directory of its own and watches the tree, re-running the extract and
contract commands `suss.json` says when a source file changes, after
the writes stop for 400ms.

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

const { server, project } = createServer({ root: "/path/to/project" });
await server.connect(myTransport);
```

`createServer` does not wait on the first build, so connect right
away. Await `project.settled()` first if a caller needs the build
finished before doing anything else.

Pass `watch: false` to extract once and leave it. Pass `summaryDir` to
put the summaries somewhere you choose instead of a temporary
directory, and `close()` will leave that one alone: a directory the
server made is the only one it removes.
