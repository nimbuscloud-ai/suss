---
title: Check an agent's edits as it works
description: The suss plugin for Claude Code re-reads each file the agent edits, tells the agent when an edit broke the other side of a boundary, and checks the work against the change list the agent wrote before it started.
---

# Check an agent's edits as it works

The suss plugin for Claude Code watches the edits an agent makes. Before the first edit for a request, the agent writes down the behavior changes it intends, and you can read the list. After each edit, suss reads the project again, compares both sides of every boundary, and tells the agent about any problem that edit introduced, so the agent fixes it before you read the diff. When the agent stops, suss checks what the code now does against the list: what was done, what was not, and what changed that nobody asked for. No model takes part in any of it. suss reads the code, and the plugin compares two readings and the list.

## Install it

The suss repository is a Claude Code plugin marketplace. From a terminal:

```bash
claude plugin marketplace add nimbuscloud-ai/suss --sparse .claude-plugin plugins && claude plugin install suss@suss
```

Or inside a session, `/plugin marketplace add nimbuscloud-ai/suss` and then `/plugin install suss@suss`. `--sparse` keeps Claude Code from cloning the rest of the repository. The Claude Code prompt on [Give your agent suss](/start/give-your-agent-suss) has the agent do this for you, after it installs the CLI and runs a first check.

The project needs a `suss.json`, which `npx @suss/cli init` writes. Without one the plugin reads what `init` would pick, and when nothing in the project matches a pack it says so once at session start and stays out of the way for the rest of the session.

The plugin also starts the [suss MCP server](/start/give-your-agent-suss), so the agent can ask what reads a table or calls a function before it changes one.

## Which suss it runs

The hooks run the project's own suss, the one `node_modules/.bin/suss` runs, when it is the plugin's release or newer. Otherwise they run the plugin's own copy: a `@suss/cli` installed beside the plugin, or else the release the plugin was built against, which `npx` fetches once and caches. The plugin's version is that release's version.

## What each hook does

| Hook | When | What it does | Waits up to |
|---|---|---|---|
| `SessionStart` | the session opens | Reads the whole project into the session record. This reading is the baseline everything later is compared with. It never blocks. | 90s |
| `UserPromptSubmit` | you send a message | Keeps your message in the session record, and passes on any result that came in late. When the request has no change list yet, it tells the agent where to write one. It never blocks and never reads the project. | none |
| `PostToolUse` | the agent runs Edit, Write, MultiEdit or NotebookEdit | Reads the project again (the extract cache keeps this cheap), finds the boundaries the edit changed, and compares the findings with the ones from before the edit. | 5s |
| `Stop` | the agent finishes its turn | Reads the project once more, to catch a write made from Bash, and reports what changed since the baseline, checked against the change list when there is one. | 60s |
| `SessionEnd` | the session closes | Stops any suss still running for the session and removes the summaries it kept. | 5s |

After an edit, the agent hears about a finding the edit introduced when the finding is an error, or a warning at a boundary the edit changed. The hook blocks on those, which puts the finding in front of the agent with the `.sussignore` rule that would accept it. When there is nothing to act on, the agent gets one line saying what the edit changed, and nothing at all when the edit changed no boundary. The line says each boundary the way a report prints it, with any variable that came or went: `suss: this edit changed runtime-config ACCOUNTS_REGION through getAccountService.` A function in the project comes up only with something that moved in it, since the agent already knows which functions it edited.

The agent never hears about a finding that was there before the edit. It did not cause it, and asking it to pay down the project's older findings pulls it away from the task.

Everything else the edit introduced waits for the report at the end of the turn: findings at info, warnings at boundaries the edit did not change (usually a helper edit rippling through routes), and five kinds whose other half is usually the agent's next edit: `boundaryFieldUnused`, `contractOperationUnimplemented`, `messageBusProducerOrphan`, `messageBusConsumerOrphan` and `messageBusUnused`.

