# A suss plugin that supervises a coding agent

Steps 1 to 3 of the plan at the end are in the repository, in `plugins/supervisor`, `suss check --since`, `suss extract --out-dir` and `suss intent`. The later steps are the plan.

## What the developer gets

A developer asks the agent for a cancel endpoint. Before the first edit, the agent restates the request in suss's terms: a short list of the behavior changes it intends, which the developer can check at a glance. While the agent edits, suss re-reads the project, compares both sides of every boundary the edit changed, and hands any new finding back to the agent, so the agent fixes it before the developer reads the diff. When the agent tries to finish, suss compares what the code now does with that list and reports what was done, what was not, and what changed that nobody asked for. The agent cannot finish with an unrequested change it has not explained.

No model takes part in any of that. suss reads the code and the diff between two extractions; the agent's one contribution is the change list.

### From install to the first finding

The project is an Express service with a fetch client in one repository, and it has a `suss.json` from `suss init`. The repository root of suss is a plugin marketplace, and the plugin in it is named `suss`:

```
claude plugin marketplace add nimbuscloud-ai/suss --sparse .claude-plugin plugins
claude plugin install suss@suss      # hooks, the intent skill and the MCP server, one install
```

The developer asks: "Add POST /orders/:id/cancel. Cancelling sets cancelled_at and puts the order in the cancelled status. Return 404 when the order does not exist."

The hook that receives the message tells the agent where the change list goes. The agent writes it through the plugin's skill and shows it:

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

The agent writes the handler. Along the way it also changes `POST /orders` so that a duplicate order gets a 409. After that edit, the hook reads the project again, checks every boundary against the state before the edit, and blocks with this:

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

The agent adds the branch to the client. When it stops, the Stop hook compares the diff since the session began with the change list:

```
2 done, 1 unchecked and 1 boundary changed where nobody asked.

done        + POST /orders/{id}/cancel responds 200, 404  src/orders/cancel.ts::post
            + POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]  src/orders/cancel.ts::post
unchecked   ~ Order.status gains the value "cancelled"
              suss has no boundary spelled Order.status, so it cannot check this entry.
not asked   serves POST /orders  src/orders/create.ts::post
              + responds 409 { error }  when  !(!req.body.sku || !req.body.quantity) && orders.findOpen()
```

Nobody asked for the 409. The hook blocks the stop once and says so. The agent reverts it, or writes one entry under `explained:` saying why it stays, and the next stop passes with that reason in the report the developer reads. `node plugins/supervisor/demo/cancelOrder.mjs` plays this session through the hooks.

## The hooks

Each hook is a `command` hook that runs `node scripts/hook.mjs <event>`. A command hook is the kind the Claude Code docs say can block. The hooks share one session record, `.suss/session/<session id>/` under the project, and a detached worker per session does the reading.

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" session-start", "timeout": 90 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" prompt", "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit",
                           "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" after-edit", "timeout": 8 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" stop", "timeout": 60 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" session-end", "timeout": 5 }] }]
  }
}
```

A hook has a few seconds, and reading a large project takes longer. So a hook queues what it needs, starts the session's worker if none is running, and waits for the worker's result only as long as its budget allows. The worker reads the project with `suss extract --out-dir`, compares the reading with the one before it using `suss check --since --json`, and writes the result into the session record. A hook that runs out of time prints nothing, and the next hook of any kind delivers the result first. A result is never lost, only late.

The hooks run the project's own suss when it is the plugin's release or newer, then a copy installed beside the plugin, then that release through `npx`. The plugin's version moves with every suss release.

**SessionStart** takes the baseline, the summaries as they are before any edit, and waits up to 85s for it so the baseline predates the first edit. On a warm cache that is the 2.5s unchanged run; on a cold cache it is the cold run, once per project (40s on twenty-server). It never blocks. When suss cannot read the project at all, the session switches itself off and says so once.

**UserPromptSubmit** appends the prompt to `prompts.jsonl` and delivers any result that came in late. When the session has no change list, it returns `additionalContext` telling the agent to write one through the skill before editing, and where. No extraction, never blocks.

**PostToolUse** on Edit, Write, MultiEdit and NotebookEdit queues the edit and waits up to 5s for the worker's answer: what the edit changed, and the findings it introduced. It returns `decision: "block"` with a `reason` for a new error, or a new warning at a boundary the edit changed, and `additionalContext` with a one-line delta otherwise. An edit to the change list itself queues nothing, since it changes no code.

The budget is 5s because the hook runs before the agent's next step and a developer watching feels each wait. Two seconds passes unnoticed, five is felt, ten gets the hook switched off. A partial run on a fixture is under a second today. On twenty-server it is 24s, and the fast re-extract below is what brings it inside the budget.

**Stop** waits up to 45s for the worker to read the last edits, reading the project once more to catch a write made from Bash, which fires no edit hook. It then compares with the baseline. It blocks when the report has an entry not done, a boundary changed where nobody asked and no `explained` entry keeps it, a change list that does not parse, or a new error since the baseline. When suss cannot run the check at all (a timeout, a crash, a release without the command), it does not block, and the report that passes shows the diff with a line saying why the list went unchecked. Each item blocks at most once: the session record keeps what a stop blocked on, and Claude Code's own cap of eight continuations is the backstop. The report is the `reason` when blocking. A report that passes goes to the developer as `systemMessage`, because Claude Code continues the turn when a Stop hook returns `additionalContext`. After a stop that passes, the baseline moves to the current state and the change list is filed away in `intents/`, so the next request in the same session starts over.

**SessionEnd** stops the session's worker and the suss it is running, and removes the summaries from the record. The prompts, the change lists and the reports stay.

```
plugins/supervisor/
  .claude-plugin/plugin.json
  .mcp.json                 # the suss MCP server
  hooks/hooks.json
  skills/intent/SKILL.md    # how the agent writes the change list; also /suss:intent
  commands/keep-intent.md   # /suss:keep-intent
  scripts/hook.mjs          # event in, answer out, always exits 0
  scripts/events.mjs        # what each hook does, and how long it waits
  scripts/worker.mjs        # the per-session worker
  scripts/policy.mjs        # what reaches the agent after an edit, and what blocks a stop
  scripts/report.mjs        # the text the agent and the developer read
  demo/                     # recorded sessions played through the hooks
