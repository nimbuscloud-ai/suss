# Suppress a finding

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
[Suppressions](/suppressions).

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
condition hash)`, see [Behavioral summary format](/behavioral-summary-format).

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
