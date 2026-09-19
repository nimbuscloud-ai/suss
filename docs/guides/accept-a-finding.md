---
title: Accept a finding
description: Paste the rule suss prints under a finding into .sussignore, give it a reason, and the run stops failing on it while the finding stays visible.
---

# Accept a finding

Some findings are true and you accept them anyway, such as a status the caller deliberately leaves to a retry it already has. Paste the rule suss prints under the finding into a `.sussignore` file, and give it a reason.

`check` prints the rule for you:

```
[WARNING] unhandledProviderCase
  Provider produces status 429 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/reports.ts::loadReport (src/reports.ts:1)
  boundary: hono (http) GET /reports/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /reports/{id}"
      provider: { transitionId: "get:response:429:e48b52c" }
      reason: TODO say why you accept this
```

Paste it under `rules:` and replace the reason with yours:

```yaml
# .sussignore.yml
version: 1
rules:
  - kind: unhandledProviderCase
    boundary: "GET /reports/{id}"
    provider: { transitionId: "get:response:429:e48b52c" }
    reason: the nightly batch is the only caller and the scheduler retries the whole job
```

Run `check` again. The finding is still there, marked, with your reason under it, and it no longer counts toward the exit code:

```
[WARNING, suppressed] unhandledProviderCase
  Provider produces status 429 but no consumer branch handles it
  suppressed (mark): the nightly batch is the only caller and the scheduler retries the whole job
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/reports.ts::loadReport (src/reports.ts:1)
  boundary: hono (http) GET /reports/:id
```

## Where the file goes

Most people keep it at the project root, beside `package.json`. `suss check --dir summaries/` starts looking inside `summaries/` and walks up until it finds one. `suss check provider.json consumer.json` starts in the working directory and walks up the same way. Either search stops at the first directory that has a `package.json` or a `.git` in it, so suss never picks up a file from outside your project.

In each directory suss takes the first of these it finds:

1. `.sussignore` (parsed as YAML)
2. `.sussignore.yml`
3. `.sussignore.yaml`
4. `.sussignore.json`

A `.sussignore.json` in the summaries directory is read as suppression config, not as a summaries file.

Two flags override the search. `--sussignore <path>` points at a file directly. `--no-suppressions` ignores every file, so you can see what the run would report if the list were empty.

## Effects

A rule's `effect` decides what happens when it matches. The default is `mark`.

| Effect | In the report | In the exit code |
|---|---|---|
| `mark` | shown, tagged `suppressed (mark)` with the reason | no |
| `downgrade` | shown one severity lower, with both severities printed | yes, at the lower severity |
| `hide` | removed from the report and from `--json` | no |

Use `downgrade` while a fix is planned. The finding still shows up, and it stops blocking the build:

```yaml
version: 1
rules:
  - kind: unhandledProviderCase
    boundary: "GET /reports/{id}"
    provider: { transitionId: "get:response:429:e48b52c" }
    effect: downgrade
    reason: a retry on 429 is planned for next sprint; keep the finding visible until then
```

```
[INFO, downgraded from WARNING] unhandledProviderCase
  Provider produces status 429 but no consumer branch handles it
  suppressed (downgrade): a retry on 429 is planned for next sprint; keep the finding visible until then
```

`error` drops to `warning`, `warning` to `info`, and `info` stays where it is. `--fail-on` still counts a downgraded finding, at its new severity.

`hide` takes the finding out of the output entirely, `--json` included, so it disappears from every dashboard and every reviewer's report. `mark` is the better default.

## Fields

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: "GET /pet/{petId}"
    consumer:
      transitionId: ct-500
    effect: hide
    reason: |
      Upstream returns 500 only in the force-majeure case, which generic
      retry middleware handles rather than this call site.
```

| Field | Required | Notes |
|---|---|---|
| `version` | yes | Always `1`. A file without it does not load, and `check` prints the line to add. |
| `kind` | see matching | Any behavioral or intent finding kind. The [findings catalog](/reference/findings) lists them. An unknown kind is rejected when the file loads. |
| `boundary` | see matching | `"METHOD /path"`, with `:id` and `{id}` both accepted, or a non-REST key verbatim (`"fn:@acme/api::getUser"`, `"gql:Query.user"`). |
| `consumer.transitionId` | optional | Matches the consumer side's branch. |
| `consumer.summary` | optional | `${file}::${name}` for the consumer side. |
| `provider.transitionId` | optional | Matches the provider side's branch. A finding about a status the provider produces puts its id here, not on the consumer. |
| `provider.summary` | optional | `${file}::${name}` for the provider side. Also matches a contributor listed in `sources` when two identical findings were collapsed. |
| `scope` | optional, default `narrow` | `broad` allows a rule with only a `kind` or only a `boundary`. |
| `reason` | yes | Free text. It shows in the report next to the suppressed finding. |
| `effect` | optional, default `mark` | `mark`, `downgrade` or `hide`. |

No other keys are accepted, and there is no `expires`.

## Matching

A finding matches a rule when every field the rule states equals the finding's. Fields the rule leaves out match anything, and there is no wildcard syntax: `boundary: "GET /legacy/*"` matches a route literally spelled `/legacy/*`, not everything under `/legacy`. The first rule that matches wins, so order matters when two rules overlap.

A narrow rule, which is the default, needs `kind` plus one of `boundary`, `consumer.transitionId` or `provider.transitionId`. The rule suss prints always satisfies that, because it identifies the transition on whichever side has one. A finding with no transition on either side gets no printed rule, since `kind` plus `boundary` would silence every other finding of that kind on that boundary.

For a whole category, `scope: broad` opts in to a rule keyed on `kind` alone:

```yaml
version: 1
rules:
  - kind: lowConfidence
    scope: broad
    effect: mark
    reason: low-confidence meta-findings are informational; inspect still shows them
```

A broad rule also silences regressions in that category later on, so the `reason` is all anyone will have to go on.

Intent findings from `suss check --intent` take the same rules. `kind` and `boundary` match the same way; `consumer` and `provider` never match an intent finding, which has neither side. A PRD scenario finding that resolves to no boundary is keyed `prd:<title>`, so match it on that string or with `scope: broad`.

## When a rule stops matching

Nothing expires. The thing that changes under a rule is the transition id. suss builds that id from the enclosing function's name, the terminal kind, the status and a hash of the branch's conditions. If you edit the body of a branch, the id stays the same. If you rename the function, change the status or change a guard, the id is new, the rule stops matching, and the finding comes back so you can look at the branch again.

The other case to know about is a rule that points at a summary read from a deploy template. The name of one of those summaries includes the document's path, as in `cloudformation:services/orders/template.yaml::GetOrders`. A rule written the older way, with the file name alone, still matches, and it matches every document that reader reads with that file name. suss prints a note on stderr when that happens. Write the full path to tie the rule to one document.

## The review habit

An accepted finding is a piece of context the next maintainer has to read, so keep the list short and go back to it.

- **Write the reason for a stranger.** "legacy" tells them nothing. "the load balancer is the only caller and it does not read the body" tells them why you accepted it.
- **Audit with `--no-suppressions`.** It reports everything the rules currently take out. Run it before a release, or whenever the file has grown.
- **Delete the rule with the fix.** When the migration ships or the endpoint goes away, the rule goes with it. Nothing prompts you, so the pull request that does the work is the place to do it.
- **Watch the count.** A suppressed finding is still in the report and still in `--json`, so CI can publish how many there are. If that number only ever goes up, the list needs attention.

If you cannot write a reason, you have not accepted the finding. Fix it instead. Suppression is for drift you have decided to live with. If you are not ready for a whole severity yet, use `--fail-on error`.