```

## The intent

The format is a change list: one entry per behavior change the agent intends. Each entry has one verb (`adds`, `removes`, `changes`) and a subject spelled the way `suss ask` and the intent documents spell it: a boundary such as `POST /orders/:id/cancel`, or an effect clause such as `{ writes: postgresql:orders, fields: [cancelled_at] }`. A boundary entry lists the `outcomes` it should have: statuses, or `returns`, `throws` and `{ throws: <error type> }`. `at` says which boundary an effect happens at, and an effect entry with no `at` counts at any boundary. `asked` quotes the developer, on the list or on one entry. `note` says in words what the change is, for a subject suss has no spelling for. `explained` lists the changes the agent keeps without being asked, each an entry with a `why`.

```yaml
explained:
  - changes: POST /orders
    outcomes: [409]
    why: a second open order for the same sku was charged twice, so POST /orders refuses it
```

The vocabulary is the boundary intent document's, taken line by line: the boundary spelling, the verbs `reads`, `writes` and `invokes` with `fields` and `by`, the status and ending outcomes. The change list adds the verb per entry and drops `when`, `purpose` and `audience`, which an agent cannot know before it has written the code. Each `adds` and `changes` entry compiles to transitions of a `kind: boundary` document: one transition per outcome a boundary entry lists, since a transition ends one way, and one for an effect entry, with the effect as its `results` line. `removes` has no counterpart in that format. Intent documents are open specifications, where extra behavior is info, so "no longer returns 410" can only be checked against the diff, which is where the Stop check reads everything else from as well. `ChangeListSchema` in `@suss/intent-ir` is the format, and `loadChangeListFile` in `@suss/contract-intent` reads one.

The agent writes the list to `.suss/session/<session id>/intent.yaml`, through the skill, on the first turn after a request that will change code. The skill says: spell boundaries as suss spells them, and ask `suss_boundaries` or `suss ask "what does <file> reach"` when unsure; one change per entry; quote the request in `asked`; do not predict conditions. The developer sees the list because the skill has the agent print it, corrects it in words ("409 on a duplicate, not 400"), and the agent rewrites the entry. The skill is also `/suss:intent`, which prints the current list.

The end check is `suss intent check`, and `checkIntent` in `@suss/cli` for a program. It reads the same comparison `inspect --diff` prints, `behaviorDiff`, and what each served boundary reaches before and after. Each entry is matched like this:

| entry | matches when |
|-|-|
| `adds: <boundary>` with `outcomes` | the diff lists the boundary as added or changed, and each listed outcome is the ending of one of its transitions now |
| `changes: <boundary>` | the diff lists the boundary as changed, and each listed outcome is the ending of a transition that is new or changed |
| `removes: <boundary>` | with no outcomes, the diff lists the boundary as removed; with outcomes, each was an ending of the boundary before and is not now |
| `adds: {writes: S, fields: F}` at `B` | B now reaches a write of S that states every field in F, and did not before |
| `removes: <effect>` at `B` | B reached the effect before and does not now |
| `changes: <effect>` at `B` | the diff lists B as changed, and B reaches the effect now |

A boundary resolves through `namesBoundaryExactly` and an effect through the intent checker's `effectMatches`, the matchers `suss ask` and `check --intent` go through, and "reaches" follows the calls a request makes. Done is a matched entry. Not done is an unmatched one. Unchecked is an entry whose subject is no boundary on either side and is not spelled like one (a route, or `system:name`). The third line of the example is one: neither the intent vocabulary nor the Prisma reader spells enum members yet. An unchecked entry is reported and never counted as not done, so the agent does not chase it.

Not asked is a line of the diff at a boundary no entry mentions, through its subject or its `at`, or an extra outcome from the handler's own body at a boundary a boundary entry mentions and whose outcomes it does not list. At a mentioned boundary, every effect is asked for, so is every line of a client that calls it, and so is an outcome the handler had before as well whose condition moved because of a new branch beside it. An `explained` entry covers lines by the same rules. What is left is reported one item per boundary.

Two rules keep the not-asked list readable. An outcome a wrapper contributes (`wrappers.from`) is listed once under the wrapper, as the diff renderer already does, and is info. A helper change that alters what dozens of routes reach is listed at each route: the text diff and `--diff --json` both put the change under every route that reaches it, with the helper in `through`, and neither groups it under the helper. So an effect entry or an `explained` entry with no `at` covers that effect at every route at once.

When the developer approves more work mid-task ("also write an audit row"), the agent appends an entry whose `asked` quotes that message. The Stop check confirms every `asked` quote appears in the recorded prompts, ignoring case, spacing and the kind of quote mark, with `...` matching any stretch. An entry the agent added on its own is flagged as declared without a request rather than counted as done. The developer reads that one line, not the whole list.

`/suss:keep-intent` runs `suss intent keep` once the task passes. It writes one `kind: boundary` document per boundary the `adds` and `changes` entries mention, into `intent/` as `source: author`, with the request as `purpose`, the audience the developer gives, and each `when` taken from the code as it is now, the way `suss infer intent` writes one. The Claude Code docs promise `${CLAUDE_SESSION_ID}` in a skill and not in a command, so the hooks keep `.suss/session/current.json` pointing at the session the developer last typed in, and the command falls back to it.

## Noise

An agent acts on everything it is told, so the per-edit hook passes on less than CI does.

It passes on findings that are new since the pre-edit state and are errors, or warnings whose boundary the edit changed. New is decided by finding identity (`findingIdentity` in `@suss/checker`): kind, boundary key, both sides' summary and transition id, and the description with whitespace normalized. A transition id is built from the function name, the terminal kind, the status and a hash of the guard texts, so an edit elsewhere in the file leaves it alone. A warning the edit introduced at the boundary it changed is precise even where the kind is imprecise over a whole corpus. `unhandledProviderCase` is under half right in CI because the fall-through is often intended; it is right when the provider gained the status a moment ago.

It saves for Stop: everything at info (`lowConfidence`, `unsupportedSemantics`, `runtimeScopeUnknown`); new warnings at boundaries the edit did not change, which is a helper edit rippling through routes; the kinds whose other half is usually the agent's next edit, `boundaryFieldUnused`, `contractOperationUnimplemented`, `messageBusProducerOrphan`, `messageBusConsumerOrphan` and `messageBusUnused`; and the run findings, with each kind reported once per session.

It never passes on a finding that was there before the edit. The agent did not cause it, and asking the agent to pay down the project's existing debt is how it wanders off the task.

A finding arrives with the `.sussignore` rule that accepts it, which `check --since --json` prints, and a link to its entry in the findings catalog. The agent fixes it, or adds the rule with a reason and tells the developer. The Stop hook blocks on a finding once; on the next stop with the same finding present it reports instead. Every loop ends within two stops.

## Fast re-extract

A one-file edit on twenty-server costs 24s today: 6.4s rebuilding the program, 3.4s loading import graphs, 3.0s warming export chains, 10.9s in the closure rescanning every function reachable from the edited file's units, and the rest in whole-run passes and I/O. Mastodon re-runs cold on any edit, 17.8s. The check is cheap by comparison: `check --dir` over twenty-server's 7,014 summaries takes 1.3s from the CLI, 0.4s of it parsing 100MB of JSON, and `inspect --diff` over the same set 1.9s. In a process that keeps the summaries in memory both are under a second.

### TypeScript: reuse the closure per function

The closure already records, per scanned function key, the other files its scan read (`filesByKey`), plus the `calls` edges, targets and stops per key. The cache folds that into the file's dependencies, and the closure rescans every key on the next partial run anyway. Store it per key in the manifest instead: the key, the file's content hash, the files read, the `calls` edges and the scan results. On a partial run, when the frontier reaches a key whose file and recorded files are unchanged, the closure takes the recorded edges and results and the reused summary. It scans only keys in changed files, whose offset keys are new, and keys whose recorded files moved. The correctness bar is the one the cache already trusts: recorded dependencies decide validity, and the output has to stay byte-identical to a cold run. This works in the CLI with no live process and takes the 10.9s down to the cost of scanning the edited file's own functions.

### TypeScript: keep the program alive

The MCP server re-runs `extract()` on every change, and each run builds a new adapter and a new ts-morph `Project`. The adapter already accepts a caller-supplied `Project`, and `reparse.test.ts` runs two extractions over one. So the server keeps one adapter per `suss.json` entry and calls it again on each change, passing the changed paths. The hooks then talk to that server over a local socket instead of running the CLI, and a socket client is what lets the same plugin serve an agent that has hooks and no MCP. What lives in the process, and how each part is invalidated:

- The ts-morph `Project`, with the compiler program and the checker. On a change, `refreshFromFileSystem()` on the changed files and add or remove for created and deleted ones. ts-morph rebuilds the program lazily and reuses every unchanged file's tree; the checker is rebuilt. Expected under 2s on twenty-server against the 6.4s cold build, to be measured.
- The per-project maps, `specifiersByProject`, `depthsByProject` and the `ModuleResolutionCache`. Drop the changed files' entries and their importers', which needs a reverse import index built once from the forward one. `warmedFiles` is keyed on the compiler's source file object and expires on its own when a file is re-parsed.
- The store's per-file facts. Extraction re-emits facts every run. Keep each file's tuples keyed by content hash and rebuild the `Database` from cached tuples plus the changed files' fresh ones. Answers are not kept, because the engine cannot take a derived tuple back; a rebuild from the 328k tuples the survey counted on twenty-server costs a fraction of a second at the measured rates.
- The manifest: summaries, roots, owners, deps and the per-key closure records above, in memory, written to disk as today so the CLI shares it.
- The baseline and the last-reported findings per session, for the diffs the hooks ask for.

Two things to settle in the adapter first. The disk cache switches itself off for a caller-supplied `Project` because in-memory paths would never stat; the server passes on-disk paths, so that rule needs a knob. And on a whole hit the TypeScript path returns the stored summaries without `composeWrappers`, while a partial run returns composed ones, so a hook diff across the two would show wrapper outcomes appearing and vanishing.

The cost is a resident program. twenty-server peaks at 3.7 GB without the heap override, and one process per session means one program per session.

### Python and Ruby: attribute questions to files through demand

Both adapters emit facts per file (`factsForFile` exists in both) into one database, then discovery asks the store per unit, and those questions are most of the run: on mastodon, `discover` is 13.6s of 17.7s. A per-file cache needs to know which files each unit's answers depended on. The demand rewrite already computes that. Every question seeds `wanted(x)` and the rules pass demand down, so after `evaluate` the asking relations (`wanted`, `wantedOrigin`, `wantedUnder` and the rest of `ASKING_RELATIONS`) contain every key the derivation asked about, and `askResolution` clears them right after. Read them before the clear. Every key starts with its file path (`nodeId` and `nameKey` both do), so the demanded keys map to a file set, a superset of what the answer used and never a subset. Record that set on the unit's root as `deps`, and the extractor's existing attribution (roots, deps, owners, `plan`) serves both adapters with no change.

Demand misses one case: an answer that depends on a fact being absent. Ruby binds a constant only when exactly one file defines it, so a new definition elsewhere changes an answer whose derivation never touched the new file. So the root also records the demanded keys themselves, and a changed file whose fresh facts mention a demanded key invalidates the roots that demanded it. A file added or removed re-runs the project whole for now.

Parsing (0.3s) and fact emission (0.8s to 1.5s) still run whole from the CLI; the live process caches both per file. Rails' `config/routes.rb` becomes the config file the entry key guards, since the routing-gap accumulator reads it whole.

The 2026-09-03 decision to shelve per-file reuse was taken when the largest cold run was 1.5s. Mastodon is 17.8s now, and two of the three file classes the earlier design had to decline (ancestry walks, storage through `couldMatch`) have since become demand-driven rules, which is what lets demand attribute them.

### Targets and the measurement

| edit | today | closure reuse, CLI | live process | budget |
|-|-:|-:|-:|-:|
| twenty-server, one leaf file | 24.0s | about 13s | about 3s | 5s |
| twenty-server, unchanged | 2.55s | 2.55s | under 0.1s | |
| mastodon, one file | 17.8s | about 3s, per-file reuse | about 1.5s | 5s |
| dispatch, one file | 17.8s | about 3s | about 1.5s | 5s |

The CLI columns come from the survey's `warm.ts` harness with one change: the edit adds a branch instead of a comment, so the partial path runs rather than the touch path. Three alternating runs each, under 40% load, and the output byte-identical to a `--no-cache` run, which is the cache contract. The live column is a script that writes the same edit and times the server from the write to its rebuilt status, plus the hook end to end, from the PostToolUse start to its output. The corpora are the survey's, so the numbers compare.

## The plan

1. **Findings after each edit, from the CLI.** The plugin, the PostToolUse hook, the session record, the finding-identity diff and the noise rules. The worker runs `extract --out-dir` (cached) and `check --since --json` against the previous reading. Demo: the 409 story on the express and fetch fixtures, where a partial run is under a second. On a large repository the result arrives late, at the next hook, which is the budget rule doing its job.
2. **The Stop report without intent.** The baseline at session start, `inspect --diff` at stop, new findings since the baseline, one block on a new error. Demo: the same session, where the report lists the 409 as a change and the client's new branch.
3. **The intent.** The skill, the change list, the matching in `suss intent check`, the four verdicts, `asked` quotes checked against the prompts, `explained:`, and `/suss:keep-intent`. Demo: the three-entry list above, with one unchecked entry and one not-asked entry that blocks once.
4. **Closure reuse in the manifest.** Demo: twenty-server leaf edit from 24s to about 13s, byte-identical.
5. **The live process.** The socket, the adapter reused across runs, the invalidation above, hooks talking to the server instead of running the CLI. Demo: the per-edit hook under 5s on twenty-server.
6. **Python and Ruby per-file reuse.** Demo: a mastodon edit under 3s from the CLI and under 2s live.
7. **Other agents.** The hook client speaks the socket; this step is the hook configuration for Codex and Cursor, and the docs. Demo: the 409 story in Codex.

Steps 1 to 3 need no performance work and give the demonstration the September positioning asks for, inside the agent's loop. Steps 4 and 6 stand on their own as CLI improvements.

## Where a hosted version attaches

The session record (prompts, change lists, baseline, final report) is one folder of JSON and YAML per session, and the report is a diff plus findings. A hosted supervisor ingests those records from many repositories, keeps the edge projection of each repository's summaries, and can say what this plugin cannot: which consumer in another repository breaks. It also sees intent across sessions and teams. The plugin writes the record and stays within one repository.

## Decisions

1. **Where the intent lives after the task.** The session record only, with `/suss:keep-intent` compiling the end state into `intent/` as `source: author` when the developer wants it. Writing intent documents automatically would fill `intent/` with documents nobody curated.
2. **Block or context for a per-edit warning.** Block on a new error and on a new warning at the changed boundary, context for the delta line. That warning is the case the plugin exists for, and holding it until Stop loses the moment before the developer sees the diff.
3. **One process per session or per repository.** Per repository. The first server to start binds the socket and owns the program; later ones proxy to it. Two sessions on twenty-server would otherwise keep two 3.7 GB programs resident.
4. **The baseline: session start or git base.** Session start, advancing after each passing stop, with `/suss:baseline` to reset once the command exists. A `--since HEAD` mode is the pull request diff the positioning wants and belongs to the Action, not the hook.
5. **Enum members.** Add `enum:` to the primitive shapes in the intent vocabulary and compare it against literal unions in body shapes, after step 3. Until then an entry about an enum member is unchecked. A store column's enum needs the Prisma reader to emit members, which is separate work.
6. **Reach changes in `inspect --diff --json`.** Add them, since not asked at the effect level depends on them. The JSON lists a reach change at every route it reaches, with the helper in `through`, the same way the text does. Grouping a change under the helper that caused it needs two more decisions, which unit on the chain caused it and which routes count as the ones it runs on, and would change both forms.
7. **Per-file facts on disk for Python and Ruby.** In the live process only. The CLI re-emits facts in 1.5s, and a tuple file would cost about that to load.
8. **A hook on Bash writes.** No. A stop reads the project once more, so what a Bash write changed is in the stop report; with the live process, its watcher sees the write and the next event delivers the result.
