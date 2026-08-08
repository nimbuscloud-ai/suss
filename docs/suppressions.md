# Suppressing findings

Some findings are true but accepted, a consumer that deliberately doesn't handle a rare upstream status, a documented contract-spec divergence kept for migration reasons, a legacy quirk scheduled to be removed next quarter. A `.sussignore` file silences or annotates these without modifying the summaries themselves.

## Where the file goes

The project root is the usual home for it, next to `package.json`. `suss check --dir summaries/` starts looking inside `summaries/` and walks up to the project root, taking the nearest file it finds. `suss check provider.json consumer.json` starts in the working directory and walks up the same way. The walk stops at the first directory that contains a `package.json` or a `.git`, so a file outside the project is never picked up by a run. `--sussignore <path>` overrides the search.

In each directory it takes the first of these it finds:

1. `.sussignore.yml`
2. `.sussignore.yaml`
3. `.sussignore.json`

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
| `kind` | at least one of kind/boundary/consumer.transitionId/provider.transitionId unless `scope: broad` | Any behavioral finding kind, see the [findings catalog](/reference/findings) for the full list (REST coverage / contract / consumer kinds, GraphQL pairing, React-Storybook, storage-relational, message-bus, runtime-config, plus meta kinds like `lowConfidence`), or any intent finding kind: system-intent-vs-code (`uncoveredOutcome`, `unimplementedBoundary`, `outcomeShapeMismatch`, `undeclaredOutcome`, `unkeyableBoundary`) and PRD scenario coverage (`unlinkedScenario`, `danglingScenarioLink`, `ambiguousScenarioLink`). Unknown kinds are rejected at load time. |
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

- [`docs/cross-boundary-checking.md`](cross-boundary-checking.md), the findings taxonomy you'll suppress
- `docs/status.md` decision #30, the design rationale for this first version
