# Intent specs, suss checking itself

These documents say what suss promises the people who use it, and the
exports those promises rest on. `npm run check:self` compares them with
what the code does, through the same `suss check --intent` a user runs,
and fails on any error or warning.

```
npm run build
npm run dogfood
npm run check:self
```

The check reads the summaries the dogfood run writes for every package
under `packages/*/.suss/`, so run the dogfood first. In CI both run in
the behaviour job, in that order. Summaries from an older dogfood run
describe older code, so run it again after a change.

## PRDs

Each `*.prd.yaml` is one feature, written as scenarios in the words of
the person using suss. A scenario that links to a boundary outcome
(`link: <name>.<outcome-id>`) is backed by that outcome, and the check
fails when the outcome goes away. A scenario with no link has a comment
saying why:

- The promise is about which values come back, such as a finding that
  was already there not being reported as new. An outcome cannot state
  that, and the comment says which test covers it.
- The promise is about a CLI command's exit code or output, or an MCP
  tool's result. suss has no boundary for either.

| File | Feature |
|---|---|
| `setUpAProject.prd.yaml` | Set up a project |
| `emptyRunFails.prd.yaml` | A run that compares nothing fails and says why |
| `acceptAFinding.prd.yaml` | Accept a finding once, and it stays accepted |
| `askOneQuestion.prd.yaml` | Ask one question, and get an answer or what would let suss answer |
| `sameOutputTwice.prd.yaml` | A second run gives the same output as the first |
| `reviewAsBehavior.prd.yaml` | Review a change as behavior, not lines |
| `checkAnAgentsEdit.prd.yaml` | An agent's edit is checked, and the agent is never blamed for what was there before |

## Boundary intent

Each `*.intent.yaml` is one export another program calls, paired with
the code by `fn:<package>::<exportPath>`. Three groups of callers rely
on them:

- Programs using suss as a library: `parseSummaries` and
  `diffSummaries` from `@suss/behavioral-ir`, `checkAll`, `checkPair`
  and `dedupeFindings` from `@suss/checker`, and `checkIntentAgreement`
  and `applyIntentSuppressions` from `@suss/checker-intent`.
- Agent integrations, the supervisor plugin and the MCP server:
  `findingIdentity`, `findingsSince` and `changedBoundaries` from
  `@suss/checker`, `checkIntent`, `answerQuestion`, `declaredReads` and
  `checkDirectory` from `@suss/cli`, and `loadChangeListFile` from
  `@suss/contract-intent`.
- Pack authors: `httpRouteDiscovery` from `@suss/extractor`,
  `createTypeScriptAdapter` and its `extractAll` from
  `@suss/adapter-typescript`, and the four packs in `@suss/packs` that
  refuse to run without a setting only the project knows.

A document lists an outcome only where the code has one: a separate
return, a throw, or an effect. A function with one return path gets one
outcome, which says what the function returns.

`self.sussignore.yml` accepts the findings that are gaps in suss rather
than in the code, each with the reason.

Problems found while writing the first of these documents are logged in
[`design/dogfood-intent-notes.md`](../design/dogfood-intent-notes.md).
