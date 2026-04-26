# Set up CI checking

Run suss on every pull request. The goal is a single check that
flags boundary drift before it merges — provider producing a
status the client doesn't handle, client contract not matching a
declared spec, GraphQL selection against a field the schema
doesn't have.

## The one-job pattern

The common shape: one CI job runs `extract` on both sides,
then `check`, and fails the build on any finding above a
threshold.

### GitHub Actions

```yaml
name: suss

on: [pull_request]

jobs:
  boundary-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Extract provider summaries
        run: npx suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json

      - name: Extract consumer summaries
        run: npx suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json

      - name: Check cross-boundary
        run: npx suss check summaries/provider.json summaries/consumer.json --fail-on error
```

The `--fail-on error` flag makes the job non-zero only when
there are error-severity findings; warnings and info findings
print but don't fail the build. Adjust to `--fail-on warning`
once your signal-to-noise is tuned.

### Multi-boundary

For an app that crosses several boundaries (HTTP + GraphQL +
third-party APIs), run one extract per boundary into the same
directory and let `check --dir` auto-pair everything:

```yaml
- run: mkdir -p summaries
- run: npx suss extract -p api/tsconfig.json -f ts-rest -o summaries/api.json
- run: npx suss extract -p web/tsconfig.json -f axios -f apollo-client -o summaries/web.json
- run: npx suss contract --from openapi vendor/stripe.json -o summaries/stripe.json
- run: npx suss contract --from appsync infra/template.yaml -o summaries/appsync.json
- run: npx suss check --dir summaries/ --fail-on error
```

`check --dir` pairs every provider summary with every consumer
summary that shares a boundary key (`GET /users/:id`,
`gql:Query.pet`, etc.). Sources don't have to match origin — a
stub-from-OpenAPI provider pairs naturally against a
runtime-axios consumer.

## JSON output for downstream tooling

`--json` emits findings as JSON rather than human text. Useful
for PR-comment bots, dashboards, dedicated reporting steps:

```yaml
- id: check
  run: npx suss check --dir summaries/ --json -o findings.json
  continue-on-error: true

- name: Post to PR
  if: always()
  uses: ./.github/actions/post-suss-findings
  with:
    findings: findings.json
```

The JSON shape is the IR's `Finding[]` — same types the checker
exports. Downstream tools that consume it can validate via
`@suss/behavioral-ir`'s exported schema or the generated
JSON Schema (`packages/ir/schema/behavioral-summary.schema.json`).

## Suppressing known-accepted findings

Not every finding needs to fail the build. A legacy endpoint
returning 500 on timeout that the team has accepted; a
`deadConsumerBranch` for a status the server has never actually
produced. The `.sussignore` file holds these exceptions, each
carrying a written reason:

```yaml
# .sussignore — one rule per accepted finding
rules:
  - kind: deadConsumerBranch
    boundary: GET /legacy/health
    reason: legacy handler kept around for load balancer; intentional
    effect: mark  # still shown, doesn't count toward exit threshold
  - kind: unhandledProviderCase
    boundary: POST /users
    effect: downgrade  # error → warning; still counted, less severe
    reason: planned work in JIRA-1234
```

See the [Suppressions guide](/suppressions) for the full rule
syntax and the three effects (`mark` / `downgrade` / `hide`).

## What NOT to do

- **Don't run `suss check --fail-on info`.** Info-severity findings
  are advisory; failing on them produces churn without signal.
  Start at `error`, tighten to `warning` when the team is ready.
- **Don't commit the `summaries/` directory.** Extracted
  summaries are derived artifacts; regenerating them in CI keeps
  them current with the source. Do commit `.sussignore` — it's a
  curated list of decisions.
- **Don't run extract against a partial tsconfig.** If
  `include` in your tsconfig excludes source files, suss can't see
  them. Use the same tsconfig your build uses (or a superset).
- **Don't gate on `suss check` alone for breaking-change reviews.**
  Use `suss inspect --diff before.json after.json` in parallel —
  it shows which transitions changed, not just which pair
  mismatched.
