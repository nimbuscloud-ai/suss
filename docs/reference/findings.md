# Findings catalog

Every finding kind in the IR's `FindingKindSchema`. Use this as the lookup when a finding surfaces and you want to know whether it's a bug or noise.

The authoritative source is `FindingKindSchema` in [`packages/behavioral-ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/src/schemas.ts), every kind below appears there with the same wording.

## Finding shape

Every finding follows the same JSON shape:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string (one of the values below) | Which failure mode this is. |
| `severity` | `error` \| `warning` \| `info` | Default severity. `.sussignore` rules can downgrade. |
| `boundary` | `BoundaryBinding` | Which boundary the finding is about (REST endpoint, storage table, message-bus channel, runtime-config scope, etc.). The kind of binding depends on the finding's domain. |
| `provider` | `FindingSide` | The summary on the provider side: `{ summary, transitionId?, location }`. `summary` is `${file}::${name}`. `transitionId` is set when the finding is about a specific branch. |
| `consumer` | `FindingSide` | The summary on the consumer side. Always populated, even for self-inconsistency findings (provider-against-its-own-contract); in that case provider and consumer often resolve to the same summary. |
| `description` | string | One-line human-readable text. |
| `aspect` | `BoundaryAspect?` | For generic boundary findings, this says which side of the field the finding concerns: `read` / `write` / `send` / `receive` / `construct` / `selector`. Absent on findings where the aspect is irrelevant or spans multiple aspects. |
| `sources` | `string[]?` | Present only when two or more identical findings from different providers were collapsed by the dedupe pass. Each entry is a `${file}::${name}` matching `FindingSide.summary`. |
| `suppressed` | `FindingSuppression?` | Present only when a `.sussignore` rule matched. It contains `{ reason, effect, originalSeverity? }`, see [Suppressions](/suppressions). |

## How a kind gets its severity

One principle decides every default severity.

- **Error: the code will misread or lose data on an input that the other side produces.** The claim is about behavior, both sides are in the run, and the corpus says the kind is usually right when it fires.
- **Warning: the two sides disagree in a way that needs a person to judge.** The disagreement is there in the files, and whether it is a defect depends on intent the repository does not state.
- **Info: suss is reporting on itself.** Confidence, coverage, something it could not read. Never about the code being wrong.

The test for error is outcome-shaped: name the input and the wrong result. Every kind below states that sentence next to its severity. A kind for which no such sentence can be written is a warning by construction. A kind at error whose measured precision over the pinned corpus falls under half moves down until its model improves; that is how `unhandledProviderCase` moved to warning.

---

Three of the kinds below, `boundaryFieldUnknown`, `boundaryFieldUnused`, and `boundaryShapeMismatch`, are **generic** and emitted by every per-domain checker. The boundary's `binding.semantics.name` gives you the domain context (storage, runtime-config, graphql-resolver, message-bus, etc.), and the `aspect` field says which direction the failure runs in. The remaining kinds are domain-specific or meta.

The catalog is organised: **shipped generic kinds**, then **shipped domain-specific kinds** grouped by domain, then **reserved kinds** (in the IR enum, awaiting an emitter), then **meta kinds**.

---

## Generic boundary findings (shipped)

These three kinds replace the per-domain field-mismatch enums earlier versions used (`storageReadFieldUnknown`, `envVarUnprovided`, `graphqlSelectionFieldUnknown`, `scenarioArgUnknown`, etc. all collapsed into `boundaryFieldUnknown` with an aspect).

### `boundaryFieldUnknown`

**Severity:** error (read / write aspects against a contract in the run), warning (construct / send aspects, or a provider suss did not extract) • **Emitted by:** every domain pairing pass

A read of a field the contract does not declare comes back with nothing, no error says so, and the code branches on what is not there. That is the error sentence; the construct / send aspects and the missing-provider case cannot state one, so they stay warnings.

The consumer references a field the provider's contract doesn't declare. Per-domain instances:

- **Storage** (`binding.semantics.name = "storage"`, aspect `read` or `write`)
  ```
  [ERROR] boundaryFieldUnknown (aspect: read)
    loadUser selects "deltedAt" on User (postgresql) but the schema declares
    no deltedAt column. At runtime this resolves to undefined on reads,
    changing which execution paths the function takes downstream.
    provider: prisma/schema.prisma::User
    consumer: src/loadUser.ts::loadUser
    boundary: prisma (in-process) storage:postgresql:default:User
  ```

- **Runtime config** (`binding.semantics.name = "runtime-config"`, aspect `read`)
  ```
  [ERROR] boundaryFieldUnknown (aspect: read)
    process.env.DATABASE_URL read by createConnection but OrderHandler
    declares no DATABASE_URL in its environment.
    provider: template.yaml::OrderHandler
    consumer: src/db.ts::createConnection
    boundary: cloudformation (aws-https) runtime-config:OrderHandler
  ```

- **GraphQL** (`binding.semantics.name = "graphql-operation"`, aspect `read`)
  ```
  [ERROR] boundaryFieldUnknown (aspect: read)
    GraphQL operation "usePet.GetPet" selects "Pet.deletedAt" but the
    provider's schema doesn't declare that field on "Pet". Likely a
    stale selection after a schema change.
    provider: Pet.deletedAt (undeclared)
    consumer: src/usePet.ts::usePet.GetPet
    boundary: apollo-client (http) query GetPet
  ```
  The server rejects the whole operation at validation, so every operation using the selection fails, not only the one field. A selection kept in a shared fragment breaks every operation that spreads it.

  *(Also fires at warning for a missing root resolver, operation selects `Query.deletedAt` but no extracted resolver implements it. That resolver may live in a repository suss did not read, so the provider side is not in the run and no outcome can be stated.)*

- **React / Storybook** (`binding.semantics.name = "function-call"`, aspect `construct`)
  ```
  [WARNING] boundaryFieldUnknown (aspect: construct)
    Story "Broken" provides arg "disabled" but component "Button" does
    not declare it as an input.
  ```

**Legitimate when:** the provider lives in a service / contract source you haven't extracted (microservice boundary, multi-repo). Suppress with `.sussignore` `effect: mark`.

**Bug when:** typo, rename without follow-through, or stale code referencing a removed field. Fix the consumer or restore the contract.

### `boundaryFieldUnused`

**Severity:** warning • **Emitted by:** every domain pairing pass

No input produces a wrong result here: an unread field breaks nothing at runtime, and whether it is dead or reserved for future use is intent the repository does not state.

The provider declares a field that no consumer references. Per-domain instances:

- **Storage** (no aspect = "no reader and no writer")
  ```
  [WARNING] boundaryFieldUnused
    User declares column "deletedAt" but no code in the project reads
    or writes it.
    boundary: prisma (in-process) storage:postgresql:default:User
  ```
  suss suppresses this when ANY caller uses default-shape (`["*"]`) reads on the table, because then we can't tell whether default-shape consumers actually use the column.

- **Storage write-only** (aspect `read` = "the read aspect of this field is unused, but writers exist")
  ```
  [WARNING] boundaryFieldUnused (aspect: read)
    User declares column "lastWriteAt" and code writes it, but no code
    in the project reads it. Likely useless data. The application
    stores values nothing downstream consumes.
  ```

- **Runtime config** (no aspect)
  ```
  [WARNING] boundaryFieldUnused
    OrderHandler declares environment variable LEGACY_FLAG but no code
    in its codeScope reads process.env.LEGACY_FLAG.
    boundary: cloudformation (aws-https) runtime-config:OrderHandler
  ```

**Legitimate when:** the field is reserved for future use, or read by code outside the analyzed scope (different repo). Suppress.

**Bug when:** dead config left from a removed feature, or a renamed field the contract still references. Remove from the contract, or restore the consumer.

### `boundaryShapeMismatch` *(shipped)*

**Severity:** per-emitter (typically warning for read-side coercions, error for write-side type mismatches) • **Emitted by:** `checkMetric`

The error sentence for the one shipped emitter: the alert compares each window against a single number, the metric records a spread of buckets, so the comparison never runs against what the metric actually measures and the alert never fires.

Both sides declare the value but disagree about its form (type, nullability, content-type, etc.). The `aspect` says which side discovered the disagreement (read / write / send / receive / construct / selector).

`checkMetric` is the one emitter today. A monitoring system's alert compares a series against a single number, and the resource that declares the series says its measurements are a histogram of buckets, so the comparison has nothing to run against:

```
[ERROR] boundaryShapeMismatch (aspect: read)
  google_monitoring_alert_policy.sweep_refused_sustained#0 compares
  logging.googleapis.com/user/sweep-refused against a single number, and
  google_logging_metric.sweep_refused declares that metric's measurements
  as a histogram of buckets, so the comparison has nothing to run against
  unless the reading reduces each window to a single number first, by
  setting aggregations.per_series_aligner to one of ALIGN_PERCENTILE_99,
  ALIGN_PERCENTILE_95, ALIGN_PERCENTILE_50, ALIGN_PERCENTILE_05.
  provider: monitoring.tf::google_logging_metric.sweep_refused
  consumer: monitoring.tf::google_monitoring_alert_policy.sweep_refused_sustained#0
  boundary: terraform (cloud-monitoring)
```

Both sides have to say what the value is. A metric whose summary states no `metadata.metricContract.values`, and a reading that states no `metadata.metricReading.comparesTo`, claim nothing here.

The kind is also where the message-bus body-shape pairing will report, along with the type-aware extensions of the storage / runtime-config / graphql checkers. It subsumes the per-domain shape-mismatch kinds earlier versions reserved (`storageTypeMismatch`, `storageNullableViolation`, `storageSelectorIndexMismatch`, `envVarTypeCoercionMissing`, `graphqlVariableTypeMismatch`, `requestBodyShapeMismatch`, `componentPropTypeMismatch`, `contentTypeMismatch`).

### `boundaryFieldRequired`

**Severity:** error

A request sent without the required field is rejected by the provider, so the call fails every time it runs: a 4xx, or a component that fails to render.

The provider declares a field as required and the consumer doesn't supply it. The `aspect` usually points at the payload (`send` / `construct`).

No emitter ships today. This kind subsumes earlier per-domain reserved kinds: `requiredHeaderMissing`, `requiredQueryParamMissing`, `componentRequiredPropMissing`, `graphqlRequiredArgMissing`.

### `boundaryConstraintViolation`

**Severity:** per-emitter

Each emitter states its own outcome sentence when it ships: a value the store refuses loses the write, while a value the store silently truncates loses part of it.

The value supplied for a field violates a value-level constraint the provider declared, enum membership, declared length, etc. This is distinct from `boundaryShapeMismatch` because the value's *type* is correct; only the value itself violates the constraint.

No emitter ships today. This kind subsumes earlier per-domain reserved kinds: `storageLengthConstraintViolation`, `storageEnumConstraintViolation`, `graphqlEnumValueUnknown`.

### `boundarySelectorMismatch` *(shipped)*

**Severity:** error • **Emitted by:** `checkStorage`

The consumer picks items by something the provider does not key on. A store that only accepts its key attributes in a query refuses the request, so every run of this query fails rather than returning nothing.

```
[ERROR] boundarySelectorMismatch (aspect: read)
  listByCustomer picks items on Orders by "customerId", which is not one
  of its key attributes (orderId). DynamoDB refuses a request keyed on
  anything else, so this fails when it runs.
  provider: template.yaml::Orders
  consumer: src/listByCustomer.ts::listByCustomer
  boundary: cloudformation (aws-sdk) storage:aws.dynamodb:default:Orders
```

A contract that does not state `metadata.storageContract.identifies` claims nothing here, and neither does an access that states no selector. A query through a secondary index pairs against that index's own summary, so it is checked against the index's key rather than the table's.

---

## REST findings

### `unhandledProviderCase` *(shipped)*

**Severity:** warning • **Emitted by:** `checkProviderCoverage`, `checkSemanticBridging`

No outcome sentence can be written: the fall-through may be the intended handling, and over the pinned corpus the uncovered-status form was wrong far more often than right. The error-worthy core of the old kind, a path that will actually misread a response, is `misreadProviderResponse` below.

The provider produces a status code (or a body case within a status) that no consumer branch tells apart. The consumer hits its fall-through path, throwing, returning undefined, or silently ignoring, when the provider returns that status.

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/handler.ts::getUser
  consumer: src/client.ts::loadUser
  boundary: ts-rest (http) GET /users/:id
```

A provider response declared as a range (an OpenAPI `4XX`) is one declared response that may arrive with any status in it. It counts as covered when the consumer covers any member (a branch on 404, a `!res.ok` guard, a catch on a throwing client), and when nothing covers any member it reports once:

```
[WARNING] unhandledProviderCase
  Provider produces statuses in the 4XX range but no consumer branch handles any of them
```

**Legitimate when:** the consumer truly doesn't care (it has a `try/catch`, or the throw path is correct).

**Bug when:** the consumer silently ignores the status. Add a branch (e.g. `if (res.status === 404) return null`).

### `misreadProviderResponse` *(shipped)*

**Severity:** error • **Emitted by:** `checkResponseMisread`

The path runs on a response the provider sends, reads a field that response's body does not include, and nothing on the path tells that response apart from one that does include it. Whatever the path does with the value runs on undefined.

```
[ERROR] misreadProviderResponse (aspect: read)
  The consumer's fall-through path reads "name", but the 200 body the
  provider sends does not include it, and neither does any other
  response. The read comes back undefined and no error says so.
  provider: backend/src/server.ts::get
  consumer: frontend/src/loadUser.ts::loadUser
  boundary: express (http) GET /users/:id
```

This is `unhandledProviderCase` restated as a behavior claim rather than a coverage claim, and it is the same question the storage and GraphQL read checks ask: does the code read something the other side does not supply. It stays narrow on purpose:

- A field any of the consumer's guards test is never reported. `if (res.error)` is how the consumer tells the failure body apart, so `error` coming back undefined on the 200 is an answer, not a misread.
- A body with spreads or an opaque shape claims nothing, and a status the provider returns with several bodies fires only when every one of them lacks the field.
- The branch has to run on the response: a status guard, a range like `!res.ok`, or the fall-through over the 2xx class. A branch guarded on a body field never runs on a response whose body cannot satisfy the guard.
- A response declared as a range (an OpenAPI `4XX`) is one response that may arrive with any status in it, so a branch on 404 is judged against the `4XX` body, and the finding says which (`the 4XX body the provider sends`).

**Legitimate when:** the provider sends the field through a path suss could not read (a wrapper, a spread it flattened away). Suppress with `.sussignore`.

**Bug when:** a rename or a copy-paste left the consumer reading a field this endpoint never sends. Fix the read, or the provider.

### `deadConsumerBranch` *(shipped)*

**Severity:** warning • **Emitted by:** `checkConsumerSatisfaction`

The branch never runs, and nothing misreads at runtime because of it, so no outcome sentence can be written. Whether to delete it or to fix the provider is a judgement.

The consumer has a branch that reads a status the provider never produces. It usually comes from a consumer copy-pasted from another endpoint.

A status inside a range the provider declares (404 against an OpenAPI `4XX`) is produced, and a provider with a `default` response produces any status, so neither makes a branch dead.

**Fix:** delete the branch, or add the missing status to the provider contract.

### `providerContractViolation` *(shipped)*

**Severity:** error • **Emitted by:** `checkContractConsistency`

A caller built to the declared contract meets a status or a body the contract never told it about, and takes a path written for something else.

The provider produces a status code (or body shape) its declared contract doesn't include. This is a self-inconsistency: the provider and consumer fields point at the same summary. The checker skips it when the contract source is itself derived from the implementation.

Every `unhandledCase` gap on the provider surfaces here. An `unreadOutcome` gap does not; it comes out as `lowConfidence` at info instead, because it means the pack has no form for what the handler returns, rather than meaning the handler is wrong.

**Fix:** add the status to the contract, or remove it from the handler.

### `consumerContractViolation` *(shipped)*

**Severity:** warning (info for a read of a field the contract declares optional) • **Emitted by:** `checkContractConsistency`, `checkConsumerContract`, `checkBodyCompatibility`

No outcome can be stated against a contract alone: a branch for an undeclared status never runs, and a missing branch may be the intended fall-through. Which side is right, the branch or the contract, is a judgement.

The consumer's expected statuses or body-field reads disagree with the contract. It handles a status the contract doesn't declare, fails to handle one the contract requires, or reads a body field the contract doesn't promise.

A contract's range and `default` entries widen what is declared: a branch on 404 agrees with a declared `4XX`, and nothing is undeclared against a contract with a `default`. A declared range the consumer handles no member of reports once (`Contract declares 4XX responses but consumer handles none of them`).

### `contractDisagreement` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractAgreement`

Two contract sources disagree and at most one of them is right; which one is a judgement the repository does not settle.

Two or more providers at the same boundary (e.g. an OpenAPI spec and a CFN template) declare contracts that disagree. `sources` lists every contributor.

```
[WARNING] contractDisagreement
  OpenAPI declares {200, 404} but CFN template MethodResponses declares {200, 404, 500}
  sources: ["petstore.yaml::getPet", "template.yaml::getPet"]
  boundary: openapi (http) GET /pets/:id
```

### `contractOperationUnimplemented` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractCompleteness`

The handler may live in a repository suss did not read, so no outcome can be stated; whether the operation is missing or elsewhere is a judgement.

A contract source (an OpenAPI document, a CFN template) declares an operation and no extracted provider implements it.

```
[WARNING] contractOperationUnimplemented
  The openapi contract declares DELETE /pets/{petId} and no extracted
  provider implements it.
```

**Legitimate when:** the handler lives in another repository or service. Suppress.

**Bug when:** the operation was removed from the code and the contract still declares it. Remove it from the contract.

---

## GraphQL findings

Most GraphQL failure modes surface through the generic kinds (`boundaryFieldUnknown` with a `graphql-resolver` boundary, `ambiguousProvider` across two services). This kind is specific to how GraphQL clients ship documents.

### `graphqlUnknownFragment` *(shipped)*

**Severity:** error • **Emitted by:** `pairGraphqlOperations`

This operation ships a document spreading a fragment with no definition, and no fragment registry is configured, so the query throws `Unknown fragment` when it runs.

```
[ERROR] graphqlUnknownFragment
  GraphQL operation "<anon>.CheckOrderInvoicesStatus" ships a document
  spreading "...Invoice" with no definition, and no fragment registry is
  configured, so the query throws `Unknown fragment: Invoice` when it runs.
  consumer: src/containers/BackgroundTasks/BackgroundTasksProvider.tsx::<anon>.CheckOrderInvoicesStatus
  boundary: apollo-client (http)
```

Three readings line up before it fires:

- The document that reaches the call site is the one with the dangling spread. A codegen-composed version that defines the fragment never fires it, because the finding attaches to the document that is used.
- Every client construction in the project was read and none installs a fragment registry (`createFragmentRegistry` on the cache's `fragments` option), the one runtime mechanism that could supply the definition. A client the pack cannot see the construction of counts as unknown, and unknown means the info-level `lowConfidence` finding instead, never this one.
- The spread has no definition anywhere in the shipped document.

**Legitimate when:** the call site never runs (dead code behind a disabled flag). Suppress with `.sussignore`, or delete the code.

**Bug when:** the import points at the raw source document instead of the codegen output, which is the shape that produced the kind. Import the composed document, or register the fragment on the cache.

---

## React / Storybook findings

### `scenarioCoverageGap` *(shipped)*

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

Nothing misbehaves at runtime; the branch is merely undeclared in the stories, and whether it deserves one is a judgement.

A component has a conditional branch that depends on a prop, but no story supplies that prop. The branch exists with no declared coverage, so a change can break it silently.

**Fix:** add a story that exercises the branch.

---

## Message-bus findings

### `messageBusProducerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

The queue may be declared in a stack suss did not read, so the provider side is not in the run and no outcome can be stated.

Code sends a message to a queue / topic that no provider in the analyzed scope declares. Common false-positives: multi-repo deployments (queue declared in another stack); work-in-progress before infra is wired up.

**Fix:** add the contract source that declares the queue, or suppress.

### `messageBusConsumerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A consumer Lambda is wired to receive from a channel but no code in the project sends to that channel. It could be dead infra, or the producer may live in a different repo; which of the two needs a person.

### `messageBusUnused` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A queue / topic is declared in infrastructure but neither produced to nor consumed from anywhere in the project. Nothing breaks at runtime; it is probably an orphan resource left over from a removed feature, and removing it is a judgement.

### `messageBusConsumerDisabled` *(shipped)*

**Severity:** info • **Emitted by:** `checkMessageBus`

A rule or subscription deploys switched off (`State: DISABLED`), so its target receives nothing until someone enables it. The subscription is not counted as a consumer anywhere in the pass: a producer whose only subscriber is disabled is reported as `messageBusProducerOrphan`, the disabled rule is never reported as a waiting `messageBusConsumerOrphan`, and its channel is not reported as `messageBusUnused` (switched off on purpose is not left over).

---

## Runtime-config findings

### `runtimeScopeUnknown` *(shipped)*

**Severity:** info • **Emitted by:** `checkRuntimeConfig`

suss could not tell which code a runtime runs, so it paired that runtime's env-var contract against none. This tells you verification was skipped; it is not a defect in the code itself. There are two ways to get here.

The provider declares no `codeScope`, or one we couldn't resolve to source files. Common cause: raw CloudFormation that uses S3-built artifacts (no `CodeUri`).

**Fix:** add `Metadata: { SussCodeScope: { CodeUri: "src/handlers/x" } }` to the resource, or wire CodeUri through.

Or several providers declare a directory containing the same source file, and the code in that file does not say which deployable unit it belongs to. A service that builds every one of its functions from the service root gives them all the same directory, and then nothing says which function runs a shared helper. Attributing the helper to all of them would report one `process.env` read once per function.

**Fix:** let a pack discover the code under a template entry so it comes with a deployable unit, or give each function a `CodeUri` covering only its own sources.

---

## Reserved kinds *(in IR enum, no emitter yet)*

These kinds exist in the enum but no checker emits them today. They cover failure modes distinct enough not to fold into the generic `boundaryField*` / `boundaryShapeMismatch` family.

- `restMethodOnUnknownPath`: error. Every call to the missing endpoint returns a 404 the caller wrote no branch for. The consumer's call targets a `(method, path)` the provider doesn't expose. This is distinct from `boundaryFieldUnknown` because the mismatch is at the boundary identity level (the endpoint itself), not at field level. Today's pairing layer leaves both summaries unmatched, which quietly obscures what is probably a typo. The emitter ships once the pairing layer adds a "consumer with no provider" finding distinct from "unmatched / no boundary binding."
- `authPolicyMismatch`: error. Every call without the credential the provider requires is rejected, so the consumer's request fails whenever it runs. The provider requires authentication and the consumer's call doesn't supply it correctly. This one is boundary-level (auth policy) rather than field-level, so it is kept distinct from the generic kinds. It needs auth-policy modeling on both sides (OpenAPI security schemes plus the client-side header / interceptor patterns).
- `envVarRequiredButUnmarked`: warning. Nothing misreads while the var is set; the contract merely understates what the code needs, and tightening it is a judgement. The code treats `process.env.X` as definitely-required (`if (!process.env.X) throw …`) but the runtime contract doesn't mark it required. This is about contract-side metadata rather than a disagreement over a field or its form. The emitter waits for the runtime contract to grow a "required" attribute on env-var entries.

---

## Meta findings

### `lowConfidence` *(shipped)*

**Severity:** info • **Emitted by:** any check, as a meta-finding

suss could not finish reading one side, so it says so rather than guessing. Predicates stayed opaque, type resolution failed, or confidence dropped below `medium`.

It also reports every `unreadOutcome` gap on the provider. That gap means a `return` in the handler matched none of the terminal shapes the pack looks for:

```
[INFO] lowConfidence
  One return in this function matches none of the terminal shapes this
  pack looks for, so what it produces is not described here
```

**Fix:** teach the pack that terminal shape. Until then the handler is under-described, not wrong, which is why this is info and not an error.

### `unsupportedSemantics` *(reserved)*

**Severity:** info

A pack identifies a boundary it doesn't know how to summarise, a WebSocket subscription handler, an SSE stream producer, a gRPC streaming method, etc. The emitter ships when a pack first encounters such a boundary.

### `opaquePredicateBlocking` *(reserved)*

**Severity:** info

A pairing pass refused to emit substantive findings because too many predicates on the relevant transitions are opaque. This one is per-pair, in contrast to `lowConfidence`, which is per-summary.

### `ambiguousProvider`

**Severity:** warning

Which of the colliding providers the code reaches needs a person; the run itself cannot settle it, and nothing is known to misbehave.

One consumer matched two providers where at most one of them can be right.

Two GraphQL services in one repo can each declare `Query.user`, and the key has no endpoint identity to tell them apart, so the operation pairs with both and some of those pairs are wrong. The finding says which services collided so you can see where the extra pairs came from.

Storage says it for a container. A table declared as `{StageName}-orders-blue` and one declared as `prod-orders-{Colour}` are both called something that covers `prod-orders-blue`, and each states as much of its name as the other, so nothing in the run says which one the code reaches. The access pairs with neither and this finding says which two were in the way. When one of the two states more of its name, that one takes the access and no finding is emitted.

---

## What this catalog is *not*

- **Not every tool's finding.** Downstream tools built on top of `@suss/behavioral-ir` can emit their own kinds; those aren't listed here.
- **Not a spec.** The authoritative list is `FindingKindSchema` in [`packages/behavioral-ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/src/schemas.ts).
- **Not exhaustive for severity mapping.** Severities shown are the defaults the checker emits. `.sussignore` rules can downgrade or hide any finding, see [Suppressions](/suppressions).
- **Not a roadmap.** The *reserved* tag means the kind exists in the IR enum but no checker emits it yet; it doesn't promise an emitter will land soon.
