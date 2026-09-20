---
title: Intent format
description: The two kinds of intent document, field by field, and the JSON Schema an editor can check one against.
---

# Intent format

An intent document is a file your team writes and commits, saying what a piece of the system should do. `suss check --intent <dir>` reads every `*.intent.yaml` and `*.prd.yaml` under that directory and compares each one against the summaries of what the code does. `.yml` and `.json` work as well, and the `kind` at the top of a file decides which shape it has, whatever the file is called.

There are two kinds. Boundary intent (`kind: boundary`) says what one boundary should do: every outcome it can produce, what each one turns on, and what each one sends back or does. An engineer writes it, and the checker compares it against the code. A PRD (`kind: prd`) says what should happen for the person using the feature, as scenarios in that person's terms. A scenario can link to an outcome a boundary document declares, and that link ties the words to the code.

[Check against your intent](/guides/check-against-intent) walks through writing both from a codebase that already exists, and [the findings catalog](/reference/findings#intent-findings) says what the checker reports when the two disagree.

## Boundary intent

| Field | Required | What it means |
|---|---|---|
| `kind` | yes | `boundary`. |
| `name` | yes | What the document is called. A PRD scenario links to an outcome of it as `<name>.<outcome-id>`. |
| `purpose` | yes | What the boundary is for, in your words. |
| `audience` | yes | Who calls the boundary and depends on what it does. |
| `source` | no | Where the document came from. Defaults to `author`. |
| `boundary` | yes | Which boundary in the code the document is about. |
| `transitions` | yes | Every outcome the boundary can produce, at least one. |

Nothing else can appear at the top level. Write `transition:` for `transitions:` and suss reports the key and stops. The same goes inside a transition and inside a scenario.

Here is a whole document, the worked REST example from `design/proposals/intent-layer-examples/fastify-users`:

```yaml
kind: boundary

name: users-lookup
purpose: GET /users/:id retrieves a single user record.
audience: web-client
source: author

boundary:
  transport: http
  semantics: rest
  method: GET
  path: /users/:id

transitions:
  - id: missing-id
    when: id parameter is empty
    response:
      status: 400
      body:
        properties:
          error: { type: string }

  - id: not-found
    when: user with the requested id does not exist
    response:
      status: 404
      body:
        properties:
          error: { type: string }

  - id: found
    when: user exists and is not an admin
    response:
      status: 200
      body:
        properties:
          id: { type: string }
          name: { type: string }
          role: { type: string }
```

### The boundary block

`semantics` says which sort of boundary this is, and the rest of the block follows from it. A GraphQL field, a runtime-config read and a metric have no block yet.

A block can leave out what the checker pairs on. The checker reports it as `unkeyableBoundary` and puts it under the unchecked count, so you can write intent ahead of the code.

#### `semantics: rest`

| Field | Required | What it means |
|---|---|---|
| `semantics` | yes | `rest`. |
| `method` | yes | The HTTP method the route handles. |
| `path` | yes | The route path, written the way the framework declares it, so an Express route keeps `:id`. |
| `transport` | no | `http`, which is also the default. |
| `receives` | no | The parts of the request the boundary depends on. |

#### `semantics: function-call`

| Field | Required | What it means |
|---|---|---|
| `semantics` | yes | `function-call`. |
| `package` | no | The package name, when the boundary is something a package publishes. |
| `exportPath` | no | The path to the export inside the package: the sub-path, then any nested names. |
| `module` | no | The repo-relative module path, when the boundary is a unit inside this repository. |
| `exportName` | no | The name the module or package exports the function under. |
| `transport` | no | Defaults to `in-process`. |
| `receives` | no | The arguments the boundary needs, by parameter name. |

The checker pairs a function-call boundary on `package` and `exportPath`. A document that gives a `module` and an `exportName` instead describes a boundary inside one package, which has no key yet, so it goes unchecked.

#### `semantics: message-bus`

| Field | Required | What it means |
|---|---|---|
| `semantics` | yes | `message-bus`. |
| `messageBus` | yes | Which bus the message travels on: `aws_sqs`, `aws.sns`, `kafka`, and the rest of the set in [boundary semantics](/theory/boundary-semantics). |
| `channel` | no | The queue or topic the message travels on. Defaults to null, and the checker pairs on it. |
| `receives` | no | The fields of the message body the consumer depends on. |

#### `semantics: storage`

| Field | Required | What it means |
|---|---|---|
| `semantics` | yes | `storage`. |
| `storageSystem` | no | Which store this is: `postgresql`, `aws.dynamodb`, `s3`. Defaults to null, which says the document does not name an engine. |
| `scope` | no | The ORM, schema or deployment scope the container is in. A setup with one database uses `default`, which is also the default value. |
| `container` | no | The table, bucket, collection or index. Defaults to null. |
| `accessPath` | no | A secondary way into the container, such as a DynamoDB index or an Elasticsearch alias. Defaults to null. |
| `receives` | no | The fields the access is handed. |

A store is the one boundary where filling the fields in does not make it pairable, because a container name can be a pattern that only a caller or the deployment settles. To say what a store is for, put `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches it, and the checker compares that against the accesses on that boundary.

#### `semantics: unit-invocation`

| Field | Required | What it means |
|---|---|---|
| `semantics` | yes | `unit-invocation`. |
| `deploymentTarget` | yes | What sort of deployed thing this is: `lambda`, `ecs-task`, `container`, `k8s-deployment` or `worker`. |
| `instanceName` | no | The name the deployment medium knows the unit by, such as a CloudFormation logical id. Defaults to null, and the checker pairs on it. |
| `receives` | no | The fields the unit is handed. |

### What the boundary receives

A `receives` block lists the fields the boundary is handed. A function-call, message-bus, storage or unit-invocation boundary writes one line per field, keyed by name, and a dot reaches inside one:

```yaml
receives:
  provider: { type: object, required: true }
  options.stream: { type: string }
```

A REST boundary has a section per part of the request, because a sender fills the four parts separately:

```yaml
receives:
  headers:
    x-tenant-id: { type: string, required: true }
  query:
    dryRun: { type: boolean }
  params:
    id: { type: string, required: true }
  body:
    type: object
    properties:
      note: { type: string }
```

Each field takes:

| Field | Required | What it means |
|---|---|---|
| `required` | no | Whether the boundary needs this field. Defaults to false. |
| `type` | no | One of `string`, `integer`, `number`, `boolean`, `null`, `unknown`, `array` and `object`. |
| `items` | no | The shape of an element, when `type` is `array`. |
| `properties` | no | The fields under it, when `type` is `object`. |

Naming a field is a complete declaration on its own, so `consumer: {}` says the field is there and says nothing more about it. The block lists the fields you want checked, and it can leave the rest out. A field the code reads that the block does not list is reported at info.

### Transitions

Each transition describes one outcome, and a document has one for every outcome the boundary can produce.

| Field | Required | What it means |
|---|---|---|
| `id` | yes | The outcome's name. A PRD scenario links to it as `<intent-name>.<id>`. It is free-form, and it is where you write what the outcome means. |
| `when` | yes | What has to hold for this outcome. |
| `response` | no | The outcome sends an HTTP response. |
| `returns` | no | The outcome returns a value to its caller. |
| `throws` | no | The outcome raises an error. |
| `results` | no | The effects the outcome has. |

A transition ends one way, so it takes at most one of `response`, `returns` and `throws`. It also has to say something, so it needs one of those three or a `results` list.

`response` takes a `status` between 100 and 599, required, and an optional `body`. `returns` takes an optional `body`. `throws` takes an optional `errorType`, the name of the error class.

A `body` takes `type`, plus `items` when it is an array and `properties` when it is an object. `properties:` with no `type:` above it is shorthand for an object. `required` inside a body shape is the list of property names that have to be there. The `required` on a `receives` field is a boolean, and the two are unrelated.

#### `when`

`when` is either one sentence or a list of clauses. A clause says which subject it is about, says at most one thing about that subject, and can narrow it with `where`:

```yaml
when:
  - reads: aws.dynamodb:Invoices
    finds: something
    where: settledAt is missing
```

| Key | What it means |
|---|---|
| `reads`, `writes`, `invokes` | The subject is a boundary, written the way `suss ask` writes one. A clause takes one of these three or `input`. |
| `input` | The subject is something the caller sent, written as the path it arrived on. |
| `finds` | What a lookup came back with: `nothing` or `something`. |
| `is` | What state the value was in: `set`, `missing`, `null`, `a string`. |
| `equals` | The value it was equal to. |
| `has` | A property it had. |
| `where` | Narrows the clause with whatever the guard said about a deeper read of the same result. |

A clause says at most one of `finds`, `is`, `equals` and `has`. A guard that maps to none of this stays the sentence you wrote, and a whole `when` written as one string is valid.

A fall-through branch states its own condition. Pointing at the branches above it would change what the branch claims as soon as somebody inserts a transition over it.

#### `results`

`results` is a list of what the outcome does, in the verbs `suss ask` asks with:

```yaml
results:
  - writes: aws.dynamodb:Invoices
    fields: [email, phone]
  - invokes: unit:lambda ArchiveWorker
```

| Key | Required | What it means |
|---|---|---|
| `reads`, `writes`, `invokes` | one of the three | The boundary the outcome touches, written the way every report prints it and `suss ask` takes it. |
| `fields` | no | The columns the access touches. |
| `by` | no | What the access picks the item out by. One name or a list of them. |

`suss ask "what writes aws.dynamodb:Invoices"` is the question and a `results` line is the assertion, spelled the same way. Where a line has a `fields` list, the checker requires that the access cover every column on it.

## A PRD

| Field | Required | What it means |
|---|---|---|
| `kind` | yes | `prd`. |
| `title` | yes | What the document is called. |
| `purpose` | yes | What the feature is for, in your words. |
| `audience` | yes | Who the feature is for. |
| `source` | no | Where the document came from. Defaults to `author`. |
| `scenarios` | yes | The situations the feature covers, at least one. |

Each scenario takes:

| Field | Required | What it means |
|---|---|---|
| `when` | yes | The situation, in your words. |
| `expect` | yes | What should happen, in your words. |
| `title` | no | A short name for the scenario. |
| `link` | no | The boundary-intent outcomes this scenario is about. |

The PRD that goes with the boundary document above, whole:

```yaml
kind: prd

title: User profile lookup
purpose: |
  The client app can fetch a user's profile information by id. The
  endpoint should distinguish between missing input, unknown users,
  and admin users (who get an enriched profile).
audience: web-client

scenarios:
  - when: a request arrives with a known user id
    expect: the caller receives the user's profile
    link: users-lookup.found

  - when: the request omits the id parameter
    expect: the caller is told the id is required
    link: users-lookup.missing-id

  - when: the id doesn't match any record
    expect: the caller is told the user wasn't found
    link: users-lookup.not-found
```

### Links

A link is `<intent-name>.<outcome-id>`: the `name` of a boundary document, a dot, then the `id` of one of its transitions. `users-lookup.found` points at the transition with `id: found` in the document named `users-lookup`. One link is a string and several are a list:

```yaml
link:
  - order-intake.acknowledged
  - order-intake.queued-for-processing
```

A scenario can have no `link`. The words read on their own, and nothing has tied them to an outcome yet. The checker reports that as `unlinkedScenario` at info. A link to an outcome nothing declares is `danglingScenarioLink` at warning. A link to a name that two boundary documents share is `ambiguousScenarioLink`, also at warning.

## Where a document came from

`source` takes one of three values, and both document kinds have the field.

| Value | What it means |
|---|---|
| `author` | Somebody wrote the document. |
| `inferred` | `suss infer` drafted it from the code and nobody has been through it. |
| `inferred, curated` | `suss infer` drafted it and somebody has been through it. |

The checker reads `source` to decide how loudly to report. A finding against bare `inferred` intent is downgraded one level, because nobody has confirmed the declaration yet. Curating restores the full severity.

Curating a boundary document means writing the `purpose` and `audience` that `suss infer` left blank, renaming the outcome ids to what your team calls them, and setting `source` to `"inferred, curated"`. Curating a PRD means writing the `when` and `expect` of every scenario. A draft with a blank still in it does not satisfy the schema, so a run over the folder refuses it and says which files are waiting.

## The JSON Schema

`@suss/intent-ir` publishes [`intent-doc.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/intent-ir/schema/intent-doc.schema.json), generated at build time from the same zod schemas the CLI parses with, so the two say the same thing. A tool in any language can validate a document against it.

To have an editor check a document as you type, put a comment on its first line saying where the schema is. The YAML language server reads that comment, and VS Code and Neovim both run it:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/nimbuscloud-ai/suss/main/packages/intent-ir/schema/intent-doc.schema.json

kind: boundary

name: users-lookup
purpose: GET /users/:id retrieves a single user record.
audience: web-client
```

Every field has a description in the schema, so hovering over one says what it means, and completion offers the keys the document kind takes.

The schema is generated from the authoring side of the zod schemas, so a field with a default is optional in it, the way it is for somebody writing the file by hand. A test in `@suss/intent-ir` runs both the schema and the parser over every intent document in this repository and fails when the two disagree.
