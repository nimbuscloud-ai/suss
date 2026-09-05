# Behavioral Summary Format

Version: **v0** (draft)

A behavioral summary is a structured, language-agnostic description of a code unit's behavior. It answers: *under what conditions does this function produce what outputs?*

The authoritative source of truth is the zod schema in [`packages/behavioral-ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/src/schemas.ts); the [`behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/schema/behavioral-summary.schema.json) JSON Schema is generated from it at build time and committed for non-TypeScript consumers (Python, Go, etc.) that want to validate without running JS.

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

Each element describes one code unit: a handler, client call site, loader, action, component, etc.

Every summary includes `schemaVersion`. A summary without one is
version 1, written by 0.3.x. The parsers in `@suss/behavioral-ir` read
every version ever published, so an artifact never needs rewriting.
Version 2 writes an unnamed identity field as null, rejects the empty
string there, and adds `"*"` as the REST method wildcard. Version 3
lets a parameter input's `role` be null, for a parameter whose role
suss could not work out. Version 4 replaces the `storage-relational`
variant with the layered `storage` one. Version 5 spells a store and a
bus the way OpenTelemetry's semantic conventions do. Version 6 is
current: a metric's measurement words are OpenTelemetry's as well,
`histogram` for a bucketed measurement, and `gauge`, `delta`,
`cumulative` for what one measurement covers.

## Core concept: transitions

A **transition** is a single execution path through the code unit. Every transition has:

- **conditions**: predicates that must all hold for this path to execute
- **output**: what the code unit produces (HTTP response, return value, thrown exception, rendered component)
- **effects**: side effects observed (database writes, API calls, event emissions)
- **isDefault**: true if this path executes when no other conditions match

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

Values in conditions and outputs are represented as `ValueRef`, a tree describing where a value comes from:

- `input`: a function parameter (`params.id`)
- `dependency`: result of a function call (`db.findById()`)
- `derived`: property access on another ref (`user.email`)
- `literal`: a known constant (`404`, `"not found"`)
- `state`: component/module state
- `unresolved`: could not resolve the origin

## Body shapes

Response bodies and expected inputs use `TypeShape`, a recursive type describing the structure of a value:

- `record`: object with known fields: `{ "type": "record", "properties": { "id": ..., "name": ... } }`
- `literal`: exact value: `{ "type": "literal", "value": "success" }`
- `ref`: type reference: `{ "type": "ref", "name": "User" }`
- `array`, `dictionary`, `union`, composite shapes
- `text`, `integer`, `number`, `boolean`, `null`, `undefined`, primitive type shapes
- `unknown`: shape could not be determined

## Boundary bindings

A boundary binding connects a code unit to an API endpoint. It has three layers: `transport` (the wire: `"http"`, `"in-process"`), `semantics` (a discriminated union of `rest`, `function-call`, `graphql-resolver`, and `graphql-operation`), and `recognition` (which pack matched the unit, or `"reachable"` for units found through transitive closure rather than by a pack pattern):

```json
{
  "transport": "http",
  "semantics": { "name": "rest", "method": "GET", "path": "/users/:id" },
  "recognition": "ts-rest"
}
```

Two summaries with matching `semantics` (each semantics pairs its own way: REST pairs by `(method, normalizedPath)`, and `function-call` pairs by `package::exportPath`) describe opposite sides of the same boundary, one provider and one consumer. This is how cross-boundary checking works: pair summaries by boundary, then compare transitions.

An identity field is null when the source never states it. A send
whose queue URL comes from a variable still appears:

```json
{ "name": "message-bus", "messageBus": "aws_sqs", "channel": null }
```

It pairs with nothing. A REST `method` of `"*"` means the handler
responds to every method, and it pairs with whatever method each
consumer uses.

### Route paths

A REST `path` is the route as the pack read it. A path a route
declares outright keeps its own spelling, so an Express route keeps
`:id`. A path suss had to work out, from a prefix a variable supplies
or a piece the code joins together, is written in the pattern grammar
below, and pairing normalizes every path to that grammar first. A
consumer that reads paths should expect either form.

