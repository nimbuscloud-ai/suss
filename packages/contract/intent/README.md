# @suss/contract-intent

Read team-authored intent specs and turn them into suss
behavioural summaries for comparison against derived code summaries.

## What this is

An intent spec is a structured declaration of what a boundary *should*
do — the team's intent, written in the same shape suss derives from
code. The pair-against-code comparison answers "did we ship what we
meant?" before the PR lands.

The format is documented in
[`docs/internal/proposals/intent-specs.md`](../../../docs/internal/proposals/intent-specs.md).
This package implements the v0 reader: REST boundaries, single-status
transitions, object-shaped bodies.

## Usage

```bash
npx suss contract --from intent intents/users.intent.yaml -o intent.json
# or walk a directory of *.intent.{yaml,yml,json}
npx suss contract --from intent intents/ -o intent.json
```

Or programmatically:

```ts
import {
  intentSpecToSummaries,
  intentSpecFileToSummaries,
  intentSpecDirectoryToSummaries,
} from "@suss/contract-intent";

const summaries = intentSpecFileToSummaries("intents/users.intent.yaml");
```

## Spec shape (v0)

```yaml
boundary:
  transport: http
  semantics: rest
  method: GET
  path: /users/:id

purpose: "Look up a single user by id."
audience: web-client

transitions:
  - when: "user not found"
    output:
      status: 404
      body:
        properties:
          error: { type: string }

  - when: "user exists"
    output:
      status: 200
      body:
        properties:
          id: { type: string }
          fullName: { type: string }
```

Both `purpose` and `audience` are required. The last transition in
the list is treated as the default (no opaque predicate); earlier
ones carry their `when` text as an opaque predicate the checker
pairs by terminal kind + status code.

Body properties accept the primitive type names `string`, `integer`,
`number`, `boolean`, `null`, and `unknown`. Nested objects, arrays,
and unions are deferred to v1.
