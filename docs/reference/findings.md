# Findings catalog

Every finding kind in the IR's `FindingKindSchema`, what it means, when it's legitimate, and how to address it. Use this as the lookup when a finding surfaces and you want to know whether it's a bug or noise.

The authoritative source is `FindingKindSchema` in [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts) — every kind below appears there with the same wording. This doc just adds emitter, severity, and "when's it legitimate" context.

## Finding shape

Every finding follows the same JSON shape:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string (one of the values below) | Names the failure mode. |
| `severity` | `error` \| `warning` \| `info` | Default severity. `.sussignore` rules can downgrade. |
| `boundary` | `BoundaryBinding` | Which boundary the finding is about (REST endpoint, storage table, message-bus channel, runtime-config scope, etc.). The kind of binding depends on the finding's domain. |
| `provider` | `FindingSide` | The summary on the provider side: `{ summary, transitionId?, location }`. `summary` is `${file}::${name}`. `transitionId` is set when the finding is about a specific branch. |
| `consumer` | `FindingSide` | The summary on the consumer side. Always populated, even for self-inconsistency findings (provider-against-its-own-contract); in that case provider and consumer often resolve to the same summary. |
| `description` | string | One-line human-readable text. |
| `sources` | `string[]?` | Present only when two or more identical findings from different providers were collapsed by the dedupe pass. Each entry is a `${file}::${name}` matching `FindingSide.summary`. |
| `suppressed` | `FindingSuppression?` | Present only when a `.sussignore` rule matched. Carries `{ reason, effect, originalSeverity? }` — see [Suppressions](/suppressions). |

The catalog below is grouped by domain. Within each domain, **shipped** kinds (the checker emits today) come first; **reserved** kinds (in the IR enum, awaiting an emitter) come at the end.

---

## REST findings

### `unhandledProviderCase` *(shipped)*

**Severity:** warning • **Emitted by:** `checkProviderCoverage`, `checkBodyCompatibility`

The provider produces a status code (or a body field on a status) that no consumer branch reads. The consumer hits its fall-through path — throwing, returning undefined, or silently ignoring — when the provider returns that status.

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/handler.ts::getUser (src/handler.ts:15)
  consumer: src/client.ts::loadUser (src/client.ts:3)
  boundary: ts-rest (http) GET /users/:id
```

**Legitimate when:** the consumer truly doesn't care (it has a `try/catch`, or the throw path is correct). Suppress with `.sussignore` `effect: mark`.

**Bug when:** the consumer silently ignores the status. Add a branch in the consumer (e.g. `if (res.status === 404) return null`).

### `deadConsumerBranch` *(shipped)*

**Severity:** error • **Emitted by:** `checkConsumerSatisfaction`

The consumer has a branch that reads a status the provider never produces. Code that will never run — usually drift from a consumer copy-pasted from another endpoint.

```
[ERROR] deadConsumerBranch
  Consumer expects status 403 but provider never produces it
  provider: src/handler.ts::createUser (src/handler.ts:22)
  consumer: src/client.ts::createUser (src/client.ts:8)
  boundary: ts-rest (http) POST /users
```

**Legitimate when:** rare. A defensive branch kept "just in case." Suppress.

**Bug when:** common. Delete the dead branch, or add the missing status to the provider contract.

### `providerContractViolation` *(shipped)*

**Severity:** error • **Emitted by:** `checkContractConsistency`

The provider produces a status code (or body shape) its declared contract doesn't include. Drift between handler implementation and contract — the handler added behavior the contract doesn't promise.

```
[ERROR] providerContractViolation
  Handler produces status 410 which is not declared in the ts-rest contract
  provider: src/handler.ts::getUser (src/handler.ts:15)
  consumer: src/handler.ts::getUser (src/handler.ts:15)
  boundary: ts-rest (http) GET /users/:id
```

Self-inconsistency — the provider and consumer fields point at the same summary, since the violation is internal to one side. Skipped when the contract source is itself derived from the implementation (no point flagging code against its own derivation).

**Fix:** add the status to the contract, or remove it from the handler.

### `consumerContractViolation` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractConsistency`, `checkConsumerContract`, `checkBodyCompatibility`

