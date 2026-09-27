# The suss plugin for Claude Code

After each edit an agent makes, this plugin has suss read the project again and compare both sides of every boundary, and it tells the agent about any problem the edit introduced. Before the first edit for a request, the agent writes a change list, the behavior changes it intends. When the agent stops, suss checks the work against that list, and the developer gets a report of what changed since the session began. [Check an agent's edits as it works](https://suss.sh/guides/supervise-an-agent) is the page for people using it; this file is for people changing it.

## Install

The repository root is a plugin marketplace (`.claude-plugin/marketplace.json`), and this directory is its one plugin, named `suss`:

```bash
claude plugin marketplace add nimbuscloud-ai/suss --sparse .claude-plugin plugins && claude plugin install suss@suss
```

The Claude Code prompt on [Give your agent suss](https://suss.sh/start/give-your-agent-suss) runs the same command after it sets up the CLI, and first checks that the suss release on npm has the commands the hooks run.

To try a checkout without installing it, start Claude Code with `claude --plugin-dir plugins/supervisor`. The hooks then run the suss this repository builds, so run `npm run build` first.

## What is here

```
.claude-plugin/plugin.json   the manifest; its version is the suss release the hooks run
hooks/hooks.json             the five hooks, each `node scripts/hook.mjs <event>`
.mcp.json                    the suss MCP server, started through scripts/mcp.mjs
skills/intent/SKILL.md       how the agent writes the change list; also /suss:intent
commands/keep-intent.md      /suss:keep-intent, which turns the list into intent documents
scripts/hook.mjs             reads the event on stdin, prints the answer, always exits 0
scripts/events.mjs           what each hook does, and how long it waits
scripts/queue.mjs            the background worker's work: the baseline and each edit
scripts/worker.mjs           the worker process a hook starts
scripts/policy.mjs           which findings reach the agent after an edit, and what blocks a stop
scripts/report.mjs           the text the agent and the developer read
scripts/session.mjs          the session record on disk
scripts/suss.mjs             which suss to run, and running it
scripts/live.mjs             asking the MCP server to run a command instead of the CLI
scripts/keepIntent.mjs       what /suss:keep-intent runs: finds the session and its list, then suss intent keep
demo/play.mjs                plays a recorded session through the hooks, with no Claude Code
demo/orders409.mjs           the 409 story: a finding after an edit, and the stop report
demo/cancelOrder.mjs         the change list story: a stop that blocks on a 409 nobody asked for
demo/accountsRegion.mjs      a Lambda service with a SAM template starts reading a new environment variable
demo/listingRename.mjs       a GraphQL field renamed in a graphql-ruby type and the React query that selects it
```

The scripts are plain JavaScript modules with JSDoc types, so an installed plugin runs them with `node` and nothing to build. `tsc` checks them the same as the TypeScript in the rest of the repository (`checkJs` in `tsconfig.json`).

## How the hooks and the worker share work

A hook has a few seconds, and reading a large project takes longer. So a hook queues what it needs, starts a detached worker for the session if none is running, and waits for the worker's result only as long as its budget allows. The worker reads the project with `suss extract --out-dir`, compares it with the last reading using `suss check --since --json`, and writes the result into the session record. A hook that runs out of time prints nothing; the next hook delivers the result first.

One worker runs per session. It takes a lock file with its process id, works until the queue is empty, and exits. The `SessionEnd` hook sends SIGTERM to the worker's process group, which stops the suss it is running as well.

The rules about what to pass on live here, in `policy.mjs`. What a finding is and what changed between two readings live in suss: `findingIdentity`, `findingsSince` and `changedBoundaries` in `@suss/checker`, which `check --since` prints. Each changed boundary comes with the `label` the edit's line prints. A boundary whose label is null, such as a call from one function in the project to another, is left out of the line, and its functions are named only after a boundary that moved in them.

## The change list

The `UserPromptSubmit` hook tells the agent where to write the change list when the session has none, and the `suss:intent` skill says how. At a stop, the hook runs `suss intent check` over the list, the baseline, the current summaries and the recorded prompts. Whether an entry is done, and which changes nobody asked for, is decided in suss, so CI or another agent's integration gets the same answer from the same command. The plugin decides only what blocks: each entry not done and each boundary changed where nobody asked, once each, the way a new error blocks once. A stop that passes files the list away in `intents/`, so the next request starts with none. With no list, the stop report is the diff, as before. The diff is one `suss inspect --diff` over the baseline and current folders, since a deployable's environment is declared in one summaries file and read in another. It also goes in a report whose verdicts account for no change, as when every entry is unchecked.

The hook reads what `intent check --json` printed three ways, in `verdictsFrom`. A report with `entries` is the verdicts. A refusal under `rejected` means the list itself is wrong, and the stop blocks once so the agent can fix it. Anything else means suss did not get as far as checking: it ran out of time, crashed, or is a release without the command. That never blocks, since the agent cannot fix it. The next report that reaches the developer shows the diff instead of the verdicts, with one line saying why.

## The session record

`.suss/session/<session id>/` under the project:

| File | What it contains |
|---|---|
| `prompts.jsonl` | every message the developer sent |
| `intent.yaml` | the change list for the current request |
| `intents/` | change lists a passing stop filed away |
| `edits.jsonl` | one line per edit, and one per stop: the worker's queue |
| `progress.json` | how many lines of the queue the worker has read |
| `state/baseline/` | summaries at session start, or at the last stop that passed |
| `state/current/` | summaries after the last edit the worker read |
| `state/next/` | the reading in progress |
| `results/` | results the worker wrote that no hook has delivered yet |
| `delivered/` | results a hook has delivered |
| `stops.json` | the findings and change list items a stop has already blocked on, so it blocks on each once |
| `reports.jsonl` | every stop report |
| `worker.lock`, `worker.log` | the running worker's process id, and what it ran |
| `disabled.json` | why the session is not being checked, when suss could not read the project |

`SessionEnd` removes `state/`, which is most of the record's size, and leaves the rest.

Beside the session folders, `.suss/session/current.json` says which session a slash command acts on. `SessionStart` and each prompt write it, so with two sessions open in one project it points at the one the developer last typed in, and `SessionEnd` removes it when it still points at that session. `/suss:keep-intent` reads it when the command is not given the session id. The Claude Code docs say `${CLAUDE_SESSION_ID}` is filled in for a skill, and do not say so for a command.

## Which suss the hooks run

`scripts/suss.mjs` looks for `@suss/cli` in `node_modules` from the project directory upward, and uses it when its version is at least the plugin's. Otherwise it looks the same way from the plugin's directory, and then falls back to `npx --yes --package=@suss/cli@<plugin version> suss`. The MCP server is found the same way, as `@suss/mcp`.

Before starting the CLI, `runSuss` asks the MCP server. The server that keeps the project's program writes its socket's path to `.suss/live/server.json`, and it runs `extract --out-dir` and `check --since --json` itself, returning what the CLI would have printed. It keeps the program between edits, so a read after an edit parses only the files that changed and starts no process. When no server is up, or it does not serve the command, the CLI runs as before.

The plugin's version in `plugin.json` moves with every suss release, because `scripts/preparePublish.mjs` sets it when `npm run bump` runs.

## Tests

```bash
npx turbo test --filter=@suss/supervisor-plugin
node plugins/supervisor/demo/orders409.mjs
node plugins/supervisor/demo/cancelOrder.mjs
node plugins/supervisor/demo/accountsRegion.mjs
node plugins/supervisor/demo/listingRename.mjs
```

`test/hooks.test.ts` feeds each hook the JSON Claude Code sends and checks what it prints and its exit code. Most of those tests install a stand-in suss in the test project (`test/fakeSuss.ts`), so a test can make suss report an error the fixtures never produce. `test/demo.test.ts` plays the stories with the suss this repository builds: the first two over `fixtures/supervisor-orders`, the environment variable story over `fixtures/supervisor-accounts`, and the rename story over `fixtures/supervisor-listings`. `test/skill.test.ts` checks that the skill's example change lists are ones suss accepts.
