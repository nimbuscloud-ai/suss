# The suss plugin for Claude Code

After each edit an agent makes, this plugin has suss read the project again and compare both sides of every boundary, and it tells the agent about any problem the edit introduced. When the agent stops, the developer gets a report of what changed since the session began. [Check an agent's edits as it works](https://suss.sh/guides/supervise-an-agent) is the page for people using it; this file is for people changing it.

## Install

The repository root is a plugin marketplace (`.claude-plugin/marketplace.json`), and this directory is its one plugin, named `suss`:

```bash
claude plugin marketplace add nimbuscloud-ai/suss --sparse .claude-plugin plugins && claude plugin install suss@suss
```

To try a checkout without installing it, start Claude Code with `claude --plugin-dir plugins/supervisor`. The hooks then run the suss this repository builds, so run `npm run build` first.

## What is here

```
.claude-plugin/plugin.json   the manifest; its version is the suss release the hooks run
hooks/hooks.json             the five hooks, each `node scripts/hook.mjs <event>`
.mcp.json                    the suss MCP server, started through scripts/mcp.mjs
scripts/hook.mjs             reads the event on stdin, prints the answer, always exits 0
scripts/events.mjs           what each hook does, and how long it waits
scripts/queue.mjs            the background worker's work: the baseline and each edit
scripts/worker.mjs           the worker process a hook starts
scripts/policy.mjs           which findings reach the agent after an edit, and which wait
scripts/report.mjs           the text the agent and the developer read
scripts/session.mjs          the session record on disk
scripts/suss.mjs             which suss to run, and running it
demo/orders409.mjs           the 409 story played through the hooks, with no Claude Code
```

The scripts are plain JavaScript modules with JSDoc types, so an installed plugin runs them with `node` and nothing to build. `tsc` checks them the same as the TypeScript in the rest of the repository (`checkJs` in `tsconfig.json`).

## How the hooks and the worker share work

A hook has a few seconds, and reading a large project takes longer. So a hook queues what it needs, starts a detached worker for the session if none is running, and waits for the worker's result only as long as its budget allows. The worker reads the project with `suss extract --out-dir`, compares it with the last reading using `suss check --since --json`, and writes the result into the session record. A hook that runs out of time prints nothing; the next hook delivers the result first.

One worker runs per session. It takes a lock file with its process id, works until the queue is empty, and exits. The `SessionEnd` hook sends SIGTERM to the worker's process group, which stops the suss it is running as well.

The rules about what to pass on live here, in `policy.mjs`. What a finding is and what changed between two readings live in suss: `findingIdentity`, `findingsSince` and `changedBoundaries` in `@suss/checker`, which `check --since` prints.

## The session record

`.suss/session/<session id>/` under the project:

| File | What it contains |
|---|---|
| `prompts.jsonl` | every message the developer sent |
| `edits.jsonl` | one line per edit, and one per stop: the worker's queue |
| `progress.json` | how many lines of the queue the worker has read |
| `state/baseline/` | summaries at session start, or at the last stop that passed |
| `state/current/` | summaries after the last edit the worker read |
| `state/next/` | the reading in progress |
| `results/` | results the worker wrote that no hook has delivered yet |
| `delivered/` | results a hook has delivered |
| `stops.json` | the findings a stop has already blocked on, so it blocks on each once |
| `reports.jsonl` | every stop report |
| `worker.lock`, `worker.log` | the running worker's process id, and what it ran |
| `disabled.json` | why the session is not being checked, when suss could not read the project |

`SessionEnd` removes `state/`, which is most of the record's size, and leaves the rest.

## Which suss the hooks run

`scripts/suss.mjs` looks for `@suss/cli` in `node_modules` from the project directory upward, and uses it when its version is at least the plugin's. Otherwise it looks the same way from the plugin's directory, and then falls back to `npx --yes --package=@suss/cli@<plugin version> suss`. The MCP server is found the same way, as `@suss/mcp`.

The plugin's version in `plugin.json` moves with every suss release, because `scripts/preparePublish.mjs` sets it when `npm run bump` runs.

## Tests

```bash
npx turbo test --filter=@suss/supervisor-plugin
node plugins/supervisor/demo/orders409.mjs
```

`test/hooks.test.ts` feeds each hook the JSON Claude Code sends and checks what it prints and its exit code. Most of those tests install a stand-in suss in the test project (`test/fakeSuss.ts`), so a test can make suss report an error the fixtures never produce. `test/demo.test.ts` plays the 409 story over `fixtures/supervisor-orders` with the suss this repository builds.