The consumer's expected statuses or body-field reads disagree with the contract — handles a status the contract doesn't declare, fails to handle one the contract requires, or reads a body field the contract doesn't promise.

**Fix:** align the consumer's branches and field reads with the contract. Often fires alongside `deadConsumerBranch` (the two are related drift modes).

### `contractDisagreement` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractAgreement`

Two or more providers at the same boundary (e.g. an OpenAPI spec and a CFN template) declare contracts that disagree — different status sets, different body shapes. `sources` lists every contributor.

```
[WARNING] contractDisagreement
  OpenAPI declares {200, 404} but CFN template MethodResponses declares {200, 404, 500}
  provider: petstore.yaml::getPet (petstore.yaml:1)
  consumer: template.yaml::getPet (template.yaml:30)
  sources: ["petstore.yaml::getPet", "template.yaml::getPet"]
  boundary: openapi (http) GET /pets/:id
```

**Fix:** reconcile the sources. Whichever is authoritative wins; the others drift to match.

### `requiredHeaderMissing` *(reserved)*

**Severity:** error

A REST consumer call doesn't include a header the provider / contract declares required (Authorization, Idempotency-Key, X-API-Version, etc.). TypeScript only catches this for typed clients that model headers in their call signature; ad-hoc fetch / axios usage doesn't. Emitter ships when request-shape pairing extends past status / body to headers.

### `requiredQueryParamMissing` *(reserved)*

**Severity:** error

A REST consumer call doesn't include a query parameter the provider declares required (e.g. `?cursor=X` for paginated endpoints). Emitter ships with the request-shape pairing extension.

### `requestBodyShapeMismatch` *(reserved)*

**Severity:** error

A REST consumer call sends a request body whose shape doesn't match the provider's declared body schema — wrong field names, missing required fields, extra unknown fields. Distinct from `consumerContractViolation` (which is response-side); this is request-side. Emitter ships with body-shape pairing on the request side.

### `restMethodOnUnknownPath` *(reserved)*

**Severity:** error

A REST consumer call targets a `(method, path)` combination the provider doesn't expose. Today the pairing layer leaves both summaries unmatched, which silently obscures what's likely a typo or stale endpoint reference. Emitter ships when the pairing layer adds an explicit "consumer with no provider" finding distinct from "unmatched / no boundary binding."

### `contentTypeMismatch` *(reserved)*

**Severity:** error

Provider returns a content-type the consumer doesn't expect (provider returns `application/xml`, consumer parses as JSON; or provider returns `application/octet-stream`, consumer calls `.json()`). Needs both sides to record content-type; today's pairing doesn't surface that separately.

### `authPolicyMismatch` *(reserved)*

**Severity:** error

Provider requires authentication (Bearer / API key / OAuth) and the consumer's call doesn't send it, sends a different scheme, or lacks the required scope. Needs auth-policy modeling on both sides — OpenAPI security schemes plus the client-side header / interceptor patterns.

---

## GraphQL findings

### `graphqlFieldNotImplemented` *(shipped)*

**Severity:** warning • **Emitted by:** `pairGraphqlOperations`

A consumer operation selects a root-level field (`Query.*`, `Mutation.*`, `Subscription.*`) that no provider resolver implements. Strong signal that the consumer is out of sync with the deployed schema — either the operation got stale or the resolver was removed.

```
[WARNING] graphqlFieldNotImplemented
  GraphQL operation "useStale.Stale" selects root field "Query.deletedAt"
  but no provider summary implements it.
  provider: Query.deletedAt (unresolved)
  consumer: src/useStale.ts::useStale.Stale (src/useStale.ts:12)
  boundary: apollo-client (http) query Stale
```

**Legitimate when:** the resolver lives in a service you haven't extracted (microservice boundary). Extract that service's summaries, or add an AppSync / schema contract source.

**Bug when:** the field was removed from the server. Remove the selection from the operation.

### `graphqlSelectionFieldUnknown` *(shipped)*

