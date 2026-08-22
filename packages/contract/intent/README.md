# @suss/contract-intent

Read team-authored intent specs (`*.intent` / `*.prd`, YAML or JSON) into
`IntentSummary[]` for the intent checker to pair against derived code.

## What this is

The file-reading layer for intent. An intent spec declares what a
boundary *should* do (system intent) or the human scenarios a feature
*should* satisfy (PRD outcome intent). This package handles file and
directory discovery plus YAML / JSON parsing; the schema and the
normalisation to `IntentSummary` live in [`@suss/intent-ir`](../../intent-ir).

Unlike the other contract readers, intent does **not** produce
`BehavioralSummary`; it's a separate citizen with its own type and its
own checker. The full design is in
[`design/proposals/intent-specs.md`](../../../design/proposals/intent-specs.md).

## Usage

```ts
import {
  loadIntentDoc,
  loadIntentFile,
  loadIntentDirectory,
} from "@suss/contract-intent";

const one = loadIntentFile("intents/users.intent.yaml"); // IntentSummary
const all = loadIntentDirectory("intents/"); // IntentSummary[]
```

The CLI loads intent through `suss check --intent <dir>` (intent is
checked against code, not emitted as a contract).

## Spec shape

Two kinds, discriminated by the top-level `kind`. System intent:

```yaml
kind: boundary
name: users-lookup
purpose: Look up a single user by id.
audience: web-client
boundary:
  transport: http
  semantics: rest        # or function-call
  method: GET
  path: /users/:id
transitions:
  - id: not-found
    when: user not found
    response:
      status: 404
      body:
        properties:
          error: { type: string }
  - id: found
    when: user exists
    response:
      status: 200
      body:
        properties:
          id: { type: string }
          fullName: { type: string }
```

Each transition declares exactly one outcome: `response` (REST status +
body), `returns` (a function/handler return value), or `throws` (an
error). PRD docs (`kind: prd`) contain `when` / `expect` scenarios that
can `link` to a system-intent outcome by `<name>.<id>`.

Body properties accept the primitive type names `string`, `integer`,
`number`, `boolean`, `null`, and `unknown`.

## Coverage

![coverage](../../../.github/badges/coverage-contract-intent.svg)

## License

Apache-2.0
