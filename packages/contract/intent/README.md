# @suss/contract-intent

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package reads intent specs your team writes (`*.intent` / `*.prd`, YAML
or JSON) into `IntentSummary[]`, which the intent checker pairs with the
summaries derived from code.

## What this is

The layer that reads intent files. An intent spec declares what a
boundary *should* do (system intent), or the scenarios people expect a
feature to satisfy (PRD outcome intent). This package finds the files
and directories and parses the YAML or JSON. The schema, and the
conversion to `IntentSummary`, are in [`@suss/intent-ir`](../../intent-ir).

Unlike the other contract readers, intent does **not** produce
`BehavioralSummary`. It has its own type and its own checker. The full
design is in
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

The CLI loads intent through `suss check --intent <dir>`. Intent is
checked against code, so `suss contract` does not write it out.

## Spec shape

There are two kinds, told apart by the top-level `kind`. System intent:

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

Each transition declares exactly one outcome: `response` (a REST status
and body), `returns` (a function or handler return value), or `throws`
(an error). PRD docs (`kind: prd`) contain `when` / `expect` scenarios,
and each scenario can `link` to a system-intent outcome by
`<name>.<id>`.

Body properties accept the primitive type names `string`, `integer`,
`number`, `boolean`, `null` and `unknown`.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-intent.svg)

## License

Apache-2.0
