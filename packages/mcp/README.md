# @suss/mcp

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

An MCP server over suss. A coding agent can ask what a route serves,
what reads a table, and where two sides of a boundary disagree, at the
moment it needs to know.

The server keeps its summaries current while it runs, so an answer
describes the working tree as it is now. It does not depend on when
somebody last ran an extract.

## Run it

```bash
npx @suss/mcp /path/to/project
```

With no path it reads the working directory. The project needs a
`suss.json`, which `suss init` writes. Without one the server starts,
prints a warning on stderr, and every answer comes back empty.

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
| `suss_ask` | One question about one boundary. The question forms are in the tool description. |
| `suss_check` | Compare both sides of every boundary and report where they disagree. Takes a boundary to narrow to. |
| `suss_boundaries` | The boundaries, split into the ones with both sides and the ones with only one. |
| `suss_status` | Which commands ran, which failed, and whether the project has a `suss.json`. |

Every tool only reads. None of them change a file, and each is marked
read-only, so a host never has to ask a person before calling one.

Each answer is trimmed to leave the model room to act on it. On a
repository of any size, `suss_check` produces hundreds of findings. It
shows the first twenty, counts every kind in `findingCounts`, and tells
the model to ask again about one boundary for the rest. `suss_boundaries`
does the same with its three lists and keeps the totals in `counts`.

Reach for `suss_ask` first. Ask about a table before changing it, and
ask what calls a function before changing its signature. When it cannot
answer, `needs` lists the input that would let it, and that is usually
the thing to act on.

## Staying current

The server connects to its host first and reads `suss.json` in the
background, so a host with a short connect timeout never waits on a
cold extract. A tool call that arrives before that first build finishes
waits for the build instead of answering from nothing. `suss_status`
does not wait, and reports that a build is in progress.

Once the first build finishes, the server keeps the summaries in its
own directory and watches the tree. When a source file changes, it waits
until writes have stopped for 400ms, then re-runs the extract and
contract commands listed in `suss.json`.

Re-extracting is cheap after the first run. `suss extract` keeps a
per-file cache keyed on content, so an edit to one file rebuilds only
that file's share of the work.

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

`createServer` does not wait on the first build, so you can connect
right away. Await `project.settled()` first if a caller needs the build
finished before doing anything else.

Pass `watch: false` to extract once and stop there. Pass `summaryDir` to
put the summaries in a directory you choose instead of a temporary one.
`close()` leaves that directory alone, because the server only removes
a directory it created.