**Severity:** warning • **Emitted by:** `pairGraphqlOperations` (nested-selection pass)

A consumer selects a nested field on an object type that the provider's schema doesn't declare. The root field paired successfully — the issue is deeper in the selection tree.

```
[WARNING] graphqlSelectionFieldUnknown
  GraphQL operation "usePet.GetPet" selects "Pet.deletedAt" but the
  provider's schema doesn't declare that field on "Pet". The server
  response will not include it.
  provider: Pet.deletedAt (undeclared)
  consumer: src/usePet.ts::usePet.GetPet (src/usePet.ts:5)
  boundary: apollo-client (http) query GetPet
```

**Fix:** remove the selection, or add the field to the schema.

### `graphqlVariableTypeMismatch` *(reserved)*

**Severity:** error

A GraphQL consumer operation declares a variable type that doesn't match the resolver's argument type — e.g. operation `query GetUser($id: String!)` against a schema's `user(id: ID!)`. At runtime the resolver receives a type-coerced value or fails outright. Emitter ships with the GraphQL operation→resolver pairing extension (today the pass only checks field existence).

### `graphqlRequiredArgMissing` *(reserved)*

**Severity:** error

A GraphQL consumer operation calls a field with positional args missing one or more required arguments declared by the schema — e.g. operation `user(id: $id)` against schema `user(id: ID!, version: Int!)`. Emitter ships with the same operation→resolver pairing extension.

### `graphqlEnumValueUnknown` *(reserved)*

**Severity:** error

A GraphQL consumer operation passes an enum value the schema doesn't include — e.g. `status: PENDING_REVIEW` against schema enum `{PENDING, APPROVED, REJECTED}`. Typed clients (codegen) catch this at compile time, so the emitter waits for cases where the value escapes typing or comes from a literal-string client.

---

## React / Storybook findings

### `scenarioArgUnknown` *(shipped)*

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

A scenario (Storybook story, fixture) references a prop the component doesn't declare. Usually means the story is stale after a component rename or removal.

```
[WARNING] scenarioArgUnknown
  Story "Broken" provides arg "disabled" but component "Button" does
  not declare it as an input.
```

**Fix:** update the story, or restore the prop on the component.

### `scenarioCoverageGap` *(shipped)*

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

A component has a conditional branch that depends on a prop, but no story supplies that prop. The branch exists with no declared coverage — changes to it can regress silently.

```
[WARNING] scenarioCoverageGap
  Component "UserCard" has a conditional branch on prop "user" but no
  story supplies it. Branches depending on "user" have no declared
  scenario exercising them.
```

**Fix:** add a story that exercises the branch.

### `componentRequiredPropMissing` *(reserved)*

**Severity:** error

A scenario doesn't supply a prop the component declares required. Distinct from `scenarioArgUnknown` (story passes a prop the component doesn't accept) — this is the inverse: the component requires it; the story omits it. Emitter waits for the React adapter to record required-vs-optional on declared inputs.

### `componentPropTypeMismatch` *(reserved)*

**Severity:** error

A scenario passes a value of the wrong type for a prop — e.g. story `args: { count: "5" }` against component `count: number`. TypeScript catches this when the story uses `Meta<typeof Component>`; misses for hand-written stories that escape the typing or pass `as any`.

---

## Storage findings

### `storageReadFieldUnknown` *(shipped)*

**Severity:** error • **Emitted by:** `checkRelationalStorage`

Code reads a column the schema doesn't declare. Most often a typo (`deltedAt` instead of `deletedAt`) or stale code that still references a renamed column. At runtime this resolves to `undefined` and silently flips truthy checks downstream.

```
[ERROR] storageReadFieldUnknown
  loadUser selects "deltedAt" on User (postgres) but the schema declares
  no deltedAt column. At runtime this resolves to undefined on reads,
  changing which execution paths the function takes downstream.
  provider: prisma/schema.prisma::User (prisma/schema.prisma:12)
  consumer: src/loadUser.ts::loadUser (src/loadUser.ts:5)
  boundary: prisma (in-process) storage:postgres:default:User
```

**Fix:** correct the column name, or add it to the schema.

