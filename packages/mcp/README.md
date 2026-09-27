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
the model to ask again about one boundary for the rest. When two
summaries files both provide one boundary, it lists them under
`collisions`, as `suss check` does. `suss_boundaries` does the same
trimming with its three lists and keeps the totals in `counts`.

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

The server keeps each command's adapter between builds. A TypeScript
build after an edit parses only the files whose text changed and keeps
the compiler's program, and a Python or Ruby build keeps every
unchanged file's tree. The disk cache that `suss extract` keeps per
file then decides which summaries to rebuild. After a build served
whole from that cache, the server loads the program anyway, so the
first edit does not pay for it.

A large TypeScript program takes gigabytes: the server raises its own
heap the way the CLI does, and lets the programs go after 30 minutes
with no build. The next build costs what a CLI run with a warm cache
costs.

## The plugin's socket

The supervisor plugin's hooks run `extract --out-dir` and
`check --since --json` after every edit. The first server started for
a repository listens on a local socket and writes its path to
`.suss/live/server.json`, and the hooks send those commands there and
get back what the CLI would have printed. A server started later for
the same repository has the first one build for it and keeps no
program of its own. When no server is up, or it does not serve a
command, the hooks run the CLI.

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
a directory it created. Pass `live: true` to listen on the plugin's
socket, which the `suss-mcp` executable does.
