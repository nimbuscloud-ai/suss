# Suppress a finding

For findings you've reviewed and accepted — a legacy endpoint,
a planned migration, a known issue with a documented owner.
Suppressions live in `.sussignore` at the repo root and travel
with the code.

For the conceptual model and full rule schema see
[Suppressions](/suppressions). This page is the task-shaped view:
how do I silence this specific finding?

## Three effects

A rule declares an **effect** — what happens when the rule
matches a finding:

| Effect | Shown in output? | Counts toward exit code? | Use when |
|---|---|---|---|
| `mark` | yes (annotated as suppressed) | no | you want the finding visible in reports but don't want CI to fail on it |
| `downgrade` | yes, at the new severity | yes, at the downgraded severity | the finding is real but not blocking |
| `hide` | no (filtered entirely) | no | the finding is noise you want out of the way — rare; prefer `mark` |

The default is `mark` if you don't specify.

## Pattern 1: suppress a specific finding

You've seen a warning and decided it's accepted. Copy the finding's
kind + boundary into `.sussignore`:

```yaml
# .sussignore
rules:
  - kind: unhandledProviderCase
    boundary: GET /legacy/health
    reason: load balancer only; consumer doesn't need status handling
```

`.sussignore` is YAML or JSON (any extension). Put it at the repo
root. `suss check` picks it up automatically.

## Pattern 2: downgrade instead of silence

Often better than hiding: let the finding keep showing, but not
fail the build.

```yaml
rules:
  - kind: deadConsumerBranch
    boundary: POST /users
    consumer:
      transitionId: ct-503
    effect: downgrade
    reason: 503 branch is defensive; keep the finding visible as info
```

After downgrade, `deadConsumerBranch` at `error` shows as
`warning` — the `--fail-on` threshold still counts it, but at
the downgraded severity.

## Pattern 3: broad-scope category rule

For an entire *kind* of finding you don't want to fail on — e.g.
`lowConfidence` findings across the whole codebase:

```yaml
rules:
  - kind: lowConfidence
    scope: broad
    effect: mark
    reason: low-confidence meta-findings are informational; they'll show in inspect
```

Narrow-scope rules (the default) require at least `kind` AND one
of `boundary` / `consumer.transitionId` to prevent accidentally-wide
matches. Broad rules opt in with `scope: broad`.

## Pattern 4: match by consumer transition

Useful when the same boundary has multiple consumer branches and
only one needs suppression:

```yaml
rules:
  - kind: deadConsumerBranch
    consumer:
      transitionId: ct-503
    reason: ops team retired the 503 path; branch kept for one more release
```

Transition IDs come from the summary file. Inspect to find them:

```bash
npx suss inspect summaries/consumer.json
```

Each `-> output when conditions` line is a transition; the ID is
deterministic per `(function name, terminal kind, status key,
condition hash)` — see [Behavioral summary format](/behavioral-summary-format).

## Reasons are required

Every rule needs a `reason` string. No default, no elision. The
point is that suppressions travel with context — a human reader
(you, or a future maintainer) gets to see *why* this was accepted.

If you can't write a reason, the finding isn't accepted — fix the
underlying issue instead.

## Verify it worked

```bash
npx suss check --dir summaries/
```

Suppressed findings show an annotated severity:

```
[ERROR, suppressed] deadConsumerBranch
  Consumer expects status 503 but provider never produces it
  ... (rest of finding) ...
  suppression: ct-503 branch kept for one more release
```

Findings at the downgraded severity show both forms:

```
[WARNING, downgraded from ERROR] deadConsumerBranch
```

The `countsForThreshold` test in `@suss/checker` is the
authoritative check for whether a finding counts at the CLI
level; behavior mirrors the `--fail-on` threshold.

## What suppressions are *not*

- **Not a deletion.** Suppressed findings are still in the JSON
  output when using `--json`. Downstream tools (dashboards,
  reviewers) can see them.
- **Not free.** Every rule is a piece of context future
  maintainers have to read. Keep the list small.
- **Not eternal.** Rules should expire. When the planned
  migration ships, remove the rule; when the legacy endpoint
  goes away, remove the rule.
