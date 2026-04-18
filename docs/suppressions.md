# Suppressing findings

Some findings are true but accepted — a consumer that deliberately doesn't handle a rare upstream status, a documented contract-spec divergence kept for migration reasons, a legacy quirk scheduled to be removed next quarter. Suss has a `.sussignore` file at the project root that silences or annotates these without modifying the summaries themselves.

## File format

`suss check` looks for the first of these in the directory it's invoked against (or pointed at by `--sussignore <path>`):

1. `.sussignore.yml`
2. `.sussignore.yaml`
3. `.sussignore.json`

Both YAML and JSON encode the same shape:

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

### Fields

| Field | Required | Notes |
|---|---|---|
| `kind` | at least one of kind/boundary/consumer.transitionId unless `scope: broad` | One of: `unhandledProviderCase`, `deadConsumerBranch`, `providerContractViolation`, `consumerContractViolation`, `lowConfidence`. |
| `boundary` | see above | Human-readable key: `"METHOD /path"`. Both `:id` and `{id}` syntaxes accepted. |
| `consumer.summary` | optional | `${file}::${name}` key matching the consumer side of the finding. |
| `consumer.transitionId` | optional | Matches `Finding.consumer.transitionId`. |
| `scope` | optional, default `"narrow"` | `"broad"` opts in to kind-only or boundary-only matches. |
| `reason` | **required** | Free text explaining why this is accepted. Surfaces in human output next to the suppressed finding. |
| `effect` | optional, default `"mark"` | See below. |

### Matching

A finding matches a rule when every specified field on the rule equals the corresponding field on the finding. Unspecified fields are wildcards. The *first* rule that matches a finding wins — ordering matters if you have overlapping rules with different effects.

**Narrow scope (default)** requires at least `kind` AND one of `boundary` / `consumer.transitionId`. This is strict enough to target a specific finding class without accidentally silencing future regressions of an entirely different kind on an unrelated boundary.

**Broad scope** (`scope: broad`) opts in to kind-only or boundary-only matches. Use sparingly — these silence future regressions in that category too, and the `reason` field is your only trace of why when that happens six months from now.

### Effects

- **`mark`** (default) — finding is still shown and returned to downstream tools, annotated `suppressed (mark): <reason>`. Excluded from the `--fail-on` exit-code threshold. Reviewers still see it.
- **`downgrade`** — severity drops one level (`error` → `warning` → `info`). The original severity is preserved in `suppressed.originalSeverity`. Still counts toward the threshold at the *downgraded* severity, so `--fail-on info` still catches it.
- **`hide`** — finding is removed from output and excluded from the threshold. Use when the noise genuinely serves no one; lose some transparency for it.

## CLI flags

- `--sussignore <path>` — explicit suppressions file path; skips auto-discovery.
- `--no-suppressions` — ignores any suppressions file, even if one is present. Useful for auditing what would fire without them.

## When *not* to use suppressions

- To fix a real bug. If the finding reflects genuine missing behavior, fix it rather than suppressing.
- To silence a class of warnings because "we don't care about those yet." Use `--fail-on error` or `--fail-on none` instead — that's the threshold knob.
- To paper over contract-spec drift between sources. Use the contract-anchored discrepancy detection (planned) — suppression is the right tool when you've *decided* to accept the drift, not before.

## Why no `expires`?

An earlier design included an `expires` field that would warn or fail when a suppression outlived its stated timeline. It was removed before shipping because:

- Cargo-cult dates ("expires: 1 year from now") are muscle memory without planning, not protection.
- A soft expiry warning accumulates in logs and gets ignored.
- A hard expiry re-introduces noise that teams just re-extend to avoid, teaching them to pick longer timeouts.

The actual problem — suppressions outliving their rationale — is a human-judgment problem that software automation makes worse, not better. The mitigations that work:

- Required `reason` field (present). An old suppression's justification is legible enough to judge its freshness.
- `suss check --no-suppressions` to audit what would fire if every suppression were removed. (Plan: add a `suss suppressions list` subcommand that shows every active rule + git-blame age when adoption warrants it.)
- CI surfacing the count of suppressed findings as a secondary signal. Growth is a health trend.

If suppression rot becomes a real problem with real users, we'll add observability first, and enforcement only if observability proves insufficient.

## Interaction with the `lowConfidence` finding kind

The checker already emits `lowConfidence` findings when opaque predicates prevented it from reaching a definite conclusion ("couldn't tell"). That is orthogonal to suppression: a `lowConfidence` finding is not a suppressed finding, it's a *diagnostic* finding. You can suppress a `lowConfidence` finding like any other (`kind: lowConfidence` in a rule); you shouldn't treat unsuppressed low-confidence as silently-ignored — it's the tool honestly telling you "I don't know."

## See also

- [`docs/cross-boundary-checking.md`](cross-boundary-checking.md) — the findings taxonomy you'll suppress
- `docs/status.md` decision #30 — design rationale for this v0 shape