When the agent stops, the hook blocks on each new error once, and the agent gets the report with the rule for each. On the next stop the same error is reported without blocking, so the loop ends within two stops. The change list blocks the same way, once per item, as [The change list](#the-change-list) shows. A stop that passes shows you the report, and the baseline moves up to the current code, so the next turn's report starts from there.

## What it looks like

An Express service and a fetch client in one project. The agent adds a 409 to `POST /orders` for a duplicate order, and the hook after that edit blocks:

```
suss: this edit changed POST /orders and introduced a finding to deal with before moving on.

[WARNING] unhandledProviderCase at POST /orders
  Provider produces status 409 but no consumer branch handles it
  provider: src/orders/create.ts::post (src/orders/create.ts:10)
  consumer: web/orders/submitOrder.ts::submitOrder (web/orders/submitOrder.ts:1)
  Fix it in the code. If the behavior is intended, add this rule to .sussignore.yml with the reason, and tell the developer:
    - kind: unhandledProviderCase
      boundary: "POST /orders"
      provider: { transitionId: "post:response:409:4b7ea21" }
      reason: <why this is intended>
  When this kind of finding is expected: https://suss.sh/reference/findings#unhandledprovidercase
```

The agent adds a 409 branch to `submitOrder`, and the next edit's hook says:

```
suss: this edit changed POST /orders and resolved unhandledProviderCase at POST /orders.
```

When the agent stops, you see:

```
suss: what changed since the session started.

2 boundaries changed: 6 outcomes.

~ serves POST /orders  src/orders/create.ts::post  (3 outcomes)
  outcomes
    + responds 409 { error }  when  !(!req.body.sku || !req.body.quantity) && orders.findOpen()
    + responds 201 { id }  otherwise
    - responds 201 { id }  otherwise

~ calls POST /orders  web/orders/submitOrder.ts::submitOrder  (3 outcomes)
  outcomes
    + throw Error  when  !(fetch().status === 201) && fetch().status === 409
    ...
```

The report's changes come from [`suss inspect --diff`](/reference/cli/inspect), and its findings from [`suss check --since`](/reference/cli/check#comparing-with-an-earlier-run).

## The change list

Before its first edit for a request, the agent writes down the behavior changes it intends, one per entry, in the words suss uses, and prints the list for you. The plugin's `suss:intent` skill tells it how, and the hook that receives your message tells it where. You ask for a cancel endpoint, and the agent writes:

```yaml
asked: "Add POST /orders/:id/cancel. Cancelling sets cancelled_at ... 404 when the order does not exist."
changes:
  - adds: POST /orders/:id/cancel
    outcomes: [200, 404]
  - adds: { writes: postgresql:orders, fields: [cancelled_at] }
    at: POST /orders/:id/cancel
  - changes: Order.status
    note: gains the value "cancelled"
```

If it got something wrong ("409 on a duplicate, not 400"), say so, and it rewrites that entry. [Intent format](/reference/intent-format#the-change-list) lists every field.

When the agent stops, suss compares what the code now does with the list, using [`suss intent check`](/reference/cli/intent#suss-intent-check). Along the way this agent also gave `POST /orders` a 409 that nobody asked for, and the stop blocks once on it:

```
suss: the code and the change list do not agree yet.
Finish each entry marked not done.
For each boundary marked not asked, revert the change, or add an entry under explained: in .suss/session/<session id>/intent.yaml that says why it stays.

What changed since the session started, against the change list:

2 done, 1 unchecked and 1 boundary changed where nobody asked.

done        + POST /orders/{id}/cancel responds 200, 404  src/orders/cancel.ts::post
            + POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]  src/orders/cancel.ts::post
unchecked   ~ Order.status gains the value "cancelled"
              suss has no boundary spelled Order.status, so it cannot check this entry.
not asked   serves POST /orders  src/orders/create.ts::post
              + responds 409 { error }  when  !(!req.body.sku || !req.body.quantity) && orders.findOpen()
```

The agent reverts the 409, or keeps it and says why under `explained:`. The next stop passes, and you read the reason in the report:

```
explained   ~ POST /orders responds 409
              why: a second open order for the same sku was charged twice, so POST /orders refuses it
            serves POST /orders  src/orders/create.ts::post
              + responds 409 { error }  when  !(!req.body.sku || !req.body.quantity) && orders.findOpen()
```

A stop blocks once on each entry that is not done and once on each boundary that changed where nobody asked, the same way it blocks once on a new error. An unchecked entry is one suss has no spelling for, such as a new value of a type, and it never blocks. When no entry in the list is done and nothing is listed as not asked, the report shows the diff as well, so you still see what changed. An entry whose quote is in none of your messages is listed as unrequested, so you can see what the agent added on its own. Once a stop passes, the list is filed away, and the next request starts with none. A session with no list gets the report from [What it looks like](#what-it-looks-like).

A list the agent wrote wrong, one that does not parse or uses a field the format does not have, blocks the stop once so the agent can fix it. When suss itself cannot run the check, because it ran out of time, crashed, or is a release without `suss intent check`, nothing blocks. You get the report of what changed, with one line saying why the list was not checked.

Two slash commands go with it. `/suss:intent` prints the current list. `/suss:keep-intent` writes the list as boundary intent documents in `intent/`, with your request as each one's purpose, so that [`suss check --intent`](/guides/check-against-intent) checks the code against them from then on.

## When a project is large

A hook that runs out of time prints nothing and lets the agent carry on. suss keeps reading in the background and writes what it found into the session record, and the next hook of any kind delivers it before its own result. A result is never lost, only late. On a small project an edit is read in about a second; on a project of a few thousand files it can take longer than the 5 seconds an edit's hook waits.

To give the hooks more time, set these in the environment Claude Code runs in, in milliseconds:

| Variable | Default | What it bounds |
|---|---|---|
| `SUSS_SUPERVISOR_START_MS` | 85000 | How long session start waits for the first reading. |
| `SUSS_SUPERVISOR_EDIT_MS` | 5000 | How long an edit's hook waits for its result. |
| `SUSS_SUPERVISOR_STOP_MS` | 45000 | How long a stop waits for the last edits to be read, before it compares. |
| `SUSS_SUPERVISOR_COMPARE_MS` | 60000 | How long each comparison a stop runs may take, the change list check among them. |

## The session record

Everything the hooks keep is in `.suss/session/<session id>/` under the project, and a `.gitignore` there keeps it out of version control. It has your messages, the queue of edits, the results the hooks delivered, every stop report as plain JSON, and each change list the agent wrote. The summaries the comparisons use are removed when the session ends; the rest stays for you to read.
