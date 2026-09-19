---
title: Accept a finding
description: Write a .sussignore rule that records a finding you have reviewed and accepted, and put the file where a suss run will pick it up.
---

# Accept a finding

Suppress a finding you have reviewed and accepted: a legacy
endpoint, a planned migration, a known issue with a documented
owner. Suppressions live in a `.sussignore` file that travels with
the code.

Put it at the project root, next to `package.json`. `suss check`
starts looking where it reads the summaries and walks up to the
project root, taking the nearest file it finds, so a file beside
the summaries works too. `--sussignore <path>` overrides the
search.

For the conceptual model and full rule schema see
[Accept a finding](/guides/accept-a-finding).

## Three effects

A rule declares an **effect**, what happens when the rule
matches a finding:

| Effect | Shown in output? | Counts toward exit code? | Use when |
|---|---|---|---|
| `mark` | yes (marked as suppressed) | no | you want the finding visible in reports but don't want CI to fail on it |
| `downgrade` | yes, at the new severity | yes, at the downgraded severity | the finding is real but not blocking |
| `hide` | no (filtered entirely) | no | the finding is noise you want out of the way, rare; prefer `mark` |

The default is `mark` if you don't specify.

## Pattern 1: suppress a specific finding

`suss check` prints a rule under each finding it reports:

```
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /legacy/health"
      provider: { transitionId: "health:response:503:1c40e2b" }
      reason: TODO say why you accept this
```

Paste it under `rules:` and replace the reason with yours:

```yaml
# .sussignore.yml
version: 1
rules:
  - kind: unhandledProviderCase
    boundary: "GET /legacy/health"
    provider: { transitionId: "health:response:503:1c40e2b" }
    reason: load balancer only; the caller doesn't need status handling
```

The rule matches that finding and no other, because the transition
id points at one branch of one function.

Every file starts with `version: 1`. Leave it off and `suss check`
stops and tells you to add it.

The filename is `.sussignore.yml`, `.sussignore.yaml`, or
`.sussignore.json`, checked in that order. `suss check` picks up the
first one it finds.

## Pattern 2: downgrade instead of silence

This is often better than hiding it. The finding keeps showing, but
it doesn't fail the build.

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: POST /users
    consumer:
      transitionId: ct-503
    effect: downgrade
    reason: 503 branch is defensive; keep the finding visible as info
```

After a downgrade, `deadConsumerBranch` at `error` shows as
`warning`. The `--fail-on` threshold still counts it, but at
the downgraded severity.

## Pattern 3: broad-scope category rule

For an entire *kind* of finding you don't want to fail on, e.g.
`lowConfidence` findings across the whole codebase:

```yaml
version: 1
rules:
  - kind: lowConfidence
    scope: broad
    effect: mark
    reason: low-confidence meta-findings are informational; they'll show in inspect
```

Narrow-scope rules (the default) require at least `kind` AND one
of `boundary` / `consumer.transitionId` / `provider.transitionId`
to prevent accidentally-wide matches. Broad rules opt in with
`scope: broad`.

## Pattern 4: match one branch, on either side

This is useful when the same boundary has several branches and only
one needs suppression. A finding about a branch of the caller puts
its transition id on the consumer side:

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    consumer:
      transitionId: ct-503
    reason: ops team retired the 503 path; branch kept for one more release
```

A finding about a status the provider produces puts it on the
provider side, and a rule keyed on the consumer never matches one
of those:

```yaml
version: 1
rules:
  - kind: unhandledProviderCase
    provider:
      transitionId: get:response:410:3b915da
    reason: the caller retries anything unexpected, 410 included
```

The printed rule already picks the right side. Transition ids also
come from the summary file. Inspect to find them:

```bash
npx suss inspect summaries/consumer.json
```

Each `-> output when conditions` line is a transition. The ID is
deterministic per `(function name, terminal kind, status key,
condition hash)`, see [Behavioral summary format](/reference/summary-format).

## Naming a summary read from a deploy template

A rule can point at a summary directly, and a summary read from a
template is named after the document it came from:
`cloudformation:services/orders/template.yaml::GetOrders`. Documents
used to be named by file name alone
(`cloudformation:template.yaml::GetOrders`), which made every
`template.yaml` in a repository one name. A rule written that way still
matches, by file name, across every document of that reader that has
that file name, and suss says so on stderr when it reads the file.
Writing the path pins the rule to one document.

## Reasons are required

Every rule needs a `reason` string. No default, no elision. The
point is that suppressions travel with context. A human reader
(you, or a future maintainer) gets to see *why* this was accepted.

