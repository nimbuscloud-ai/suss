---
title: Run suss in GitHub Actions on every pull request
description: Post what a pull request changes about each boundary as a comment, and fail the job when a caller and its provider disagree.
---

# Set up CI checking

Two jobs. The first posts what the pull request changes about each
boundary as a comment, so the reviewer reads the behavior instead of
the diff. The second extracts both sides of your boundaries and
compares them, and exits non-zero when a provider returns a status no
client handles or a query asks for a field the schema never declared.

## Post the behavior diff on the pull request

```yaml
name: suss

on: [pull_request]

jobs:
  behavior-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        with:
          extract: -p tsconfig.json -f hono -f prisma
```

The action runs `suss extract` at the head of the pull request, checks
the base commit out beside it and runs the same extract there, then
posts `suss inspect --diff` between the two as one comment. A later
push edits the same comment. `extract` takes whatever you would type
after `suss extract` on your own machine; for Python that is
`--dir src -f fastapi`.

A pull request from a fork gets a read-only token, so the comment
cannot be posted there and the diff stays in the job log. The
[action's README](https://github.com/nimbuscloud-ai/suss/blob/main/.github/actions/inspect-diff/README.md)
lists every input, the outputs a later step can read, and how to turn
the comment off for forks.

## Run it earlier than this, too

A merge gate is the one thing nobody talks their way past, so keep
it. It is the wrong place to find out, though: by the time it runs,
every decision has been made and the only thing left to do is
reject.

The same commands are worth more in the review step right after the
code is written, before anything is pushed. The tree is complete
there, and a finding routes straight back into another round of
editing rather than into a failed build. That matters most where an
agent writes the code: it will satisfy every gate it can see, and a
fact it gets before it decides changes what it writes.

So run `check` and `inspect --diff` in whatever loop produces your
code, and keep the jobs on this page as the backstop.

## Fail the job on a finding

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

## Several boundaries at once

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
`gql:Query.pet`, etc.). The two sides don't have to come from the
same kind of source. A provider read out of an OpenAPI contract
pairs with a consumer read out of axios call sites.

## JSON output for downstream tooling

`--json` emits findings as JSON rather than human text, for a
dashboard or a reporting step of your own:

```yaml
- id: check
  run: npx suss check --dir summaries/ --json -o findings.json
  continue-on-error: true

- name: Count the errors
  if: always()
  run: node -e 'const r = require("./findings.json"); console.log(r.findings.filter((f) => f.severity === "error").length)'
```

`check --json` writes one object, not a bare array. `findings` is the
IR's `Finding[]`, the same type the checker exports, and the other
keys describe the run around it: `pairs`, `unmatched`,
`runtimeNamedCrossings`, `summariesWithGaps` and `collisions`. A
downstream tool wants `.findings`. It can validate against
`@suss/behavioral-ir`'s exported schema or the generated JSON Schema
(`packages/behavioral-ir/schema/behavioral-summary.schema.json`).

## Suppressing known-accepted findings

Not every finding needs to fail the build. Maybe a legacy endpoint
returns 500 on timeout and the team has accepted that, or a
`deadConsumerBranch` covers a status the server has never actually
produced. The `.sussignore` file keeps these exceptions, and each
one comes with a written reason:

```yaml
# .sussignore.yml at the project root: one rule per accepted finding
version: 1
rules:
  - kind: deadConsumerBranch
    boundary: GET /legacy/health
    reason: legacy handler kept around for load balancer; intentional
    effect: mark  # still shown, doesn't count toward exit threshold
  - kind: boundaryFieldUnknown
    boundary: POST /users
    effect: downgrade  # one severity lower; still counted
    reason: planned work in JIRA-1234
```

See the [Suppressions guide](/suppressions) for the full rule
syntax and the three effects (`mark` / `downgrade` / `hide`).

## What NOT to do

- **Don't run `suss check --fail-on info`.** Info-severity findings
  are advisory; failing on them produces churn without signal.
  Start at `error`, tighten to `warning` when the team is ready.
- **Don't commit the `summaries/` directory.** Extracted
  summaries are derived artifacts, and regenerating them in CI
  keeps them current with the source. Do commit `.sussignore`,
  because it's a curated list of decisions.
- **Don't run extract against a partial tsconfig.** If
  `include` in your tsconfig excludes source files, suss can't see
  them. Use the same tsconfig your build uses (or a superset).
- **Don't gate on `suss check` alone for breaking-change reviews.**
  Run the behavior diff beside it: it shows which transitions changed,
  rather than which pair mismatched. The action at the top of this
  page posts it; `suss inspect --diff before.json after.json --json`
  is the same diff for something other than a person to read.
- **A check that pairs nothing fails.** It has nothing to report,
  which looks the same as both sides agreeing, so `suss check --dir
  summaries/` exits non-zero when that happens. Pass `--allow-empty`
  when an empty run is expected, such as checking one side of a
  boundary before the other side has been extracted.
- **Emit the finding, not only the status.** A red check with
  nothing parseable behind it gives an automated fixer nothing to
  act on. Write the JSON somewhere the same job can read.
