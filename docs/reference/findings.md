# Findings catalog

Every finding kind in the IR's `FindingKindSchema`. Use this as the lookup when a finding surfaces and you want to know whether it's a bug or noise.

The authoritative source is `FindingKindSchema` in [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts) — every kind below appears there with the same wording.

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
| `aspect` | `BoundaryAspect?` | For generic boundary findings, names which side of the field the finding concerns: `read` / `write` / `send` / `receive` / `construct` / `selector`. Absent on findings where the aspect is irrelevant or spans multiple aspects. |
| `sources` | `string[]?` | Present only when two or more identical findings from different providers were collapsed by the dedupe pass. Each entry is a `${file}::${name}` matching `FindingSide.summary`. |
| `suppressed` | `FindingSuppression?` | Present only when a `.sussignore` rule matched. Carries `{ reason, effect, originalSeverity? }` — see [Suppressions](/suppressions). |

Three of the kinds below — `boundaryFieldUnknown`, `boundaryFieldUnused`, and `boundaryShapeMismatch` — are **generic** and emitted by every per-domain checker. The boundary's `binding.semantics.name` carries the domain context (storage-relational, runtime-config, graphql-resolver, message-bus, etc.); the `aspect` field distinguishes the failure direction. The remaining kinds are domain-specific or meta.

The catalog is organised: **shipped generic kinds**, then **shipped domain-specific kinds** grouped by domain, then **reserved kinds** (in the IR enum, awaiting an emitter), then **meta kinds**.

---

## Generic boundary findings (shipped)

These three kinds replace the per-domain field-mismatch enums earlier versions used (`storageReadFieldUnknown`, `envVarUnprovided`, `graphqlSelectionFieldUnknown`, `scenarioArgUnknown`, etc. all collapsed into `boundaryFieldUnknown` with an aspect).

### `boundaryFieldUnknown`

**Severity:** error (read / write aspects), warning (construct / send aspects) • **Emitted by:** every domain pairing pass

The consumer references a field the provider's contract doesn't declare. Per-domain instances:

- **Storage** (`binding.semantics.name = "storage-relational"`, aspect `read` or `write`)
  ```
  [ERROR] boundaryFieldUnknown (aspect: read)
    loadUser selects "deltedAt" on User (postgres) but the schema declares
    no deltedAt column. At runtime this resolves to undefined on reads,
    changing which execution paths the function takes downstream.
    provider: prisma/schema.prisma::User
    consumer: src/loadUser.ts::loadUser
    boundary: prisma (in-process) storage:postgres:default:User
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
  [WARNING] boundaryFieldUnknown (aspect: read)
    GraphQL operation "usePet.GetPet" selects "Pet.deletedAt" but the
    provider's schema doesn't declare that field on "Pet". The server
    response will not include it.
    provider: Pet.deletedAt (undeclared)
    consumer: src/usePet.ts::usePet.GetPet
    boundary: apollo-client (http) query GetPet
  ```
  *(Also fires for missing root resolvers — operation selects `Query.deletedAt` but no resolver implements it.)*

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

The provider declares a field that no consumer references. Per-domain instances:

- **Storage** (no aspect = "no reader and no writer")
  ```
  [WARNING] boundaryFieldUnused
    User declares column "deletedAt" but no code in the project reads
    or writes it.
    boundary: prisma (in-process) storage:postgres:default:User
  ```
  Suppressed when ANY caller uses default-shape (`["*"]`) reads on the table — at that point we can't tell whether default-shape consumers actually use the column.

- **Storage write-only** (aspect `read` = "the read aspect of this field is unused, but writers exist")
  ```
  [WARNING] boundaryFieldUnused (aspect: read)
    User declares column "lastWriteAt" and code writes it, but no code
    in the project reads it. Likely useless data — the application
    stores values nothing downstream consumes.
  ```

- **Runtime config** (no aspect)
  ```
  [WARNING] boundaryFieldUnused
    OrderHandler declares environment variable LEGACY_FLAG but no code
    in its codeScope reads process.env.LEGACY_FLAG.
    boundary: cloudformation (aws-https) runtime-config:OrderHandler
  ```

**Legitimate when:** field is reserved for future use, or read by code outside the analysed scope (different repo). Suppress.

