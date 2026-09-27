---
title: Intent format
description: The two kinds of intent document, field by field, and the JSON Schema an editor can check one against.
---

# Intent format

An intent document is a file your team writes and commits, saying what a piece of the system should do. `suss check --intent <dir>` reads every `*.intent.yaml` and `*.prd.yaml` under that directory and compares each one against the summaries of what the code does. `.yml` and `.json` work as well. Whatever the file is called, the `kind` at the top of it sets which fields it takes.

There are two kinds. Boundary intent (`kind: boundary`) says what one boundary should do: every outcome it can produce, what each one turns on, and what each one sends back or does. An engineer writes it, and the checker compares it against the code. A PRD (`kind: prd`) says what should happen for the person using the feature, as scenarios in that person's terms. A scenario can link to an outcome a boundary document declares, and that link ties the words to the code.

[Check against your intent](/guides/check-against-intent) walks through writing both from a codebase that already exists, and [the findings catalog](/reference/findings#intent-findings) lists what the checker reports when the two disagree.

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
| `always` | no | Effects every outcome has, apart from the ones listed under `except`. |

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

`semantics` is the sort of boundary, and the other fields in the block depend on it. A GraphQL field, a runtime-config read and a metric have no block yet.

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
| `module` | no | The module of this application the function belongs to, by the name `suss.json` gives it. A server action gives the file it is written in instead. |
| `exportName` | no | The name the module or package exports the function under. |
| `transport` | no | Defaults to `in-process`. |
| `receives` | no | The arguments the boundary needs, by parameter name. |

The checker pairs a function-call boundary on its key. A document that gives `package` and `exportPath` is keyed `fn:<package>::<exportPath>`, the key a package's public export has. A document that gives `module` and `exportName` is keyed `fn:<module>::<exportName>`, the key `suss extract` gives each public export of a module `suss.json` lists. A class method's `exportName` is `Class.method`:

```yaml
boundary:
  semantics: function-call
  module: billing
  exportName: chargeInvoice
```

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

A command's flags are fields of the argument list it parses, written with their dashes. For a function that hands its `args` parameter to Node's `parseArgs`, `--dir` is `"args.--dir"`:

```yaml
receives:
  args: { type: array, required: true }
  "args.--dir": { type: string }
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

A field with nothing under it is still a complete declaration. `consumer: {}` says the field is there and nothing more. The block lists the fields you want checked, and it can leave the rest out. A field the code reads that the block does not list is reported at info.

### Transitions

Each transition describes one outcome, and a document has one for every outcome the boundary can produce.

| Field | Required | What it means |
|---|---|---|
| `id` | yes | The outcome's name. A PRD scenario links to it as `<intent-name>.<id>`. It is free-form, and it is where you write what the outcome means. |
| `when` | yes | What has to hold for this outcome. |
| `response` | no | The outcome sends an HTTP response. |
| `returns` | no | The outcome returns a value to its caller. |
| `throws` | no | The outcome raises an error. |
| `exits` | no | The outcome ends the process with this exit code. |
| `results` | no | The effects the outcome has. |

A transition ends one way, so it takes at most one of `response`, `returns`, `throws` and `exits`. It cannot be empty either, so it needs one of those four or a `results` list.

`response` takes a `status` between 100 and 599, required, and an optional `body`. `returns` takes an optional `body`. `throws` takes an optional `errorType`, the name of the error class. `exits` takes the code itself, a number from 0 to 255, and a bare `exits:` is refused rather than read as 0.

The checker matches `exits: 1` against a transition that ends the process with `1`, such as `process.exit(1)`, and against a `return 1` in a function whose return becomes the process's exit code. A command usually returns its code up to one place that sets it, so the second is how most commands say it. A code the program computes, `process.exit(code)`, matches no number.

A `body` takes `type`, plus `items` when it is an array and `properties` when it is an object. `properties:` with no `type:` above it is shorthand for an object, at any depth. `const:` pins a value to one literal, such as `{ const: true }` or `{ const: nothingPaired }`. `required` inside a body shape is the list of property names that have to be there. The `required` on a `receives` field is a boolean, and the two are unrelated.

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
| `shape` | no | The shape of what the effect writes, in the same words a `body` takes. |
| `from` | no | Where the value of a column under `fields` or `by` comes from, by column. |

A `results` line is spelled the same way as the matching `suss ask` question, here `suss ask "what writes aws.dynamodb:Invoices"`. Where a line has a `fields` list, the checker requires that the access cover every column on it.

`from` says where a column's value comes from. Each source is `input.` followed by a path off the value the boundary is handed, written the way `receives` writes it: `input.headers.x-tenant-id`, `input.body.email`, `input.params.id`, and a parameter's name on a function call. A path off the request outside its four parts, such as the claims a middleware puts on it, is written as the path off the request: `input.auth.tenantId`.

```yaml
results:
  - reads: postgresql:orders
    by: [tenant_id]
    from: { tenant_id: input.auth.tenantId }
```

The line is satisfied when the code takes the column from that source. When it takes it from somewhere else suss can name, an input path or a literal, the checker reports [`valueFromElsewhere`](/reference/findings#valuefromelsewhere) with the source it found. When the walk from the value stopped at something it cannot follow, such as a call into a library no pack describes, the claim is listed under `unchecked` with where the walk stopped. suss stops loading a document whose `from` gives a column the line does not list, or a source not written as `input.<path>`. A change list and an `always` line do not take `from`.

A route's source reads the same in every language when the pack says which part of the request each read is. The Express, Fastify, Hono and Lambda packs do. A Python or Ruby route records where each value came from, but its packs do not say which part of the request a read is, so a `from` on one is unchecked for now. A Python or Ruby function-call boundary is checked, since its sources are its parameters.

A command's output is written the same way. `writes: io:stdout` says the outcome prints to standard output, and `shape` says what it prints when it prints JSON:

```yaml
results:
  - writes: io:stdout
    shape:
      properties:
        run: { type: array, items: { properties: { kind: { const: nothingPaired } } } }
```

The checker compares `shape` with what the code serialized. When the code prints a value whose shape suss could not read, the line is unchecked rather than wrong, and a shape that disagrees is reported as `outcomeShapeMismatch`.

### `always`

A `results` line says an outcome has an effect, and one transition producing that outcome is enough to satisfy it. `always` says every outcome has the effect. It goes at the top level of the document, next to `transitions`, and the checker requires it of every code transition that produces a declared outcome:

```yaml
always:
  - writes: postgresql:audit_log
    fields: [actor_id, action]
    except: [not-admin]
```

| Key | Required | What it means |
|---|---|---|
| `reads`, `writes`, `invokes` | one of the three | The boundary, written the same way as on a `results` line. |
| `fields` | no | The columns the access touches. |
| `by` | no | What the access picks the item out by. |
| `except` | no | The ids of the outcomes that do not have to have the effect. |

A throw is an outcome like the others, so a transition that throws needs the effect unless its outcome is listed under `except`. A transition that does not produce any declared outcome is not checked, and the checker reports it as `undeclaredOutcome`. Each transition that lacks the effect is its own [`pathWithoutEffect`](/reference/findings#pathwithouteffect) finding.

An `except` id has to be the id of a transition in the document, and suss stops on one that is not. It also has to be an outcome with a `response`, `returns` or `throws`. An outcome that states only its effects matches every transition, so exempting it would exempt them all.

A change list does not take `always`. It describes one change at a time, and `always` describes the whole boundary.

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
| `coveredBy` | no | The tests that exercise this scenario, for a promise no outcome can state. |
| `about` | no | What a covering test has to reach: a boundary or a unit, spelled the way `suss ask` takes one. Required on a scenario with `coveredBy` when no scenario in the PRD has a `link`. |

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

A link to an outcome nothing declares is `danglingScenarioLink` at warning. A link to a name that two boundary documents share is `ambiguousScenarioLink`, also at warning.

### Covering tests

Some promises are about which values come back, such as a finding that was already there not being reported as new. No outcome can state that, so the scenario lists the test that covers it instead, spelled the way the runner prints it: the test file, each `describe` title, then the test's own title, joined with ` > `. One test is a string and several are a list:

```yaml
- title: a finding that was already there
  when: a finding was in the code before the agent's edit and is still there after it
  expect: it is not reported as new, and it does not fail the agent's check
  coveredBy: packages/checker/src/since/changesSince.test.ts > findingsSince > splits the findings into new and gone, by identity
  about: fn:@suss/checker::findingsSince
```

The file matches on whole path segments from the end, so a path from the repository root matches a summary written relative to its package. When two packages have a test at the same path and title, write the workspace in front of the file: `@suss/cli::src/run.test.ts > ...`.

`suss check --intent` checks each covering test three ways. The test has to be in the summaries, which takes a test pack at extract time, such as `suss extract -f vitest --intent intent/`. It has to run, so a test marked skip or todo does not count. And its calls have to reach what the scenario is about without going through something the test replaced with a mock. The findings are `missingCoveringTest`, `coveringTestSkipped` and `testMissesSubject`, each a warning.

What a test has to reach is `about` when the scenario gives it. Without `about`, it is any of the boundaries the PRD's linked scenarios link to, so a test that reaches one of them covers every scenario in that PRD that leaves `about` out. A PRD with no link anywhere has nothing to fall back on, and the schema asks for `about` on each scenario that lists a test.

The check does not read what a test asserts, so a test that calls the subject and asserts nothing counts as covering it. It runs nothing, so a test that fails still counts; the runner's own exit code already fails the build for that.

### A scenario with neither

A scenario can have neither a `link` nor `coveredBy`. Its words then describe the feature and nothing checks them. The checker reports that as `unlinkedScenario` at warning. While a scenario is still being written, record that with a `.sussignore` rule that gives the scenario's title, so the gap is on record and a scenario added to the same PRD later is still reported:

```yaml
- kind: unlinkedScenario
  boundary: "prd:Accept a finding once, and it stays accepted"
  scenario: moving code keeps the rule matching
  reason: No test pastes a rule and then moves the handler yet.
```

## The change list

A change list is written before a change, and says which behavior changes it will make. It uses the boundary document's words and adds a verb to each entry. It has no `when`, `purpose` or `audience`, because whoever writes it has not written the code yet. [`suss intent check`](/reference/cli/intent#suss-intent-check) compares it with the summaries from before and after the change, and [`suss intent keep`](/reference/cli/intent#suss-intent-keep) turns it into boundary documents once the work is done. The suss plugin for Claude Code has the agent write one for each request.

```yaml
asked: "Add POST /orders/:id/cancel. Cancelling sets cancelled_at ... 404 when the order does not exist."
changes:
  - adds: POST /orders/:id/cancel
    outcomes: [200, 404]
  - adds: { writes: postgresql:orders, fields: [cancelled_at] }
    at: POST /orders/:id/cancel
  - changes: Order.status
    note: gains the value "cancelled"
explained:
  - changes: POST /orders
    outcomes: [409]
    why: a second open order for the same sku was charged twice, so POST /orders refuses it
```

| Field | Required | What it means |
|---|---|---|
| `asked` | no | The developer's request, quoted. `...` in the quote matches any stretch of the message. |
| `changes` | no | One entry per behavior change. An empty list says no behavior should change. |
| `explained` | no | Changes nobody asked for that stay, each with the reason. |

Each entry of `changes` takes:

| Field | Required | What it means |
|---|---|---|
| `adds`, `removes`, `changes` | one of the three | The verb, and the subject it applies to: a boundary written the way `suss ask` writes one, such as `POST /orders/:id/cancel`, or an effect written like a `results` line, such as `{ writes: postgresql:orders, fields: [cancelled_at] }`. A read of an environment variable is `{ reads: runtime-config, fields: [ACCOUNTS_REGION] }`. |
| `outcomes` | no | For a boundary, the outcomes it should have: statuses such as `404`, or `returns`, `throws` and `{ throws: NotFoundError }`. |
| `at` | no | For an effect, the boundary it happens at. With no `at`, the effect counts at any boundary. |
| `asked` | no | The message this entry comes from, when it is not the list's. |
| `note` | no | What the change is, in words, for a subject suss has no spelling for. |

An entry of `explained` takes the same verb, subject, `outcomes` and `at`, and a `why`, which is required.

Each `adds` or `changes` entry compiles to transitions of a `kind: boundary` document: one per outcome a boundary entry lists, and one for an effect entry, whose `results` line is the effect. A `removes` entry has no counterpart, since a boundary document states what a boundary does and not what it stopped doing.

## Where a document came from

`source` takes one of three values, and both document kinds have the field.

| Value | What it means |
|---|---|
| `author` | Somebody wrote the document. |
| `inferred` | `suss infer` drafted it from the code and nobody has been through it. |
| `inferred, curated` | `suss infer` drafted it and somebody has been through it. |

The checker uses `source` to set severity. A finding against bare `inferred` intent is downgraded one level, because nobody has confirmed the declaration yet. Curating restores the full severity.

Curating a boundary document means writing the `purpose` and `audience` that `suss infer` left blank, renaming the outcome ids to what your team calls them, and setting `source` to `"inferred, curated"`. Curating a PRD means writing the `when` and `expect` of every scenario. A draft with a blank still in it does not satisfy the schema, so a run over the folder refuses it and says which files are waiting.

## The JSON Schema

`@suss/intent-ir` publishes [`intent-doc.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/intent-ir/schema/intent-doc.schema.json), generated at build time from the same zod schemas the CLI parses with, so the schema and the CLI accept the same documents. A tool in any language can validate a document against it.

To have an editor check a document as you type, put a comment on its first line saying where the schema is. The YAML language server reads that comment, and VS Code and Neovim both run it:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/nimbuscloud-ai/suss/main/packages/intent-ir/schema/intent-doc.schema.json

kind: boundary

name: users-lookup
purpose: GET /users/:id retrieves a single user record.
audience: web-client
```

Every field has a description in the schema, so hovering over one shows what it means, and completion offers the keys the document kind takes.

The schema is generated from the authoring side of the zod schemas, so a field with a default is optional in it, the way it is for somebody writing the file by hand. A test in `@suss/intent-ir` runs both the schema and the parser over every intent document in this repository and fails when the two disagree.