| Spelling | Meaning |
| --- | --- |
| `/users/{id}` | one segment the code fills in at runtime |
| `/files/{tenant?}` | zero or one segment |
| `/files/{rest+}` | one or more segments |
| `/files/{rest*}` | zero or more segments, the same as a bare `*` segment |
| `(/api\|/api/v2)/orders` | one of the options, and an option may contain a slash |

A hole's name is what the code called it, or a placeholder such as
`value` when the expression had no name. Two paths pair when some request satisfies both, so
`/api/orders/{rest*}` pairs with a consumer of `/api/orders`, and
`(/api|/api/v2)/orders` pairs with a consumer of either option.

`recognition: "reachable"` marks library summaries produced by transitive closure: internal functions called from an entry point a pack recognised, but not themselves matched by any pack. They have no pairing identity yet, so nothing cross-checks them, but their transitions and effects are fully extracted.

## Effects and argument shape

Every transition has zero or more `effects` that fire on that path: mutations, emissions, state changes, and, most commonly, `invocation` effects that record a function call with its structured arguments:

```json
{
  "type": "invocation",
  "callee": "logger.error",
  "async": false,
  "args": [
    {
      "kind": "object",
      "fields": {
        "userId": { "kind": "identifier", "name": "userId" },
        "requestId": { "kind": "identifier", "name": "ctx.requestId" }
      }
    },
    { "kind": "string", "value": "pull request not found" }
  ]
}
```

The `EffectArg` union covers:

- **`string` / `number` / `boolean`**: resolved literal values
- **`object` / `array`**: composite shapes, kept even when individual field or element values are opaque (so the *shape* of a call's payload survives even when specific values don't)
- **`identifier`**: variable or property-access reference (`userId`, `user.profile.email`, `process.env.QUEUE_URL`, `config["host"]`). The `name` contains the full source text, so readers can tell which binding flowed in.
- **`call`**: nested call expression, so `log(formatError(e))` becomes `{ kind: "call", callee: "formatError", args: [...] }`.
- **`template`**: template literal with substitutions; the source text is kept, so `` `Error: ${e.message}` `` still shows how it was put together.
- **`null`**: truly opaque (type assertions with computed operands, arithmetic, etc.). The positional slot is kept, but the value has no structure.

Object and array shapes survive even when every field or element is opaque, so the *keys* a call supplied stay visible as evidence of what the caller meant to do. Throw terminals surface static message strings (`throw new Error("msg")` → `terminal.message: "msg"`) and template source text for interpolated messages.

### Throws: what's modelled, what isn't

Throw terminals describe what a function *explicitly* throws: `throw new Error("...")`, `throw new HttpError(...)`, etc. Bare rethrows inside a catch block (`try { ... } catch (e) { throw e }`) get `transition.metadata.rethrow.possibleSources` added to them, the union of throws from the call sites in the try body, taken from those callees' summaries (one hop, same project only).

One thing is not modelled today: *propagated* throws, the implicit throw paths of a function that calls a throwing callee without a try/catch. `function x() { y(); }` can throw whatever `y` throws, but the summary doesn't record that. Consumers who want full propagation can walk the transitive closure themselves, since the call graph is already in the summaries. This is a deliberate non-goal for v0. Modelling it faithfully runs into diminishing returns fast, because every function transitively calls something that can throw TypeError / RangeError / etc., and the question "where does the catalog of known throws end?" has no good answer. Revisit it when a concrete use case motivates a specific slice.

## Confidence

Every summary has a confidence level. A return the pack could not make sense of sets it to **low** outright, since nothing then describes what that path produces. Otherwise it comes from how much of the code was decomposed versus marked opaque:

- **high**: all conditions decomposed into structured predicates
- **medium**: some opaque predicates (< 50%)
- **low**: most predicates are opaque (>= 50%)

Tools consuming summaries can use confidence to decide how much to trust the analysis.