If you can't write a reason, the finding isn't accepted. Fix the
underlying issue instead.

## Verify it worked

```bash
npx suss check --dir summaries/
```

A `mark` suppression keeps the finding in the report and tags the
severity. The reason appears under the description:

```
[ERROR, suppressed] unhandledProviderCase
  Provider produces status 410 but no consumer branch handles it
  suppressed (mark): the caller retries on anything unexpected
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadUser (src/client.ts:1)
  boundary: hono (http) GET /users/:id
```

A `downgrade` shows both severities:

```
[WARNING, downgraded from ERROR] unhandledProviderCase
  Provider produces status 410 but no consumer branch handles it
  suppressed (downgrade): 410 is defensive for now
```

The `countsForThreshold` test in `@suss/checker` is the
authoritative check for whether a finding counts at the CLI
level, and its behavior mirrors the `--fail-on` threshold.

## What suppressions are *not*

- **Not a deletion.** Suppressed findings are still in the JSON
  output when using `--json`. Downstream tools (dashboards,
  reviewers) can see them.
- **Not free.** Every rule is a piece of context future
  maintainers have to read. Keep the list small.
- **Not eternal.** Rules should expire. When the planned
  migration ships, remove the rule; when the legacy endpoint
  goes away, remove the rule.

The rest of this page is the `.sussignore` file itself: where a run
looks for it, every field a rule takes, and how a rule is matched
against a finding.

Some findings are true but accepted, a consumer that deliberately doesn't handle a rare upstream status, a documented contract-spec divergence kept for migration reasons, a legacy quirk scheduled to be removed next quarter. A `.sussignore` file silences or annotates these without modifying the summaries themselves.

## Where the file goes

The project root is the usual home for it, next to `package.json`. `suss check --dir summaries/` starts looking inside `summaries/` and walks up to the project root, taking the nearest file it finds. `suss check provider.json consumer.json` starts in the working directory and walks up the same way. The walk stops at the first directory that contains a `package.json` or a `.git`, so a file outside the project is never picked up by a run. `--sussignore <path>` overrides the search.

In each directory it takes the first of these it finds:

1. `.sussignore` (parsed as YAML)
2. `.sussignore.yml`
3. `.sussignore.yaml`
4. `.sussignore.json`

A `.sussignore.json` sitting in the summaries directory is read as suppression config, not as a summaries file.

## File format

YAML and JSON encode the same thing:

```yaml
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: "GET /pet/{petId}"
    consumer:
      transitionId: ct-500
    reason: |
      Upstream returns 500 only in force-majeure scenarios we handle
      via generic retry middleware, not per-call.
    effect: hide
```

`version: 1` is required. A file without it does not load, and `suss check` says so and tells you the line to add.

### Writing a rule from a finding

`suss check` prints a rule for each finding it reports, ready to paste under `rules:`:

```
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:410:3b915da" }
      reason: TODO say why you accept this
```

The rule identifies the transition on whichever side has one, so it matches that finding and no other. Replace the reason with your own and it is done. A finding with no transition on either side gets no printed rule, because `kind` plus `boundary` is the only rule left to write and it would silence every other finding of that kind on the boundary.

### Fields

| Field | Required | Notes |
|---|---|---|
| `kind` | at least one of kind/boundary/consumer.transitionId/provider.transitionId unless `scope: broad` | Any behavioral finding kind, see the [findings catalog](/reference/findings) for the full list (REST coverage / contract / consumer kinds, GraphQL pairing, React-Storybook, storage, message-bus, runtime-config, plus meta kinds like `lowConfidence`), or any intent finding kind: system-intent-vs-code (`uncoveredOutcome`, `unimplementedBoundary`, `outcomeShapeMismatch`, `undeclaredOutcome`, `unkeyableBoundary`, `renamedBoundary`) and PRD scenario coverage (`unlinkedScenario`, `danglingScenarioLink`, `ambiguousScenarioLink`). Unknown kinds are rejected at load time. |
| `boundary` | see above | Human-readable key: `"METHOD /path"` (both `:id` and `{id}` accepted), or a non-REST key verbatim (`"fn:@acme/api::getUser"`, `"gql:Query.user"`). |
| `consumer.summary` | optional | `${file}::${name}` key matching the consumer side of the finding. |
| `consumer.transitionId` | optional | Matches `Finding.consumer.transitionId`. |
| `provider.summary` | optional | `${file}::${name}` key matching the provider side of the finding. |
| `provider.transitionId` | optional | Matches `Finding.provider.transitionId`. A finding about a status the provider produces puts its id here, not on the consumer. |
| `scope` | optional, default `"narrow"` | `"broad"` opts in to kind-only or boundary-only matches. |
| `reason` | **required** | Free text explaining why this is accepted. It appears in the human output next to the suppressed finding. |
| `effect` | optional, default `"mark"` | See below. |