**Bug when:** dead config left from a removed feature, or a renamed field the contract still references. Remove from the contract, or restore the consumer.

### `boundaryShapeMismatch`

**Severity:** per-emitter (typically warning for read-side coercions, error for write-side type mismatches)

Both sides declare the field but disagree on its shape (type, nullability, enum membership, etc.). The `aspect` names which side discovered the disagreement.

No emitter ships today — reserved for the imminent message-bus body-shape pairing and the type-aware extensions of storage / runtime-config / graphql checkers (subsumes the reserved per-domain kinds `storageTypeMismatch`, `envVarTypeCoercionMissing`, `graphqlVariableTypeMismatch`, `requestBodyShapeMismatch`).

---

## REST findings

### `unhandledProviderCase` *(shipped)*

**Severity:** warning • **Emitted by:** `checkProviderCoverage`, `checkBodyCompatibility`

The provider produces a status code (or a body field on a status) that no consumer branch reads. The consumer hits its fall-through path — throwing, returning undefined, or silently ignoring — when the provider returns that status.

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/handler.ts::getUser
  consumer: src/client.ts::loadUser
  boundary: ts-rest (http) GET /users/:id
```

**Legitimate when:** the consumer truly doesn't care (it has a `try/catch`, or the throw path is correct).

**Bug when:** the consumer silently ignores the status. Add a branch (e.g. `if (res.status === 404) return null`).

### `deadConsumerBranch` *(shipped)*

**Severity:** error • **Emitted by:** `checkConsumerSatisfaction`

The consumer has a branch that reads a status the provider never produces. Code that will never run — usually drift from a consumer copy-pasted from another endpoint.

**Bug when:** common. Delete the branch, or add the missing status to the provider contract.

### `providerContractViolation` *(shipped)*

**Severity:** error • **Emitted by:** `checkContractConsistency`

The provider produces a status code (or body shape) its declared contract doesn't include. Self-inconsistency — provider and consumer fields point at the same summary. Skipped when the contract source is itself derived from the implementation.

**Fix:** add the status to the contract, or remove it from the handler.

### `consumerContractViolation` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractConsistency`, `checkConsumerContract`, `checkBodyCompatibility`

The consumer's expected statuses or body-field reads disagree with the contract — handles a status the contract doesn't declare, fails to handle one the contract requires, or reads a body field the contract doesn't promise.

### `contractDisagreement` *(shipped)*

**Severity:** warning • **Emitted by:** `checkContractAgreement`

Two or more providers at the same boundary (e.g. an OpenAPI spec and a CFN template) declare contracts that disagree. `sources` lists every contributor.

```
[WARNING] contractDisagreement
  OpenAPI declares {200, 404} but CFN template MethodResponses declares {200, 404, 500}
  sources: ["petstore.yaml::getPet", "template.yaml::getPet"]
  boundary: openapi (http) GET /pets/:id
```

---

## React / Storybook findings

### `scenarioCoverageGap` *(shipped)*

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

A component has a conditional branch that depends on a prop, but no story supplies that prop. The branch exists with no declared coverage — changes can regress silently.

**Fix:** add a story that exercises the branch.

---

## Message-bus findings

### `messageBusProducerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

Code sends a message to a queue / topic that no provider in the analysed scope declares. Common false-positives: multi-repo deployments (queue declared in another stack); work-in-progress before infra is wired up.

**Fix:** add the contract source that declares the queue, or suppress.

### `messageBusConsumerOrphan` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A consumer Lambda is wired to receive from a channel but no code in the project sends to that channel. Could be dead infra, or the producer lives in a different repo.

### `messageBusUnused` *(shipped)*

**Severity:** warning • **Emitted by:** `checkMessageBus`

A queue / topic is declared in infrastructure but neither produced to nor consumed from anywhere in the project. Likely orphan resource left over from a removed feature.

---

## Runtime-config findings

### `runtimeScopeUnknown` *(shipped)*

**Severity:** info • **Emitted by:** `checkRuntimeConfig`

