# Behavioral Summary Format

Version: **v0** (draft)

A behavioral summary is a structured, language-agnostic description of a code unit's behavior. It answers: *under what conditions does this function produce what outputs?*

This document describes the JSON format. The authoritative source of truth is the zod schema in [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts); the [`behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/schema/behavioral-summary.schema.json) JSON Schema is generated from it at build time and committed for non-TypeScript consumers (Python, Go, etc.) that want to validate without running JS.

## File format

A summary file is a JSON array of `BehavioralSummary` objects:

```json
[
  {
    "kind": "handler",
    "identity": { "name": "getUser", "boundaryBinding": { "method": "GET", "path": "/users/:id", ... } },
    "transitions": [ ... ],
    ...
  }
]
```

Each element describes one code unit — a handler, client call site, loader, action, component, etc.

## Core concept: transitions

A **transition** is a single execution path through the code unit. Every transition has:

- **conditions** — predicates that must all hold for this path to execute
- **output** — what the code unit produces (HTTP response, return value, thrown exception, rendered component)
- **effects** — side effects observed (database writes, API calls, event emissions)
- **isDefault** — true if this path executes when no other conditions match

A handler with three `if` guards and a fallback produces four transitions.

```json
{
  "id": "getUser:response:404:a1b2c3d",
  "conditions": [
    { "type": "nullCheck", "subject": { "type": "dependency", "name": "db.findById", "accessChain": [] }, "negated": false }
  ],
  "output": {
    "type": "response",
    "statusCode": { "type": "literal", "value": 404 },
    "body": { "type": "record", "properties": { "error": { "type": "literal", "value": "not found" } } },
    "headers": {}
  },
  "effects": [],
  "isDefault": false
}
```

## Conditions and predicates

Conditions are structured when the extractor can decompose them, opaque when it can't. A structured predicate tree preserves the logic; an opaque predicate preserves the source text. Downstream tools can reason about structured predicates and treat opaque ones conservatively.

| Predicate type | Meaning | Example |
|---------------|---------|---------|
| `nullCheck` | Subject is/isn't null | `user == null` |
| `truthinessCheck` | Subject is truthy/falsy | `!params.id` |
| `comparison` | Two values compared | `status === 404` |
| `typeCheck` | Runtime type check | `typeof x === "string"` |
| `propertyExists` | Object has a property | `"email" in user` |
| `compound` | AND/OR of sub-predicates | `a && b` |
| `negation` | Logical NOT | `!(isValid(x))` |
| `call` | Function call as predicate | `isAdmin(user)` |
| `opaque` | Could not decompose | preserved source text |

## Value references

Values in conditions and outputs are represented as `ValueRef` — a tree describing where a value comes from:

- `input` — a function parameter (`params.id`)
- `dependency` — result of a function call (`db.findById()`)
- `derived` — property access on another ref (`user.email`)
- `literal` — a known constant (`404`, `"not found"`)
- `state` — component/module state
- `unresolved` — could not resolve the origin

## Body shapes

Response bodies and expected inputs use `TypeShape` — a recursive type describing the structure of a value:

- `record` — object with known fields: `{ "type": "record", "properties": { "id": ..., "name": ... } }`
- `literal` — exact value: `{ "type": "literal", "value": "success" }`
- `ref` — type reference: `{ "type": "ref", "name": "User" }`
- `array`, `dictionary`, `union` — composite shapes
- `text`, `integer`, `number`, `boolean`, `null`, `undefined` — primitive type shapes
- `unknown` — shape could not be determined

## Boundary bindings

A boundary binding connects a code unit to an API endpoint:

```json
{
  "protocol": "http",
  "method": "GET",
  "path": "/users/:id",
  "framework": "ts-rest"
}
```

Two summaries with matching `(method, path)` describe opposite sides of the same boundary — a provider and a consumer. This is how cross-boundary checking works: pair summaries by boundary, then compare transitions.

## Confidence

Every summary has a confidence level computed from how much of the code was structurally analyzed versus marked opaque:

- **high** — all conditions decomposed into structured predicates
- **medium** — some opaque predicates (< 50%)
- **low** — most predicates are opaque (>= 50%)

Tools consuming summaries can use confidence to decide how much to trust the analysis.

## Gaps

Gaps represent cases the code unit doesn't handle:

```json
{
  "type": "unhandledCase",
  "consequence": "frameworkDefault",
  "description": "Declared response 500 is never produced by the handler"
}
```

When a contract declares a status code that no transition produces, the gap tells you the code has a behavioral hole.

## Metadata

The `metadata` field carries framework-specific data that doesn't fit the universal shape. Keys are **namespaced by boundary semantics** so additional semantics (GraphQL, Lambda-invoke, queue messages) can use their own sibling namespaces without clashing with HTTP-scoped keys. HTTP-scoped entries live under `metadata.http.*`:

```json
{
  "metadata": {
    "http": {
      "declaredContract": {
        "framework": "ts-rest",
        "responses": [
          { "statusCode": 200, "body": { "type": "record", "properties": { ... } } },
          { "statusCode": 404 }
        ]
      },
      "bodyAccessors": ["data"],
      "statusAccessors": ["status"]
    }
  }
}
```

- `http.declaredContract` — pack-declared response schema (status codes + body shapes). Populated by contract-reading frameworks like ts-rest.
- `http.bodyAccessors` — names of response properties the consumer uses to read the body (`.data` for axios, `.body`/`.json()` for fetch). Lets the cross-boundary checker unwrap `expectedInput` correctly.
- `http.statusAccessors` — names of response properties the consumer uses to read the status code. Lets the checker recognise pack-specific names beyond the historical `["status", "statusCode"]`.

Semantics-neutral keys (valid for every boundary kind) stay at the top level — e.g. `metadata.derivedFromWrapper` on wrapper-expansion-produced summaries.

Tools that don't need metadata can ignore it entirely. See [`boundary-semantics.md`](boundary-semantics.md) for the layered model this namespacing anticipates.

## Consuming summaries

Summaries are designed for machine consumption. Common operations:

- **Enumerate transitions** — iterate `transitions[]` to see every execution path
- **Check coverage** — compare provider transition statuses against consumer condition literals
- **Inspect body shapes** — read `output.body` to see what fields are returned
- **Pair boundaries** — for HTTP boundaries, group summaries by `identity.boundaryBinding.(method, path)` to find provider/consumer pairs. The pairing key is semantics-specific; future non-REST semantics will pair by their own identity (GraphQL operation name, Kafka topic, Lambda function name, etc.). See [`boundary-semantics.md`](boundary-semantics.md).
- **Detect drift** — compare summaries from two points in time using transition IDs

The format is stable enough to build on. Pin your tools to `v0` and check the schema version before parsing.

## What you can build on this

The behavioral summary is a foundation, not an endpoint. Some things it enables:

- **Documentation generation** — render summaries as human-readable API behavior docs
- **AI context enrichment** — feed summaries to coding agents so they understand endpoint behavior without reading source
- **Test case enumeration** — each transition is a test case; conditions are the setup, output is the expected result
- **Impact analysis** — when a handler's summary changes, trace which consumers are affected via boundary bindings
- **Architectural visibility** — aggregate summaries across a codebase to map which services talk to which endpoints and how

## Publishing summaries

Summaries are portable — `suss extract` produces relative file paths, and the format contains no machine-specific data. This means a library author can publish pre-built summaries alongside their package, and consumers get cross-boundary checking without the library's source code.

### Convention

Add a `suss` field to your `package.json` pointing to the summary file:

```json
{
  "name": "my-api",
  "suss": {
    "summaries": "./suss-summaries.json"
  }
}
```

Then extract and include the file in your published package:

```sh
suss extract -p tsconfig.json -f express -o suss-summaries.json
```

Consumers can check against published summaries directly:

```sh
suss check node_modules/my-api/suss-summaries.json my-consumer-summaries.json
```

### Community-maintained summaries

For libraries that don't publish their own summaries, a community repository can maintain them — similar to DefinitelyTyped for type definitions. The same `BehavioralSummary[]` format applies; the summaries come from a different source.

### Stub summaries

When source code isn't available, summaries can be written by hand or generated from documentation. Set `confidence.source` to `"stub"` and `confidence.level` to `"low"` to signal that the summary wasn't extracted from code:

```json
{
  "confidence": { "source": "stub", "level": "low" }
}
```

Tools can use this to adjust how much they trust the summary.

## Schema

Two consumption paths:

- **TypeScript / JavaScript:** install `@suss/behavioral-ir` (one peer dep on `zod`) and use `parseSummaries(json)` for validate-and-narrow, or `safeParseSummaries(json)` to handle errors without throwing. Types (`BehavioralSummary`, `Transition`, `Predicate`, …) are derived from the same schemas via `z.infer`.
- **Other languages:** validate against [`packages/ir/schema/behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/schema/behavioral-summary.schema.json). It is generated from the zod schema at build time (`npm run build` in `packages/ir/`), so it is always in sync with the runtime parsers and never hand-edited.
