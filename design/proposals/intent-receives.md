# Intent: declare what a boundary receives

## The problem

A boundary intent says what a boundary returns and what it does, and nothing about what it is handed. That is true for all five boundary kinds the schema accepts. The docs under `intent/` describe checker functions and cannot say that `checkPair` needs a provider summary and a consumer summary. A route intent cannot say that a tenant header is required. A queue consumer intent cannot say which fields of the message it depends on.

The schema does let an author write a condition on the input:

```yaml
transitions:
  - id: missing-tenant
    when:
      - input: request.headers.x-tenant-id
        is: missing
    response:
      status: 401
```

The checker parses that clause and then ignores it. The outcome pass keeps only clauses whose subject is a boundary (`c.at !== null`), so the 401 outcome is satisfied by any branch that returns 401 for any reason. And a block the author adds under `boundary:` to describe the input is dropped without a message, because every boundary schema is a plain `z.object` and zod strips unknown keys.

## Proposal

Add a `receives` block to every boundary kind. It lists the fields of the value the boundary is handed, with a shape and whether the field is required. The checker compares it against the paths the unit reads off that value, using the read-set rule the message-bus and render checks already run. An `input:` clause then resolves to one of the declared fields and is compared against the branch's own predicate.

### Format

A function-call boundary declares its arguments by parameter name:

```yaml
kind: boundary
name: checker-check-pair
boundary:
  semantics: function-call
  package: "@suss/checker"
  exportPath: ["checkPair"]
  receives:
    pair.provider: { type: object, required: true }
    pair.consumer: { type: object, required: true }
    options.stream: { type: string }
```

A message-bus boundary declares the fields of the message body:

```yaml
boundary:
  semantics: message-bus
  messageBus: aws-sqs
  channel: orders
  receives:
    orderId: { type: string, required: true }
    items: { type: array, items: { type: object } }
```

A REST boundary declares the four parts of a request. `headers`, `query` and `params` are maps from name to field; `body` is a shape:

```yaml
boundary:
  semantics: rest
  method: POST
  path: /invoices/:id/settle
  receives:
    headers:
      x-tenant-id: { type: string, required: true }
    query:
      dryRun: { type: boolean }
    body:
      type: object
      properties:
        note: { type: string }
```

Path parameters come from the `path` template and are not declared. A field is a name, and optionally a shape and a `required` flag (default false), so `x-tenant-id: { required: true }` and a bare `orderId: {}` are both complete declarations. The block lists only the fields the author wants checked. It does not have to describe the whole input, and a field the code reads that the block leaves out is reported at info and no higher. A document with no `receives` block says nothing about the input, the same way a document with no `results` says nothing about effects.

Every boundary schema in `@suss/intent-ir` becomes `z.strictObject`. This rejects unknown keys only; the fields that are optional today stay optional, so the unkeyable-but-authorable state the function-call comment describes is unchanged. A misspelt `recieves:` stops the run with the key named, the way a misspelt `results:` already does. suss is pre-1.0, so there is no compatibility shim.

### Normalized form

`BoundaryIntentSummary` gains `receives: IntentInputField[]`:

```ts
interface IntentInputField {
  path: string[];
  shape: TypeShape | null;
  required: boolean;
}
```

Every spelling above normalizes to that list. `pair.provider` becomes `["pair", "provider"]`. The REST sections become paths whose first segment is the section: `["headers", "x-tenant-id"]`, `["query", "dryRun"]`, `["body", "note"]`. The checker has one pass over the list and never looks at the boundary kind.

### Comparison

`readSetOf(summary, carriesPayload)` in the checker's `receive/inputContract.ts` gives every path a unit reads off its inputs, outermost segment first, and returns a stand-down when it cannot tell (`rest-parameter`, `payload-used-whole`, `no-reads`). Its header says it is one rule for every protocol, and the two callers today are the message-bus pairing and the render-props check. The per-kind part is the `carriesPayload` predicate (which input is the value) and, for a bus, the envelope table that maps a declared field to its position inside the platform's record.

The intent pass needs the same two things per kind:

- function-call: every parameter is part of the value, and a declared path `["pair", "provider"]` is a read path as-is, because `readSetOf` already prefixes a parameter read with the parameter's name.
- message-bus: the message parameter is the value, through the envelope table the pairing already has.
- rest: the request parameter is the value, and each REST pack declares how the four sections are spelled in its handler. Express and Fastify read `request.headers[...]`, so the read path is the declared path under the request role. Lambda reads `event.headers`, `event.queryStringParameters` and `JSON.parse(event.body)`. FastAPI takes a header as a function parameter annotated `Header()`, so the pack has to declare which parameter is which header. Rails reads `params[:id]` and `request.headers[...]` through methods on the controller, which are not input reads today. Each pack supplies a mapping from a declared REST path to the read paths that spell it, or declares that the section is not observable. Header names compare case-insensitively.
- storage and unit-invocation: `receives` is accepted and normalized, and the pass reports `unkeyableBoundary` as it does for everything else on those kinds.

`checker-intent` does not depend on `@suss/checker`. `readSetOf` imports only types from `@suss/behavioral-ir`, so it moves there and the checker re-exports it. The REST per-pack mapping lives on the pack, next to the parameter roles it already declares.

Two findings, in the `intent` stream:

- `unreadInputField` (warning when `required`, info otherwise): the intent declares a field and no transition of the unit reads its path, or a prefix of it. The message says which field and which unit.
- `undeclaredInputRead` (info): the unit reads a path the `receives` block does not list. It is reported only when the block exists, because an absent block means the author stated nothing, and that differs from an empty block. For REST, `body` reads are exempt when the block declares a body shape. The shape describes the body, so a read of `body.items[0].sku` is a question for the shape and does not mean a declaration is missing.

A read of the value as a whole (`schema.parse(req.body)`, or a function that forwards its argument) is `payload-used-whole`, and the pass reports nothing on that intent. Comparing a declared body against a validator schema is a separate piece of work and is not in this proposal.

The route guard for a required header is often in middleware instead of the handler. A fixture will show whether the express pack folds middleware conditions into a route's summary, and we check that before the REST PR is briefed. If it does not, `unreadInputField` on REST is reported only when the read set has at least one read under the same section, so a handler that never touches headers because middleware reads them is not reported.

### Conditions with an `input:` subject

`IntentCondition.input` is a dotted path today and stays one. Normalization resolves it against the declared `receives` fields, and a path that matches none is a load error ("`request.headers.x-tenant` is not declared under `receives`"). The REST spelling drops the `request.` prefix so the clause and the block agree: `input: headers.x-tenant-id`. An `input:` clause with no `receives` block is also an error, since the clause has to point at something.

In the outcome pass, a clause with `input` set counts as stated, next to the boundary clauses. It is met by a code transition with a predicate on the `input` ValueRef at that path:

| clause | predicate |
|---|---|
| `is: missing` | `nullCheck` or `truthinessCheck` on the path, with the polarity the extractor emits for `if (!x)` |
| `is: set` | the same, opposite polarity |
| `equals: v` | `comparison` with `===` or `==` against the literal `v` |
| `has: p` | `propertyExists` with property `p` |

A test against the extractor's output for `if (!req.headers["x"]) return 401` settles the polarity. Reading the schema is not enough. `where` stays prose. A branch whose only predicate on the path is `opaque` meets a clause with no check and fails one that states a check, and the message says the code's condition could not be read.

The finding is the existing `uncoveredOutcome`, through `unmetConditionMessage`, which already says which clause no branch turned on. It needs no new kind.

### Drafting

`suss infer intent` writes the `receives` block from the read set: every path the unit reads, `required: true` when a transition rejects (a 4xx, a throw, or a null return) on a `nullCheck` or `truthinessCheck` of that path, and a shape from `expectedInput` when the extractor produced one. An `input:` clause is drafted for each such rejecting transition. The draft shows the author what the code reads, so curating it means deleting lines instead of writing them.

### Dogfooding

The five docs under `intent/` get a `receives` block in the first PR, so `check:self` exercises the pass on function-call boundaries from the day it lands. The fastify example under `design/proposals/intent-layer-examples/` gets one when the REST spelling ships.

### Docs

The intent guide (`docs/guides/check-against-intent.md`) gets a section on `receives` and on `input:` clauses, with the function-call and REST spellings. `docs/reference/findings.md` gets the two kinds.

## Demo

A route reads `x-tenant-id` and returns 401 when it is missing, with the intent above. `suss check --intent` is quiet. Change the read to `x-tenant`, keeping the 401. Today the run stays quiet, because any 401 satisfies the outcome. After this change it reports `unreadInputField` for `headers.x-tenant-id`, `undeclaredInputRead` for `headers.x-tenant`, and `uncoveredOutcome` for `missing-tenant` with the clause in the message.

The same demo on suss itself: drop the `pair.consumer` read from `checkPair` and `check:self` fails.

## Sequencing

Three PRs, in order, one opus builder each; the next brief is written after the previous PR merges.

1. Schema strictness, the `receives` block for every kind, normalization, `readSetOf` moved to `@suss/behavioral-ir`, the two findings for function-call and message-bus, `infer intent` drafting the block, `intent/` docs updated, findings reference. Dogfooded by `check:self`.
2. The REST spelling, the per-pack request mapping for express, fastify, hono, nestjs, aws-lambda, fastapi, flask-restx, rails and sinatra, the result of the middleware check, the fastify example, the intent guide section.
3. `input:` clauses resolved and compared on every kind, `infer intent` drafting them.

## Alternatives considered

We considered a REST-only `request` block with `headers`, `query`, `params` and `body`, with other kinds added later. The only intent docs written so far are function-call boundaries, so a REST-first block would not be dogfooded, and the read-set rule is already kind-agnostic. The REST sections are one spelling of the generic block instead.

We considered reusing OpenAPI's `parameters` list (`in`, `name`, `schema`) for the REST spelling. It is a list of records, which reads badly in YAML for the three-field case, and its `in` value is what the section name already says. The OpenAPI reader can convert one form to the other if a later step drafts intent from a spec.

We considered expressing the input only through `when` clauses, with no `receives` block. A `when` clause says what a branch tests, so it can say nothing about a field no branch tests, and a typo in an `input:` path would have nothing to resolve against. The `receives` block is where a field gets a name, and a name alone is enough; how much more to say about it is the author's call.

We considered a body-shape mismatch finding through `checkBodiesAgainstDeclared` against `expectedInput`. The handlers that validate their body hand it to a validator whole, which is a stand-down, so the finding would fire on hand-rolled reads only. Left out until intent can be compared against a validator schema.

We considered making `undeclaredInputRead` a warning. A handler often reads a header for logging or tracing that no author would declare, so info is the right level until an author has a way to say "and nothing else".