### Matching

A finding matches a rule when every specified field on the rule equals the corresponding field on the finding. Unspecified fields are wildcards. The *first* rule that matches a finding wins, ordering matters if you have overlapping rules with different effects.

**Narrow scope (default)** requires at least `kind` AND one of `boundary` / `consumer.transitionId` / `provider.transitionId`. This is strict enough to target a specific finding class without accidentally silencing future regressions of an entirely different kind on an unrelated boundary.

**Broad scope** (`scope: broad`) opts in to kind-only or boundary-only matches. Use sparingly, these silence future regressions in that category too, and the `reason` field is your only trace of why when that happens six months from now.

### Effects

- **`mark`** (default), the finding is still shown and still returned to downstream tools, annotated `suppressed (mark): <reason>`. It is excluded from the `--fail-on` exit-code threshold. Reviewers still see it.
- **`downgrade`**: severity drops one level (`error` → `warning` → `info`). The original severity is preserved in `suppressed.originalSeverity`. Still counts toward the threshold at the *downgraded* severity, so `--fail-on info` still catches it.
- **`hide`**: the finding is removed from the output and excluded from the threshold. Use it when the noise serves no one, and accept that you give up some transparency for it.

## Intent findings

The same rules apply to intent findings from `suss check --dir --intent`. `kind` and `boundary` match the same way (the intent finding's boundary is already a key string); `consumer` and `provider` never match an intent finding, which has neither side. Effects and threshold semantics are identical.

PRD scenario-coverage findings don't always resolve to an actual boundary. A `danglingScenarioLink` whose intent name *did* resolve is keyed on that intent's boundary (`GET /users/{id}`), so a narrow `kind` + `boundary` rule targets it. An `unlinkedScenario`, an `ambiguousScenarioLink`, or a link whose intent name doesn't resolve has no boundary to key on, so it gets a `prd:<title>` key instead. Match those with `boundary: "prd:<title>"` verbatim, or with `scope: broad` on `kind` alone.

## CLI flags

- `--sussignore <path>`: explicit suppressions file path; skips auto-discovery.
- `--no-suppressions`: ignores any suppressions file, even if one is present. Useful for auditing what would fire without them.

## When *not* to use suppressions

- To paper over a bug. If the finding reflects genuine missing behavior, fix it rather than suppressing.
- To silence a class of warnings because "we don't care about those yet." Use `--fail-on error` or `--fail-on none` instead, that's the threshold knob.
- To paper over contract-spec drift between sources. Use the contract-anchored discrepancy detection (planned), suppression is the right tool when you've *decided* to accept the drift, not before.

## Why no `expires`?

An earlier design included an `expires` field that would warn or fail when a suppression outlived its stated timeline. It was removed before shipping because:

- Cargo-cult dates ("expires: 1 year from now") are muscle memory without planning, not protection.
- A soft expiry warning accumulates in logs and gets ignored.
- A hard expiry re-introduces noise that teams re-extend to avoid, teaching them to pick longer timeouts.

The actual problem, suppressions outliving their rationale, is a human-judgment problem that software automation makes worse, not better. The mitigations that work:

- Required `reason` field (present). An old suppression's justification is legible enough to judge its freshness.
- `suss check --no-suppressions` to audit what would fire if every suppression were removed. (Plan: add a `suss suppressions list` subcommand that shows every active rule + git-blame age when adoption warrants it.)
- CI surfacing the count of suppressed findings as a secondary signal. Growth is a health trend.

If suppression rot becomes a material problem affecting production teams, we'll add observability first, and enforcement only if observability proves insufficient.

## Interaction with the `lowConfidence` finding kind

The checker already emits `lowConfidence` findings when opaque predicates prevented it from reaching a definite conclusion ("couldn't tell"). That is orthogonal to suppression: a `lowConfidence` finding is a diagnostic. You can suppress one like any other (`kind: lowConfidence` in a rule). An unsuppressed low-confidence finding is the checker saying it could not tell, which is different from a finding being ignored.

## See also

- [Cross-boundary checking](/why/cross-boundary-checking), the findings taxonomy you'll suppress
- Suppression rules deliberately have no expiry date. A date nobody
  revisits does not stop suppression rot, and the required `reason`
  field is what does the work instead. The
  [status design record](https://github.com/nimbuscloud-ai/suss/blob/main/design/status.md) has the rest of the
  reasoning, as a working record rather than documentation.
