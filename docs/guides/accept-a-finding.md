---
title: Accept a finding
description: Paste the rule suss prints under a finding into .sussignore, give it a reason, and the run stops failing on it while the finding stays visible.
---

# Accept a finding

Some findings are true and you accept them anyway: a legacy route retiring next quarter, a status the caller deliberately leaves to a retry it already has. Paste the rule suss prints under the finding into a `.sussignore` file, and give it a reason.

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

Run `check` again and the finding is still there, marked, with your reason under it, and it no longer counts toward the exit code:

```
[WARNING, suppressed] unhandledProviderCase
  Provider produces status 429 but no consumer branch handles it
  suppressed (mark): the nightly batch is the only caller and the scheduler retries the whole job
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/reports.ts::loadReport (src/reports.ts:1)
  boundary: hono (http) GET /reports/:id
```

## Where the file goes

The project root is the usual home for it, beside `package.json`. `suss check --dir summaries/` starts looking inside `summaries/` and walks up, taking the nearest file it finds; `suss check provider.json consumer.json` starts in the working directory and walks up the same way. Either walk stops at the first directory with a `package.json` or a `.git` in it, so a file outside the project is never picked up.

In each directory suss takes the first of these it finds:

1. `.sussignore` (parsed as YAML)
2. `.sussignore.yml`
3. `.sussignore.yaml`
4. `.sussignore.json`

A `.sussignore.json` in the summaries directory is read as suppression config, not as a summaries file.

Two flags override the search. `--sussignore <path>` points at a file directly. `--no-suppressions` ignores every file, which is how you audit what would fire if the list were empty.

## Effects

A rule's `effect` says what happens when it matches. The default is `mark`.

| Effect | In the report | In the exit code |
|---|---|---|
| `mark` | shown, tagged `suppressed (mark)` with the reason | no |
| `downgrade` | shown one severity lower, with both severities printed | yes, at the lower severity |
| `hide` | removed from the report and from `--json` | no |

`downgrade` is the one to reach for while a fix is planned. The finding keeps showing and stops blocking the build:

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
| `version` | yes | Always `1`. A file without it does not load, and `check` says which line to add. |
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

A broad rule silences future regressions in that category too, so the `reason` is the only trace of why when one turns up six months later.

Intent findings from `suss check --intent` take the same rules. `kind` and `boundary` match the same way; `consumer` and `provider` never match an intent finding, which has neither side. A PRD scenario finding that resolves to no boundary is keyed `prd:<title>`, so match it on that string or with `scope: broad`.

## When a rule stops matching

Nothing expires. What changes underneath a rule is the transition id, which is built from the enclosing function's name, the terminal kind, the status, and a hash of the branch's conditions. Edit the body of a branch and the id stays the same. Rename the function, change the status, or change a guard, and the id is new, so the rule no longer matches and the finding comes back. The branch you accepted is not the branch that is there now, and you get to look at it again.

The other case worth knowing is a rule that points at a summary read from a deploy template. Those summaries are named with the document's path, `cloudformation:services/orders/template.yaml::GetOrders`. A rule written the older way, with the file name alone, still matches, across every document of that reader with that file name, and suss says so on stderr. Write the path to pin the rule to one document.

## The review habit

An accepted finding is a piece of context the next maintainer has to read, so keep the list short and go back to it.

- **Write the reason for a stranger.** "legacy" says nothing. "the load balancer is the only caller and it does not read the body" says why.
- **Audit with `--no-suppressions`.** It reports everything the rules currently take out, which is what you want before a release or when the file has grown.
- **Delete the rule with the fix.** When the migration ships or the endpoint goes away, the rule goes with it. Nothing prompts you, so the pull request that does the work is the place to do it.
- **Watch the count.** A suppressed finding is still in the report and still in `--json`, so CI can publish how many there are. A number that only grows is the signal.

If you cannot write a reason, the finding is not accepted. Fix it instead. Suppression is for drift you have decided to live with. For a whole severity you are not ready for, `--fail-on error` is the knob.
