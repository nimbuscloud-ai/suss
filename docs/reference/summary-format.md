---
title: Summary format
description: The JSON a suss run writes, field by field, and what a downstream tool can rely on.
---

# Summary format

A summary file is a JSON array of objects, one per code unit:

```json
[
  { "schemaVersion": 6, "kind": "handler", "identity": { }, "transitions": [ ] }
]
```

`suss extract` writes one, `suss contract` writes one from a schema or a deploy template, and `suss check`, `suss inspect` and `suss ask` all read them. The zod schemas in [`packages/behavioral-ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/src/schemas.ts) are the one place the format is written by hand. [IR types](/reference/ir) goes through every type field by field.

## Top-level fields

| Field | Type | What it is |
|---|---|---|
| `schemaVersion` | number, optional | The format version. Absent means 1. |
| `kind` | `CodeUnitKind` | What sort of unit this is: a handler, a client, a component, and eleven more. |
| `location` | `SourceLocation` | File, line range, character span, export name, workspace. |
| `identity` | `CodeUnitIdentity` | The name, the export path, the boundary binding, the deployed unit. |
| `inputs` | `Input[]` | How values reach the unit, one per parameter, injection, hook return or closure. |
| `transitions` | `Transition[]` | One per execution path. |
| `gaps` | `Gap[]` | What the summary could not account for. |
| `confidence` | `ConfidenceInfo` | How much of the behavior was read, and where the claim came from. |
| `definitions` | record, optional | Types a `ref` shape points at, keyed by definition. |
| `inputReads` | array, optional | What the unit read out of the values it was given, once each. |
| `metadata` | record, optional | Framework-specific data, namespaced by boundary semantics. |

## One unit

Here is a whole summary, from `suss extract --dir fixtures/express -f express`, with its four transitions cut:

```json
{
  "kind": "handler",
  "location": {
    "file": "fixtures/express/handlers.ts",
    "range": { "start": 17, "end": 39 },
    "span": { "start": 438, "end": 827 },
    "exportName": "get",
    "workspace": "suss"
  },
  "identity": {
    "name": "get",
    "nameKind": "label",
    "exportPath": ["get"],
    "boundaryBinding": {
      "transport": "http",
      "semantics": { "name": "rest", "method": "GET", "path": "/users/:id" },
      "recognition": "express"
    },
    "id": "suss::fixtures/express/handlers.ts::get#GET /users/{id}"
  },
  "inputs": [
    { "type": "parameter", "name": "req", "position": 0, "role": "request", "shape": null },
    { "type": "parameter", "name": "res", "position": 1, "role": "response", "shape": null },
    { "type": "parameter", "name": "next", "position": 2, "role": "next", "shape": null }
  ],
  "transitions": [ ],
  "gaps": [
    {
      "type": "unfollowedCall",
      "conditions": [],
      "consequence": "unknown",
      "description": "The call to db.findById lands on a declaration with no body, so whatever runs there is missing from this summary",
      "callee": "db.findById"
    }
  ],
  "confidence": { "source": "inferred_static", "level": "high" },
  "schemaVersion": 6
}
```

The handler is 23 lines of Express with two guards and a nested condition. The `db` it calls is declared with no body, so the walk stopped there and the gap records which call it was.

## One transition

A transition records that when all of these conditions hold, this output comes out and these effects fire. Here is the 404 branch of the same handler:

```json
{
  "id": "get:response:404:9d39a1a",
  "conditions": [
    {
      "type": "negation",
      "operand": {
        "type": "truthinessCheck",
        "subject": {
          "type": "derived",
          "from": {
            "type": "derived",
            "from": { "type": "input", "inputRef": "req", "path": [] },
            "derivation": { "type": "propertyAccess", "property": "params" }
          },
          "derivation": { "type": "destructured", "field": "id" }
        },
        "negated": true
      }
    },
    {
      "type": "truthinessCheck",
      "subject": { "type": "dependency", "name": "db.findById", "accessChain": [] },
      "negated": true
    }
  ],
  "output": {
    "type": "response",
    "statusCode": { "type": "literal", "value": 404 },
    "body": {
      "type": "record",
      "properties": { "error": { "type": "literal", "value": "not found" } }
    },
    "headers": {}
  },
  "effects": [
    { "type": "invocation", "callee": "db.findById", "args": [{ "kind": "identifier", "name": "id" }], "async": true }
  ],
  "location": { "start": 28, "end": 28 },
  "isDefault": false
}
```

There are two conditions here, joined with AND: the id is present, and `db.findById` came back falsy. `OR` goes inside a predicate instead, in the `compound` variant, so two transitions have the same precondition when their condition lists are structurally equal.

Conditions are structured when the reader could take the expression apart, and opaque when it could not. An opaque predicate keeps the source text and a reason, so a downstream tool knows the branch is there and decides for itself how to treat it.

The `id` is content-addressed: `${functionName}:${terminalKind}:${statusKey}:${hash7}`, where the hash is over the ordered condition chain's source text. Reordering branches keeps the ids. Changing a status, a condition or a terminal kind gives you a new one.

## One effect

The transition above has an `invocation` effect, which records that a call fired and what it was passed. The other kind is `interaction`, which records a typed boundary crossing. This one is from `suss extract -f aws-lambda -f aws-dynamodb` over a Lambda that reads a DynamoDB table:

```json
{
  "type": "interaction",
  "binding": {
    "transport": "aws-sdk",
    "semantics": {
      "name": "storage",
      "storageSystem": "aws.dynamodb",
      "scope": "default",
      "container": "Invoices",
      "accessPath": null
    },
    "recognition": "@suss/framework-aws-dynamodb"
  },
  "callee": "dynamo.send",
  "interaction": {
    "class": "storage-access",
    "kind": "read",
    "fields": ["*"],
    "operation": "GetItemCommand",
    "selector": ["invoiceId"]
  }
}
```

A transition lists each effect once, however many sites on that path produced it. The repeats become `count`, so a path that calls the same validator thirteen times has one effect with `"count": 13`, and a path that calls it once has no `count` at all. `callee` is the source text with its whitespace collapsed, so a chain broken across lines and the same chain written on one line are one effect.

Every `interaction` includes the `BoundaryBinding` of the resource it reaches, so the checker can pair it against whatever declares that thing, such as a Prisma schema or a CloudFormation table. The eight classes are `storage-access`, `service-call`, `message-send`, `message-receive`, `unit-invoke`, `config-read`, `metadata-read` and `schedule`. [IR types](/reference/ir#effect) has each one's fields.

## How two summaries pair

Two summaries describe opposite sides of one boundary when their `semantics` match, and each protocol matches its own way. REST pairs on `(method, normalizedPath)`. `function-call` pairs on `package::exportPath`. Storage pairs on `(storageSystem, scope, container, accessPath)`. [Boundary semantics](/theory/boundary-semantics) has the whole set.

An identity field is null when the source never said what it is. A send whose queue URL comes from a variable still appears:

```json
{ "name": "message-bus", "messageBus": "aws_sqs", "channel": null }
```

That summary pairs with nothing on purpose. Pairing a null against whatever the source text happened to spell would put two unrelated boundaries together. A REST `method` of `"*"` means the handler responds to every method, and it pairs with whatever method each consumer uses.

### Route paths

A REST `path` is the route as the pack read it. A path the route declares outright keeps its own spelling, so an Express route keeps `:id`. A path suss had to work out, from a prefix a variable supplies or pieces the code joins together, is written in the pattern grammar below, and pairing normalizes every path to that grammar first. A tool that reads paths should expect either form.

| Spelling | Meaning |
| --- | --- |
| `/users/{id}` | one segment the code fills in at runtime |
| `/files/{tenant?}` | zero or one segment |
| `/files/{rest+}` | one or more segments |
| `/files/{rest*}` | zero or more segments, the same as a bare `*` segment |
| `(/api\|/api/v2)/orders` | one of the options, and an option may contain a slash |

A hole's name is what the code called it, or a placeholder such as `value` where the expression had no name. Two paths pair when some request satisfies both, so `/api/orders/{rest*}` pairs with a consumer of `/api/orders`, and `(/api|/api/v2)/orders` pairs with a consumer of either option.

## Versions

Every summary this build writes says `"schemaVersion": 6`. A summary without the field is version 1, written by 0.3.x. The parsers in `@suss/behavioral-ir` read every version ever published, so a published artifact never needs rewriting.

| Version | What changed |
|---|---|
| 1 | An identity field the source did not state is the empty string. |
| 2 | Those fields are null instead, the empty string is invalid, and `"*"` becomes the REST method wildcard. |
| 3 | A parameter input's `role` can be null, for a parameter whose role nobody could read. |
| 4 | One `storage` variant replaces `storage-relational`. |
| 5 | A store and a bus go by the names OpenTelemetry's semantic conventions give them, so a summary and a span spell one boundary the same way. |
| 6 | A metric's measurement words are OpenTelemetry's too: `histogram`, and `gauge`, `delta`, `cumulative` for what one measurement covers. |

Two of those bumps needed a hand edit. Moving to 5 changes a suppression that says which bus (`bus:sqs order.placed` becomes `bus:aws_sqs order.placed`), and a `storageSystem` of `postgres` in pack config becomes `postgresql`. Nothing else, at any version, needs one.

## What a consumer can rely on

The format is stable enough to build on. These are the guarantees:

- **The parsers read every version ever published.** `parseSummaries` normalizes an older artifact on the way in, so a file written by any released version reads back as the current shape. Nobody rewrites published JSON.
- **A breaking change bumps the major version** of `@suss/behavioral-ir` and comes with a migration note in the [changelog](/reference/changelog).
- **Adding an interaction class, a code unit kind or a semantics variant is additive.** A tool that dispatches on `class`, `kind` or `semantics.name` needs a default branch, and it never gets a new required field on a shape it already reads.
- **Transition ids survive reordering and reformatting.** They are computed from the condition chain's source text, with source offsets left out, so a diff across two points in time matches by id.
- **A null identity field means the source did not say.** It never means the empty string, which is invalid from version 2 on.
- **The JSON is the canonical artifact.** The text `suss inspect` prints is written for people to read, and it changes with the CLI, so build your tool on the JSON. [Format stability](/reference/cli/inspect#format-stability) lists the parts of the text that do stay put.

Two ways to read a file:

- **TypeScript or JavaScript.** Install `@suss/behavioral-ir` (one peer dependency on `zod`) and call `parseSummaries(json)` to validate and narrow in one step, or `safeParseSummaries(json)` to handle errors without throwing. The types come from the same schemas through `z.infer`.
- **Anything else.** Validate against [`behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/schema/behavioral-summary.schema.json). The build generates it from the zod schemas, so it always matches the runtime parsers and nobody edits it by hand.

## Publishing summaries with a package

The format contains nothing machine-specific, so a library author can ship pre-built summaries alongside the package and consumers pair against them without reading the source. [Publish summaries](/guides/publish-summaries) has the convention.