### `storageWriteFieldUnknown` *(shipped)*

**Severity:** error • **Emitted by:** `checkRelationalStorage`

Code writes a column the schema doesn't declare. Same family as `storageReadFieldUnknown` but on the write side; the row gets inserted/updated without the field — silent data loss.

**Fix:** correct the column name, or add it to the schema.

### `storageFieldUnused` *(shipped)*

**Severity:** warning • **Emitted by:** `checkRelationalStorage`

Schema declares a column that no code in the project reads or writes. Usually dead config left over from a removed feature, or a renamed column the schema still has. Suppressed when ANY caller uses default-shape (`["*"]`) reads on the table — at that point we can't tell whether default-shape consumers actually use the column.

**Fix:** remove the column, or restore the code that uses it.

### `storageWriteOnlyField` *(shipped)*

**Severity:** warning • **Emitted by:** `checkRelationalStorage`

A column code writes but no code ever reads. Likely useless data — the application stores values nothing downstream consumes. Could indicate dead code, an in-progress feature, or a column that should be dropped.

### `storageSelectorIndexMismatch` *(reserved)*

**Severity:** error

A `findUnique`-style selector references a column set that isn't a unique index on the table. At runtime the call fails (Prisma / typed ORMs reject at the type level; raw SQL drivers and Drizzle compile but the query returns non-deterministic single rows). Pairs the `interaction.selector` field on a storage-access interaction against the `indexes` declared on the provider's `storageContract`. Emitter ships when an access pack needs it (likely Drizzle / raw-SQL packs, where TypeScript doesn't catch the case).

### `storageTypeMismatch` *(reserved)*

**Severity:** error

Code writes a value of one type to a column of an incompatible type (string to Int, number to text). Typed ORMs (Prisma, Drizzle) generally catch this at the TypeScript level; emitter waits for raw-SQL packs or values that escape the type system via `any`.

### `storageNullableViolation` *(reserved)*

**Severity:** error

Code writes `null` to a `NOT NULL` column, or treats the value of a nullable column as definitely-non-null without a guard. Typed ORMs cover the common case via generated types; emitter waits for raw-SQL packs or escape-hatch detection.

### `storageLengthConstraintViolation` *(reserved)*

**Severity:** error

Code writes a string literal longer than the column's declared length (`varchar(50)` written with 200+ chars). Requires both the literal length and the column constraint to be statically known. Useful even with typed ORMs since TypeScript doesn't model string lengths.

### `storageEnumConstraintViolation` *(reserved)*

**Severity:** error

Code writes a value that isn't in the column's declared enum set. Typed ORMs catch this at the TS level when the value is a typed enum literal; emitter waits for cases where the value escapes the type system or comes from a raw-SQL pack.

---

## Message-bus findings

### `messageBusProducerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

Code sends a message to a queue / topic that no provider in the analysed scope declares. Common false-positive sources are multi-repo deployments (queue declared in another stack) and work-in-progress before infra is wired up.

```
[WARNING] messageBusProducerOrphan
  Producer sends to channel "ORDERS_QUEUE_URL" but no message-bus
  provider in the analysed scope declares a queue at that channel.
  provider: — (orphan)
  consumer: src/order-producer.ts::sendOrder (src/order-producer.ts:9)
  boundary: aws-sqs (sqs) message-bus:sqs:ORDERS_QUEUE_URL
```

**Fix:** add the contract source that declares the queue (CloudFormation / SAM template) — or, if intentional, suppress.

### `messageBusConsumerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A consumer Lambda is wired to receive from a channel but no code in the project sends to that channel. Could be dead infra, or the producer lives in a different repo.

### `messageBusUnused` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A queue / topic is declared in infrastructure but neither produced to nor consumed from anywhere in the project. Likely orphan resource left over from a removed feature.

---

## Runtime-config findings

### `envVarUnprovided` *(shipped)*

**Severity:** error • **Emitted by:** `checkRuntimeConfig`

Code reads `process.env.X` from a source file scoped to a deployable runtime instance, but that runtime's declared env-var contract doesn't include `X`. Dominant cause is a typo or a declaration omission between code and infrastructure template (CFN / SAM / k8s manifest). At deploy time this surfaces as a runtime undefined.

```
[ERROR] envVarUnprovided
  Code reads process.env.DATABASE_URL but Lambda Environment for OrderHandler
  declares no DATABASE_URL variable. At runtime this resolves to undefined.
  provider: template.yaml::OrderHandler (template.yaml:42)
  consumer: src/db.ts::createConnection (src/db.ts:7)
  boundary: cloudformation (aws-https) runtime-config:OrderHandler
```

**Fix:** add the variable to the template, or correct the name in code.

### `envVarUnused` *(shipped)*

**Severity:** warning • **Emitted by:** `checkRuntimeConfig`

A deployable runtime instance declares an env var that no code in its codeScope reads. Usually dead config left over from a removed feature, or a renamed var the template still references. The deployment still works, but the contract has stale fields.

### `runtimeScopeUnknown` *(shipped)*

**Severity:** info • **Emitted by:** `checkRuntimeConfig`

A runtime-config-bound provider summary declares no `codeScope` (or one we couldn't resolve to source files), so the env-var contract can't be paired against any code. Heads-up that verification was skipped, not a defect in the code itself. Common cause: raw CloudFormation that uses S3-built artifacts (no `CodeUri`) without a `Metadata.SussCodeScope` annotation.

**Fix:** add `Metadata: { SussCodeScope: { CodeUri: "src/handlers/x" } }` to the resource, or wire CodeUri through.

### `envVarRequiredButUnmarked` *(reserved)*

**Severity:** warning

Code treats `process.env.X` as definitely-required (e.g. `if (!process.env.X) throw …` or unconditional read), but the runtime contract doesn't mark it as required (no deployment-side validation, no documented requirement). Emitter waits for the runtime contract to grow a "required" attribute on env-var entries (currently the contract is just the name list).

### `envVarTypeCoercionMissing` *(reserved)*

**Severity:** warning

Code reads an env var as if it were a non-string type (`process.env.PORT` used as a number without `Number(...)`; `process.env.FLAG` used as a boolean without comparison) without the coercion the runtime contract implies. Env vars are always strings at the OS interface; code that forgets that flips truthy checks (`"0"` is truthy) and produces silent type errors.

---

## Meta findings

### `lowConfidence` *(shipped)*

**Severity:** info • **Emitted by:** any check, as a meta-finding

The analyser couldn't fully decompose the summary — predicates stayed opaque, type resolution failed, or confidence dropped below `medium`. Informational: helps reviewers know when to read the actual source rather than trust the finding's absence.

### `unsupportedSemantics` *(reserved)*

**Severity:** info

A pack identifies a boundary it doesn't know how to summarise — a WebSocket subscription handler, an SSE stream producer, a gRPC streaming method, etc. The pack should still emit a stub-shaped summary marking the boundary's existence; this finding alerts users that the extracted summary won't pair against consumers because the semantics aren't modelled. Emitter ships when a pack first encounters a boundary it can't fully describe.

### `opaquePredicateBlocking` *(reserved)*

**Severity:** info

A pairing pass refused to emit substantive findings because too many predicates on the relevant transitions are opaque (the extractor couldn't decompose them; preconditions / branches show as raw source text). Distinct from `lowConfidence`, which is per-summary; this is per-pair — pairing produced no signal because the inputs were too murky to reason over. Emitter ships when a pairing pass adds an explicit "I bailed" disclosure.

---

## What this catalog is *not*

- **Not every tool's finding.** Downstream tools built on top of `@suss/behavioral-ir` can emit their own kinds; those aren't listed here.
- **Not a spec.** The authoritative list is `FindingKindSchema` in [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts), with JSDoc that this page mirrors.
- **Not exhaustive for severity mapping.** Severities shown are the defaults the checker emits. `.sussignore` rules can downgrade or hide any finding — see [Suppressions](/suppressions).
- **Not a roadmap.** The *reserved* tag means the kind exists in the IR enum but no checker emits it yet; it doesn't promise an emitter will land soon.