## Gaps

A gap is something the summary could not account for. One kind says the code has a hole; the other two say suss could not read part of it.

**`unhandledCase`** says the code has a hole. Either the contract declares a response that no transition produces, or a transition produces a status the contract never declared:

```json
{
  "type": "unhandledCase",
  "consequence": "frameworkDefault",
  "description": "Declared response 500 is never produced by the handler"
}
```

The checker reports these as `providerContractViolation` at error severity.

**`unreadOutcome`** says the analysis has a hole. A `return` matched none of the terminal shapes the pack looks for, so nothing here describes what it produces:

```json
{
  "type": "unreadOutcome",
  "consequence": "unknown",
  "description": "One return in this function matches none of the terminal shapes this pack looks for, so what it produces is not described here"
}
```

The handler may be responding perfectly well in a form nobody taught the pack, so the checker reports `lowConfidence` at info severity instead of blaming the code.

**`unfollowedCall`** says the walk stopped. A call could not be resolved to a function with a body, so whatever runs behind it is missing from this summary:

```json
{
  "type": "unfollowedCall",
  "consequence": "unknown",
  "description": "The call to this.dao.getEditions lands on a declaration with no body, so whatever runs there is missing from this summary"
}
```

Without it, a service reaching its database through an injected interface produces the same empty summary as a service that touches nothing. Only a call whose callee the project itself declares is recorded; a call into a dependency is described elsewhere, as a boundary crossing.

## Metadata

The `metadata` field contains framework-specific data that doesn't fit the universal structure. Keys are **namespaced by boundary semantics** so that additional semantics (GraphQL, Lambda-invoke, queue messages) can use their own sibling namespaces without clashing with HTTP-scoped keys. HTTP-scoped entries live under `metadata.http.*`:

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
      "statusAccessors": ["status"],
      "failureDelivery": "exception"
    }
  }
}
```

- `http.declaredContract`: the response schema the pack declared (status codes plus body shapes). Frameworks that read a contract, like ts-rest, fill this in. A source that declares a response by class rather than by one code (OpenAPI's `4XX`) records it under `responseRanges` (`{ min, max, spec, body }`), and an OpenAPI `default` becomes `defaultResponse`; the checker treats any status inside a range, or any status at all under a `default`, as declared.
- `http.bodyAccessors`: names of the response properties the consumer uses to read the body (`.data` for axios, `.body`/`.json()` for fetch). These let the cross-boundary checker unwrap `expectedInput` correctly.
- `http.statusAccessors`: names of the response properties the consumer uses to read the status code. These let the checker recognise pack-specific names beyond the historical `["status", "statusCode"]`.
- `http.failureDelivery`: `"response"` when a refused request comes back as a response the caller reads a status off, which is `fetch`, and `"exception"` when it rejects, which is axios and ky. On `"exception"` the consumer's `catch` is the branch every non-2xx arrives on, and the coverage check counts it as handling them.

Semantics-neutral keys (valid for every boundary kind) stay at the top level, e.g. `metadata.derivedFromWrapper` on summaries that came out of wrapper expansion.

Tools that don't need metadata can ignore it entirely. See [`boundary-semantics.md`](boundary-semantics.md) for the layered model this naming convention anticipates.

## Consuming summaries

Summaries are designed for machine consumption. Common operations:

- **Enumerate transitions**: iterate `transitions[]` to see every execution path
- **Check coverage**: compare provider transition statuses against consumer condition literals
- **Inspect body shapes**: read `output.body` to see what fields are returned
- **Pair boundaries**: for HTTP boundaries, group summaries by `identity.boundaryBinding.(method, path)` to find provider/consumer pairs. Each semantics has its own pairing key; non-REST semantics added later will pair by their own identity (GraphQL operation name, Kafka topic, Lambda function name, etc.). See [`boundary-semantics.md`](boundary-semantics.md).
- **Detect drift**: compare summaries from two points in time using transition IDs

The format is stable enough to build on. Pin your tools to `v0` and check the schema version before parsing.

For `suss inspect`'s human-readable rendering, the form you would paste
into a review or an AI prompt, see [the inspect format stability section](/reference/cli#format-stability).
The JSON is canonical; the text rendering is written for people to read
and is not meant to be parsed.

## What you can build on this

The behavioral summary is a foundation, not an endpoint. Some things it enables:

- **Documentation generation**: render summaries as human-readable API behavior docs
- **AI context enrichment**: feed summaries to coding agents so they understand endpoint behavior without reading source
- **Test case enumeration**: each transition is a test case; conditions are the setup, output is the expected result
- **Impact analysis**: when a handler's summary changes, trace which consumers are affected via boundary bindings
- **Architectural visibility**: aggregate summaries across a codebase to map which services talk to which endpoints and how

## Publishing summaries

Summaries travel well: `suss extract` produces relative file paths, and the format contains no machine-specific data. A library author can publish pre-built summaries alongside their package, and consumers get cross-boundary checking without the library's source code.

### Convention

Add a `suss` field to your `package.json` pointing to the summary file:

```json
{
  "name": "my-api",
  "suss": {
    "summaries": "./dist/suss-summaries.json"
  }
}
```

Then extract and include the file in your published package. For plain public APIs, meaning any function reachable through the package's `exports` / `main` / `module` / `types`, the `packageExports` discovery variant produces one summary per public export, so you never have to list the exports by hand:

```js
// build-summaries.mjs
import { createTypeScriptAdapter } from "@suss/adapter-typescript";

