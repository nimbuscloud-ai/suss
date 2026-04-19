# Findings catalog

Every finding kind the checker emits. Use this page as the lookup
when a finding surfaces and you want to know what it means, when
it's legitimate vs a false positive, and how to address it.

Findings follow a consistent shape:

- **kind** — one of the values listed below
- **severity** — `error` / `warning` / `info`
- **boundary** — the `BoundaryBinding` that produced the finding
- **provider** / **consumer** — the two sides (sometimes symmetric for
  contract-disagreement findings; always both filled)
- **description** — one-line human text
- **sources** — present only when deduped across multiple providers

## REST findings

### `unhandledProviderCase`

**Severity:** warning • **Emitted by:** `checkProviderCoverage`

The provider produces a status code that no consumer branch
reads. The consumer will hit its fall-through path (throwing,
returning undefined, silently ignoring) when the provider
returns that status.

**Example:**
```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/handler.ts::getUser (src/handler.ts:15)
  consumer: src/client.ts::loadUser (src/client.ts:3)
  boundary: ts-rest (http) GET /users/:id
```

**When it's legitimate:** the consumer truly doesn't care (it
already has `try/catch`, or the throw path is correct). Add a
`.sussignore` with `effect: mark`.

**When it's a bug:** the consumer silently ignores the status.
Fix by adding a branch in the consumer (e.g. `if (res.status === 404) return null`).

### `deadConsumerBranch`

**Severity:** error • **Emitted by:** `checkConsumerSatisfaction`

The consumer has a branch that reads a status the provider never
produces. Code that will never run — usually dead-code drift from
a consumer copied from another endpoint.

**Example:**
```
[ERROR] deadConsumerBranch
  Consumer expects status 403 but provider never produces it
  provider: src/handler.ts::createUser (src/handler.ts:22)
  consumer: src/client.ts::createUser (src/client.ts:8)
  boundary: ts-rest (http) POST /users
```

**When it's legitimate:** rare. A defensive branch that exists
just in case. Even then, the branch is silent — suppression noted
in `.sussignore`.

**When it's a bug:** common. Delete the dead branch, or add the
missing status to the provider contract.

### `providerContractViolation`

**Severity:** error • **Emitted by:** `checkContractConsistency`

The provider produces a status code its declared contract
doesn't include. Contract drift — the handler added behavior the
contract doesn't promise.

**Example:**
```
[ERROR] providerContractViolation
  Handler produces status 410 which is not declared in the ts-rest contract
  provider: src/handler.ts::getUser (src/handler.ts:15)
  consumer: — (self-inconsistency, no consumer involved)
  boundary: ts-rest (http) GET /users/:id
```

Self-inconsistency — only one side is named.

**Fix:** add the status to the contract, or remove it from the handler.

### `consumerContractViolation`

**Severity:** warning • **Emitted by:** `checkConsumerContract`

The consumer declares expected statuses that don't match the
contract — either handles a status the contract doesn't promise,
or fails to handle one the contract declares.

**Fix:** align the consumer's handled cases with the contract.
Often fires alongside `deadConsumerBranch` (the two are related
failure modes of the same drift).

### `contractDisagreement`

**Severity:** warning • **Emitted by:** `checkContractAgreement`

Two or more providers at the same boundary (e.g. an OpenAPI stub
and a CFN template) declare contracts that disagree — different
status sets, different body shapes. `sources` lists all
contributors.

**Example:**
```
[WARNING] contractDisagreement
  OpenAPI declares {200, 404} but CFN template MethodResponses declares {200, 404, 500}
  provider: petstore.yaml::getPet (petstore.yaml:1)
  consumer: template.yaml::getPet (template.yaml:30)
  sources: [petstore.yaml::getPet, template.yaml::getPet]
  boundary: openapi (http) GET /pets/:id
```

**Fix:** reconcile the sources. Whichever is authoritative wins;
the other drifts to match.

### `lowConfidence`

**Severity:** info • **Emitted by:** any check, as a meta-finding

The analyzer couldn't fully decompose the summary — predicates
stayed opaque, type resolution failed, or the confidence dropped
below `medium`. Informational: helps reviewers know when to
read the actual source.

## GraphQL findings

### `graphqlFieldNotImplemented`

**Severity:** warning • **Emitted by:** `pairGraphqlOperations`

A consumer operation selects a root-level field (Query.*,
Mutation.*, Subscription.*) that no provider resolver
implements.

**Example:**
```
[WARNING] graphqlFieldNotImplemented
  GraphQL operation "useStale.Stale" selects root field "Query.deletedAt"
  but no provider summary implements it.
  provider: Query.deletedAt (unresolved)
  consumer: src/useStale.ts::useStale.Stale (src/useStale.ts:12)
  boundary: apollo-client (http) query Stale
```

**When it's legitimate:** the resolver lives in a service you
haven't extracted (microservice boundary); the pack didn't see
it. Extract that service's summaries, or stub the schema.

**When it's a bug:** the field was removed from the server. Fix
by removing the selection from the operation.

### `graphqlSelectionFieldUnknown`

**Severity:** warning • **Emitted by:** `pairGraphqlOperations` (nested-selection pass)

A consumer selects a nested field on an object type that the
provider's schema doesn't declare. The root field paired
successfully — the issue is deeper in the selection tree.

**Example:**
```
[WARNING] graphqlSelectionFieldUnknown
  GraphQL operation "usePet.GetPet" selects "Pet.deletedAt" but the
  provider's schema doesn't declare that field on "Pet". Likely a
  stale selection after a schema change — the server response will
  not include it.
  provider: Pet.deletedAt (undeclared)
  consumer: src/usePet.ts::usePet.GetPet (src/usePet.ts:5)
  boundary: apollo-client (http) query GetPet
```

**Fix:** remove the selection, or add the field to the schema.

## React / Storybook findings

### `scenarioArgUnknown`

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

A scenario (Storybook story, fixture) references a prop the
component doesn't declare. Usually means the story is stale
after a component rename or removal.

**Example:**
```
[WARNING] scenarioArgUnknown
  Story "Broken" provides arg "disabled" but component "Button"
  does not declare it as an input.
```

**Fix:** update the story, or restore the prop on the component.

### `scenarioCoverageGap`

**Severity:** warning • **Emitted by:** `checkComponentStoryAgreement`

A component has a conditional branch that depends on a prop, but
no story supplies that prop. The branch exists but has no
declared coverage — changes to it can regress silently.

**Example:**
```
[WARNING] scenarioCoverageGap
  Component "UserCard" has a conditional branch on prop "user" but
  no story supplies it. The branches depending on "user" have no
  declared scenario exercising them.
```

**Fix:** add a story that exercises the branch.

## What this catalog is *not*

- **Not every tool's finding.** Downstream tools built on top of
  `@suss/behavioral-ir` can emit their own kinds; those aren't listed
  here.
- **Not a spec.** The authoritative list of kinds is
  `FindingKindSchema` in
  [`packages/ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/ir/src/schemas.ts).
- **Not exhaustive for severity mapping.** Severities shown are
  the defaults the checker emits. `.sussignore` rules can
  downgrade any finding — see [Suppressions](/suppressions).