A runtime-config-bound provider summary declares no `codeScope` (or one we couldn't resolve to source files), so the env-var contract can't be paired against any code. Heads-up that verification was skipped, not a defect in the code itself. Common cause: raw CloudFormation that uses S3-built artifacts (no `CodeUri`) without a `Metadata.SussCodeScope` annotation.

**Fix:** add `Metadata: { SussCodeScope: { CodeUri: "src/handlers/x" } }` to the resource, or wire CodeUri through.

---

## Reserved kinds *(in IR enum, no emitter yet)*

The reserved kinds below mostly subsume into the generic `boundaryShapeMismatch` (with appropriate aspect) once their emitters land. They remain as separate enum values for finer-grained semantic distinctions a future implementation may want.

### REST

- `requiredHeaderMissing` — error. Consumer call doesn't include a header the provider declares required. Will likely fold into `boundaryFieldUnknown` aspect: `send` once request-shape pairing extends past status / body to headers.
- `requiredQueryParamMissing` — error. Same shape, query-param dimension.
- `requestBodyShapeMismatch` — error. Body shape disagreement on the request side. Will fold into `boundaryShapeMismatch` aspect: `send`.
- `restMethodOnUnknownPath` — error. Consumer call targets a `(method, path)` the provider doesn't expose.
- `contentTypeMismatch` — error. Provider returns a content-type the consumer doesn't expect.
- `authPolicyMismatch` — error. Provider requires authentication and the consumer's call doesn't supply it correctly.

### React / Storybook

- `componentRequiredPropMissing` — error. Component requires a prop the story / scenario omits. Will fold into `boundaryFieldRequired` if added, or stay distinct.
- `componentPropTypeMismatch` — error. Story passes a value of the wrong type for a prop. Will fold into `boundaryShapeMismatch` aspect: `construct`.

### GraphQL

- `graphqlVariableTypeMismatch` — error. Operation's variable type doesn't match the resolver's argument type. Will fold into `boundaryShapeMismatch`.
- `graphqlRequiredArgMissing` — error. Operation calls a field with positional args missing one or more required arguments.
- `graphqlEnumValueUnknown` — error. Operation passes an enum value the schema's enum doesn't include.

### Storage

- `storageSelectorIndexMismatch` — error. `findUnique`-style selector references a column set that isn't a unique index. Pairs the `interaction.selector` field on a storage-access interaction against the `indexes` declared on the provider's `storageContract`.
- `storageTypeMismatch` — error. Will fold into `boundaryShapeMismatch` aspect: `write`.
- `storageNullableViolation` — error. Will fold into `boundaryShapeMismatch` aspect: `write`.
- `storageLengthConstraintViolation` — error. String literal exceeds column's declared length.
- `storageEnumConstraintViolation` — error. Will fold into `boundaryShapeMismatch` aspect: `write`.

### Runtime config

- `envVarRequiredButUnmarked` — warning. Code treats `process.env.X` as definitely-required but the runtime contract doesn't mark it required.
- `envVarTypeCoercionMissing` — warning. Code reads an env var as a non-string type without coercion.

---

## Meta findings

### `lowConfidence` *(shipped)*

**Severity:** info • **Emitted by:** any check, as a meta-finding

The analyser couldn't fully decompose the summary — predicates stayed opaque, type resolution failed, or confidence dropped below `medium`.

### `unsupportedSemantics` *(reserved)*

**Severity:** info

A pack identifies a boundary it doesn't know how to summarise — a WebSocket subscription handler, an SSE stream producer, a gRPC streaming method, etc. Emitter ships when a pack first encounters such a boundary.

### `opaquePredicateBlocking` *(reserved)*

**Severity:** info

A pairing pass refused to emit substantive findings because too many predicates on the relevant transitions are opaque. Per-pair, in contrast to `lowConfidence` which is per-summary.

---

## What this catalog is *not*

- **Not every tool's finding.** Downstream tools built on top of `@suss/behavioral-ir` can emit their own kinds; those aren't listed here.
- **Not a spec.** The authoritative list is `FindingKindSchema` in [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts), with JSDoc that this page mirrors.
- **Not exhaustive for severity mapping.** Severities shown are the defaults the checker emits. `.sussignore` rules can downgrade or hide any finding — see [Suppressions](/suppressions).
- **Not a roadmap.** The *reserved* tag means the kind exists in the IR enum but no checker emits it yet; it doesn't promise an emitter will land soon.