const pack = {
  name: "package-exports:my-api",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [{
    kind: "library",
    match: {
      type: "packageExports",
      packageJsonPath: new URL("./package.json", import.meta.url).pathname,
    },
  }],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw",  match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const adapter = createTypeScriptAdapter({
  tsConfigFilePath: "./tsconfig.json",
  frameworks: [pack],
});
fs.writeFileSync("dist/suss-summaries.json", JSON.stringify(adapter.extractAll(), null, 2));
```

APIs built on a framework (Express / ts-rest / Apollo resolvers / …) use a framework pack in place of `packageExports`, and they produce REST- or GraphQL-semantics bindings the same way.

suss itself does this: `scripts/dogfood.mjs` runs the same setup against every `@suss/*` package. A package that means to publish its contract writes it into `dist/` alongside the build, as above. The dogfood run only analyses this repo locally and nothing reads the output back, so it writes to `<pkg>/.suss/suss-summaries.json` instead, next to the extraction cache and outside anything npm ships. See `docs/internal/dogfooding.md` for the run output.

Consumers can check against published summaries directly:

```sh
suss check node_modules/my-api/dist/suss-summaries.json my-consumer-summaries.json
```

### Community-maintained summaries

For libraries that don't publish their own summaries, a community repository can maintain them, the way DefinitelyTyped maintains type definitions. The same `BehavioralSummary[]` format applies; only where the summaries came from is different.

### Summaries without source code

When source code isn't available, a summary can be authored by hand (`confidence.source: "declared"`) or generated from a contract or documentation (`confidence.source: "derived"`). Set `confidence.level` to reflect how much to trust it:

```json
{
  "confidence": { "source": "declared", "level": "low" }
}
```

Tools can use this to adjust how much they trust the summary.

## Schema

Two consumption paths:

- **TypeScript / JavaScript:** install `@suss/behavioral-ir` (one peer dep on `zod`) and call `parseSummaries(json)` to validate and narrow in one step, or `safeParseSummaries(json)` to handle errors without throwing. The types (`BehavioralSummary`, `Transition`, `Predicate`, …) come from the same schemas via `z.infer`.
- **Other languages:** validate against [`packages/behavioral-ir/schema/behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/schema/behavioral-summary.schema.json). The build generates it from the zod schema (`npm run build` in `packages/behavioral-ir/`), so it always matches the runtime parsers and nobody edits it by hand.
