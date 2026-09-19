---
title: Findings catalog
description: Every finding suss can report, what it means, and what to do about it.
---

# Findings catalog

A run produces up to three lists, and they have different shapes.

Most of this page is the behavioral findings, under `findings` in the JSON, which say that two sides of a boundary disagree. [Intent findings](#intent-findings) go under `intent` and say that code and a document your team wrote disagree. [Run findings](#run-findings) go under `run` and say the run could not get far enough to compare anything. A parser that reads only `findings` misses the other two.

`FindingKindSchema` in [`packages/behavioral-ir/src/schemas.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/src/schemas.ts) and `IntentFindingKindSchema` in [`packages/intent-ir/src/findings.ts`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/intent-ir/src/findings.ts) are the authoritative lists, and `npm run check:findings` fails when this page and those enums disagree.

## What a finding looks like

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | Which failure mode this is, one of the values below. |
| `severity` | `error` \| `warning` \| `info` | The default. A `.sussignore` rule can downgrade it. |
| `boundary` | `BoundaryBinding` | Which boundary this is about: a REST endpoint, a table, a channel, a runtime's config, and so on. |
| `provider` | `FindingSide` | The provider's summary, as `{ summary, transitionId?, location }`, where `summary` reads `${file}::${name}`. |
| `consumer` | `FindingSide` | The consumer's summary. Always set, even where the finding is about a provider against its own contract; there the two often resolve to the same summary. |
| `description` | string | One line of human-readable text. |
| `aspect` | `BoundaryAspect?` | Which side of the field this concerns: `read`, `write`, `send`, `receive`, `construct` or `selector`. Absent where the aspect is irrelevant or spans several. |
| `sources` | `string[]?` | Set only when the dedupe pass collapsed identical findings from several providers. |
| `suppressed` | `FindingSuppression?` | Set only when a `.sussignore` rule matched. See [Accept a finding](/guides/accept-a-finding). |

## How a kind gets its severity

One test decides every default severity: can you name an input and the wrong result it produces?

- **Error: the code will misread or lose data on an input the other side produces.** The claim is about behavior, both sides are in the run, and the corpus says the kind is usually right when it fires.
- **Warning: the two sides disagree and a person has to judge it.** The disagreement is there in the files, and whether it is a defect turns on intent the repository does not state.
- **Info: suss is reporting on itself.** Confidence, coverage, something it could not read. Never a claim that the code is wrong.

A kind with no such sentence to write is a warning by construction. A kind at error whose measured precision over the pinned corpus falls under half moves down until its model improves, which is how `unhandledProviderCase` became a warning.

## Generic boundary findings

These four kinds are not tied to one protocol. The first three come out of every per-domain checker, and the fourth so far only out of the storage one. Read `binding.semantics.name` to see which domain you are in (`storage`, `runtime-config`, `graphql-operation`, `message-bus`), and `aspect` to see which direction the failure runs in.

They replaced the per-domain enums earlier versions had, where `storageReadFieldUnknown`, `envVarUnprovided` and `graphqlSelectionFieldUnknown` were three names for one thing.

### `boundaryFieldUnknown`

**Severity:** error for a read or a write against a contract in the run, warning for a construct or send aspect, or where suss never extracted the provider.

The consumer references a field the provider's contract does not declare. A read of a missing field comes back with nothing, no error says so, and the code branches on what is not there. The construct and send aspects and the missing-provider case cannot state that outcome, so they stay warnings.

Runtime config:

```
[ERROR] boundaryFieldUnknown
  process.env.STRIPE_API_KEY read by Checkout.handler (lambda/Checkout scope) but Checkout declares no STRIPE_API_KEY in its environment. At runtime this resolves to undefined, changing which execution paths the function takes.
```

GraphQL:

```
[ERROR] boundaryFieldUnknown
  GraphQL operation "GetUser" selects "User.email" but the provider's schema doesn't declare that field on "User". Likely a stale selection after a schema change.
```

The server rejects the whole operation at validation, so every operation using that selection fails, not only the one field. A selection kept in a shared fragment breaks every operation that spreads it.

A message bus, where the consumer reads a field off the message body:

```
[WARNING] boundaryFieldUnknown
  OrderConsumer.handler reads "totalAmount" off a message on aws_sqs channel "OrdersQueue" but no producer in the analysed scope sends "totalAmount". Likely a producer/consumer drift: the producer renamed or removed the field, or the consumer expects a field that was never sent.
```

A queue takes a string, so nothing on either side type-checks the payload and the consumer throws on every message. A producer whose body suss cannot read takes the channel out of the comparison, so the absence of a finding here is not agreement.

**Legitimate when:** the provider is in a service or a contract source you have not extracted. Suppress with `.sussignore` and `effect: mark`.

**A bug when:** a typo, a rename nobody finished, or stale code reading a field that was removed. Fix the consumer, or restore the contract.

### `boundaryFieldUnused`

**Severity:** warning, and info where suss is saying it could not check rather than that something is unread.

The provider declares a field no consumer references. No input produces a wrong result here: an unread field breaks nothing at runtime, and whether it is dead or reserved is intent the repository does not state.

```
[WARNING] boundaryFieldUnused
  Checkout declares environment variable STRIPE_KEY but no code in its codeScope reads process.env.STRIPE_KEY.
```

The info form says the run could not check, rather than that the field is unread:

```
[INFO] boundaryFieldUnused
  cloudformation:template.yaml declares environment variables and these summaries record no environment read anywhere, so whether code reads them was not checked. If the code reads process.env, extract with the node pack in the framework list (-f node) so the reads are in the summaries.
```

For storage, suss stays quiet when any caller reads the table with a default shape (`["*"]`), because then it cannot tell whether those callers use the column. A query that asks for some columns is not default-shape, so a Prisma call with a `select` or an `include` still leaves the check running over the columns it did not ask for. An `aspect` of `read` means the field has writers and no reader.

**Legitimate when:** the field is reserved for something that has not landed, or read by code outside the extracted scope. Suppress.

**A bug when:** it is dead config from a removed feature, or a renamed field the contract still declares. Take it out of the contract, or restore the consumer.

### `boundaryShapeMismatch`

**Severity:** per emitter.

Both sides declare the value and disagree about its form: its type, its nullability, its content type. The `aspect` says which side found the disagreement.

One emitter ships today, the metric one. A monitoring alert compares a series against a single number, and the resource declaring that series says its measurements are a histogram of buckets, so the comparison has nothing to run against:

```
[ERROR] boundaryShapeMismatch
  google_monitoring_alert_policy.sweep_refused_sustained#0 compares logging.googleapis.com/user/sweep-refused against a single number, and google_logging_metric.sweep_refused declares that metric's measurements as a histogram of buckets, so the comparison has nothing to run against unless the reading reduces each window to a single number first, by setting aggregations.per_series_aligner to one of ALIGN_PERCENTILE_99, ALIGN_PERCENTILE_95, ALIGN_PERCENTILE_50, ALIGN_PERCENTILE_05.
```

Both sides have to say what the value is. A metric whose summary states no `metadata.metricContract.values`, and a reading that states no `metadata.metricReading.comparesTo`, claim nothing here.

This kind is where the message-bus body-shape pairing will report, along with the type-aware storage, runtime-config and GraphQL checks. It takes the place of the per-domain shape kinds earlier versions reserved: `storageTypeMismatch`, `graphqlVariableTypeMismatch`, `requestBodyShapeMismatch` and the rest.

**Legitimate when:** the consumer coerces the value before using it, so the difference never reaches anything that cares.

**A bug when:** it does not. The side that reads the value will act on something other than what arrives.

### `boundarySelectorMismatch`

**Severity:** error.

The consumer picks items by something the provider does not key on. A store that accepts only its key attributes refuses the request, so every run of this query fails rather than returning nothing.

```
[ERROR] boundarySelectorMismatch
  InvoiceListFunction.handler picks items on InvoicesTable by "customerId", which is not one of its key attributes (invoiceId). aws.dynamodb refuses a request keyed on anything else, so this fails when it runs.
```

A contract that states no `metadata.storageContract.identifies` claims nothing here, and neither does an access that states no selector. A query through a secondary index pairs against that index's own summary, so it is checked against the index's key rather than the table's.

**Legitimate when:** never. The store refuses the query outright.

**A bug when:** always. Query by an attribute the store keys on, or add an index for the one you want.

## REST findings

### `unhandledProviderCase`

**Severity:** warning.

The provider produces a status, or a body case within a status, that no consumer branch tells apart. The consumer hits its fall-through path, throwing, returning undefined, or ignoring the answer.

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:13)
  consumer: src/orderPanel.ts::loadOrder (src/orderPanel.ts:1)
  boundary: express (http) GET /orders/:id
```

No outcome sentence can be written: the fall-through may be the intended handling, and over the pinned corpus the uncovered-status form was wrong far more often than right. The error-worthy core of the old kind, a path that will actually misread a response, is `misreadProviderResponse` below.

A provider response declared as a range, such as an OpenAPI `4XX`, is one declared response that may arrive with any status in it. It counts as covered when the consumer covers any member, whether that is a branch on 404, a `!res.ok` guard, or a catch on a throwing client. When nothing covers any member it reports once, saying `Provider produces statuses in the 4XX range but no consumer branch handles any of them`.

**Legitimate when:** the consumer does not care, because it has a `try`/`catch` or because the throw path is right.

**A bug when:** the consumer ignores the status. Add a branch, such as `if (res.status === 404) return null`.

### `misreadProviderResponse`

**Severity:** error.

The path runs on a response the provider sends, reads a field that response's body does not include, and nothing on the path tells that response apart from one that does include it. Whatever the path does with the value runs on undefined.

```
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "customerName", but the 200 body the provider sends does not include it, and neither does any other response.
  provider: src/api.ts::get (src/api.ts:13)
  consumer: src/orderPanel.ts::loadOrder (src/orderPanel.ts:1)
  boundary: express (http) GET /orders/:id
```

This is `unhandledProviderCase` restated as a claim about behavior rather than about coverage, and it is the same question the storage and GraphQL read checks ask: does the code read something the other side does not supply. It stays narrow on purpose.

- A field any of the consumer's guards test is never reported. `if (res.error)` is how the consumer tells the failure body apart, so `error` coming back undefined on the 200 is an answer rather than a misread.
- A body with spreads or an opaque shape claims nothing, and a status the provider returns with several bodies fires only when every one of them lacks the field.
- The branch has to run on the response: a status guard, a range such as `!res.ok`, or the fall-through over the 2xx class. A branch guarded on a body field never runs on a response whose body cannot satisfy the guard.
- A response declared as a range is one response that may arrive with any status in it, so a branch on 404 is judged against the `4XX` body and the finding says which.

**Legitimate when:** the provider sends the field through a path suss could not read, a wrapper or a spread it flattened away. Suppress.

**A bug when:** a rename or a copy-paste left the consumer reading a field this endpoint never sends. Fix the read, or fix the provider.

### `deadConsumerBranch`

**Severity:** warning.

The consumer has a branch for a status the provider never produces. It usually comes from a consumer copy-pasted off another endpoint.

```
[WARNING] deadConsumerBranch
  Consumer expects status 410 but provider never produces it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadOrder (src/client.ts:1)
  boundary: express (http) GET /orders/:id
```

The branch never runs and nothing misreads because of it, so no outcome sentence can be written. Whether to delete the branch or fix the provider is a judgement.

A status inside a range the provider declares (404 against an OpenAPI `4XX`) is produced, and a provider with a `default` response produces any status, so neither makes a branch dead.

**Fix:** delete the branch, or add the missing status to the provider's contract.

### `providerContractViolation`

**Severity:** error, and warning for a declared status the handler never produces.

The provider produces a status or a body its declared contract does not include. A caller built to the contract meets something the contract never told it about and takes a path written for something else.

```
[ERROR] providerContractViolation
  Handler produces status 422 which the openapi document does not declare
  provider: src/api.ts::post (src/api.ts:14)
  consumer: openapi:openapi.yaml::POST /orders (openapi:openapi.yaml:0)
  boundary: express (http) POST /orders
```

The other direction is a warning, because a document routinely declares the 401 the middleware sends or the 404 the router sends:

```
[WARNING] providerContractViolation
  The openapi document declares response 410, and no path in the handler produces it
```

Where the contract is written in the handler's own code, as with ts-rest or hono-openapi, the provider and consumer fields point at one summary, and the checker skips the comparison when the contract source is derived from the implementation. Where the contract is a separate document read with `suss contract`, the document is the consumer side. A declared 5XX is not reported at all.

Every `unhandledCase` gap on the provider surfaces here. An `unreadOutcome` gap does not: it comes out as `lowConfidence` at info, because it means the pack has no form for what the handler returns rather than that the handler is wrong.

**Fix:** add the status to the contract, or take it out of the handler. For a declared status the handler never produces, suppress it when something in front of the handler sends it.

### `consumerContractViolation`

**Severity:** warning, and info for a read of a field the contract declares optional.

The consumer's expected statuses or body reads disagree with the contract. It handles a status the contract does not declare, fails to handle one the contract requires, or reads a body field the contract does not promise.

```
[WARNING] consumerContractViolation
  Contract declares response 404 but consumer does not handle it
  provider: openapi:openapi.yaml::GET /orders/{id} (openapi:openapi.yaml:0)
  consumer: src/client.ts::loadOrder (src/client.ts:1)
  boundary: openapi (http) GET /orders/{id}
```

No outcome can be stated against a contract alone: a branch for an undeclared status never runs, and a missing branch may be the intended fall-through. A contract's range and `default` entries widen what is declared, so a branch on 404 agrees with a declared `4XX`, and nothing is undeclared against a contract with a `default`. A declared range the consumer handles no member of reports once.

**Legitimate when:** the consumer does not care, because a wrapper throws on the status and something above catches, or because the declared response never arrives on this caller's path.

**A bug when:** the consumer falls through to a path written for a different answer. Handle the status, or take it out of the contract if nothing serves it.

### `contractDisagreement`

**Severity:** warning.

Two or more contract sources describe the same boundary and declare different things. `sources` lists every contributor.

```
[WARNING] contractDisagreement
  Sources disagree on status 500 at GET /pets/{id}: declared by [GetPet], not declared by [GET /pets/{id}]
    also from: openapi:public.yaml::GET /pets/{id}
  boundary: apigateway (http) GET /pets/{id}
```

At most one of them is right, and which one is a judgement the repository does not settle.

**Legitimate when:** the sources describe different deployments of the same route, so one really does serve a status the other cannot.

**A bug when:** they describe one deployment. One of them is stale and the run cannot say which, so somebody who knows which document is maintained has to decide.

### `contractOperationUnimplemented`

**Severity:** warning.

A contract source declares an operation and no extracted provider implements it.

```
[WARNING] contractOperationUnimplemented
  The openapi contract declares POST /orders/{id}/refunds and no extracted provider implements it.
  boundary: openapi (http) POST /orders/{id}/refunds
```

The handler may be in a repository suss did not read, so no outcome can be stated.

**Legitimate when:** the handler is in another repository or another service. Suppress.

**A bug when:** the operation was removed from the code and the contract still declares it. Take it out of the contract.

## GraphQL findings

Most GraphQL failures come through the generic kinds: `boundaryFieldUnknown` for a selection the schema does not declare, `ambiguousProvider` for one field two services implement. This kind is about how GraphQL clients ship documents.

### `graphqlUnknownFragment`

**Severity:** error.

The operation ships a document spreading a fragment nothing defines, and no fragment registry is configured, so the query throws when it runs.

```
[ERROR] graphqlUnknownFragment
  GraphQL operation "<anon>.CheckOrderInvoicesStatus" ships a document spreading "...Invoice" with no definition, and no fragment registry is configured, so the query throws `Unknown fragment: Invoice` when it runs.
  consumer: fixtures/apollo-client/dangling-fragment/provider.tsx::<anon>.CheckOrderInvoicesStatus
  boundary: apollo-client (http)
```

Three readings line up before it fires. The document that reaches the call site is the one with the dangling spread, so a codegen-composed version that defines the fragment never fires it. Every client construction in the project was read and none installs a fragment registry, the one runtime mechanism that could supply the definition; a client whose construction the pack cannot see counts as unknown, and unknown gives the info-level `lowConfidence` finding instead. And the spread has no definition anywhere in the shipped document.

**Legitimate when:** the call site never runs, as with dead code behind a disabled flag. Suppress, or delete the code.

**A bug when:** the import points at the raw source document instead of the codegen output, which is the shape that produced this kind. Import the composed document, or register the fragment on the cache.

## React and Storybook findings

### `scenarioCoverageGap`

**Severity:** warning.

A component has a conditional branch that turns on a prop, and no story supplies that prop.

```
[WARNING] scenarioCoverageGap
  Component "Badge" has a conditional branch on prop "urgent" but no story supplies it (stories: Plain). The branches depending on "urgent" have no declared scenario exercising them.
  provider: src/Badge.tsx::Badge (src/Badge.tsx:1)
  boundary: react (in-process)
```

Nothing misbehaves at runtime. The branch is undeclared in the stories, and whether it deserves one is a judgement.

**Fix:** add a story that exercises the branch.

## Message-bus findings

### `messageBusProducerOrphan`

**Severity:** warning.

Code sends to a queue or a topic that no provider in the analyzed scope declares.

```
[WARNING] messageBusProducerOrphan
  handler sends to aws_sqs channel "https://sqs.us-east-1.amazonaws.com/123456789012/AuditQueue" but nothing in the analysed scope declares this channel, and no handler answers it. Likely cases: (a) the queue is declared in another stack we don't analyse (multi-repo); (b) work-in-progress before infra is wired up; (c) a real misconfiguration. Severity is warning rather than error because (a) and (b) are common false-positive sources.
```

The queue may be declared in a stack suss did not read, so the provider side is not in the run and no outcome can be stated.

**Fix:** add the contract source that declares the queue, or suppress.

### `messageBusConsumerOrphan`

**Severity:** warning.

A consumer is wired to receive from a channel that no code in the project sends to.

```
[WARNING] messageBusConsumerOrphan
  ChargeWorkerFunction.FromCharges is wired to receive messages from aws_sqs channel "ChargesQueue" but no code in the project sends to this channel. Either dead infra or the producer lives outside this repo.
  boundary: cloudformation (aws_sqs)
```

**Legitimate when:** the producer is in another repository, which one run cannot see.

**A bug when:** the producer was meant to be here. Nothing sends on the channel, so the consumer never runs and nothing says so at deploy time.

### `messageBusUnused`

**Severity:** warning.

A queue or a topic is declared in infrastructure and neither produced to nor consumed from anywhere in the project.

```
[WARNING] messageBusUnused
  aws_sqs channel "LeftoverQueue" is declared in infrastructure but has no identified producer or consumer. Likely orphan resource left over from a removed feature.
  boundary: cloudformation (aws_sqs)
```

Nothing breaks at runtime, so removing it is a judgement.

**Legitimate when:** something outside the project uses it, or it is kept on purpose for a consumer that has not landed.

**A bug when:** the feature it belonged to is gone. This is cleanup rather than a defect.

### `messageBusConsumerDisabled`

**Severity:** info.

A rule or a subscription deploys switched off, so its target receives nothing until somebody enables it.

```
[INFO] messageBusConsumerDisabled
  ChargeWorkerFunction.NightlyRule is wired to eventbridge channel "schedule:NightlyRule" through "NightlyRule", which is deployed disabled. It receives nothing until someone switches it on, so it is not counted as a consumer of the channel.
  boundary: cloudformation (eventbridge)
```

The subscription counts as a consumer nowhere in this pass. A producer whose only subscriber is disabled comes out as `messageBusProducerOrphan`, the disabled rule is never reported as a waiting `messageBusConsumerOrphan`, and its channel is not reported as `messageBusUnused`, because switched off on purpose is not left over.

**Legitimate when:** it is switched off on purpose, which is why this is info.

**A bug when:** somebody meant to enable it and did not. No other finding will say so.

### `repeatUnsafeConsumer`

**Severity:** warning.

An SQS queue that is not FIFO can deliver one message more than once, and the handler draining it makes a `POST` to another service while handling it. A second delivery makes that call again, which is a second charge or a second order.

```
[WARNING] repeatUnsafeConsumer
  SQS queue "ChargesQueue" can deliver one message more than once, and handler makes POST /v1/charges while handling it. A second delivery makes that call again. If the far side takes an idempotency key and this call sends one, it is safe and worth suppressing: a summary does not record the headers a call sends, so this cannot tell.
  consumer: src/handlers/chargeWorker.ts::handler (src/handlers/chargeWorker.ts:3)
  boundary: cloudformation (aws_sqs)
```

A call that sends an idempotency key is safe and still reported, because a summary does not record the headers a call sends. Suppress those. A FIFO queue is left alone, and so are `GET`, `PUT`, `PATCH` and `DELETE`, which land on the same resource twice. A storage write is left alone as well: whether a repeat overwrites the same row or appends a new one turns on where the key's value came from, and a summary does not say that today.

Both gaps come down to a summary being able to state that a call is idempotent, and on what. Issue #516 has the shape.

## Unit-invocation findings

### `unitInvocationTargetUnknown`

**Severity:** warning.

Code invokes a deployed unit by name and no deployment source in the run declares a unit by that name. The name is read off the call: a literal, the resource segment of an ARN, or whatever the invoking unit's environment points the variable at.

```
[WARNING] unitInvocationTargetUnknown
  OrderApi.handler invokes the lambda "legacy-pricing", and nothing in the analysed scope deploys a unit by that name. Likely cases: (a) it is deployed by another stack we don't analyse; (b) work-in-progress before the infrastructure is wired up; (c) a name that no longer exists. Severity is warning rather than error because (a) and (b) are common.
```

**Legitimate when:** the callee is deployed by another stack, or the infrastructure has not landed yet.

**A bug when:** the name is stale. The call fails at runtime with `ResourceNotFoundException` and nothing at deploy time says so.

## Runtime-config findings

### `runtimeScopeUnknown`

**Severity:** info.

suss could not tell which code a runtime runs, so it paired that runtime's environment contract against nothing. This says verification was skipped rather than that the code is wrong.

```
[INFO] runtimeScopeUnknown
  ReportBuilder (lambda) has no codeScope; cannot verify whether code in this runtime reads its declared environment variables. Add Metadata.SussCodeScope to the resource (or use SAM CodeUri) to enable env-var pairing.
  boundary: cloudformation (os)
```

There are two ways to get here. The provider declares no `codeScope`, or one that resolved to no source files, which is what raw CloudFormation with an S3-built artifact looks like. **Fix:** add `Metadata: { SussCodeScope: { CodeUri: "src/handlers/x" } }` to the resource, or wire `CodeUri` through.

Or several providers declare a directory containing the same source file, and nothing in that file says which deployed unit it belongs to. A service that builds every function from the service root gives them all one directory, and attributing a shared helper to all of them would report one `process.env` read once per function. **Fix:** let a pack discover the code under a template entry so it comes with a deployed unit, or give each function a `CodeUri` covering only its own sources.

## Meta findings

### `lowConfidence`

**Severity:** info.

suss could not finish reading one side, so it says so rather than guessing. Predicates stayed opaque, type resolution failed, or confidence dropped below `medium`.

```
[INFO] lowConfidence
  GraphQL operation "<anon>.CheckOrderInvoicesStatus" spreads "...Invoice" but no fragment definition with that name was found, so the fields selected through it were not checked.
  boundary: apollo-client (http)
```

It also reports every `unreadOutcome` gap on the provider, which means a `return` in the handler matched none of the terminal shapes the pack looks for.

**Fix:** teach the pack that terminal shape. Until then the handler is under-described rather than wrong, which is why this is info.

### `unsupportedSemantics`

**Severity:** info.

A pack identified a boundary it cannot work out the other side of, and the finding says which reading gave up.

```
[INFO] unsupportedSemantics
  SNS subscription "FromEvents" on topic "EventsTopic" routes to AuditFunction.FromEvents, but subscription declares a FilterPolicy; v0 pairs on the whole topic only, filter-policy reduction is out of scope. It's surfaced as unpaired-unresolvable rather than dropped.
  boundary: cloudformation (aws.sns)
```

It also covers a boundary no pack knows how to summarise, such as a WebSocket subscription handler or a gRPC streaming method.

**Legitimate when:** the channel is settled outside the code, by a deploy-time value or a change somebody made in a console, so the source could not have said it.

**A bug when:** the source does say it and the pack could not follow it. That is a gap in suss rather than in your project, and the reason on the finding says where.

### `ambiguousProvider`

**Severity:** warning.

One consumer matched two providers where at most one of them can be right.

```
[WARNING] ambiguousProvider
  GraphQL operation "GetUser" selects "Query.user", which 2 resolvers implement across 2 services (accounts-service, directory-service). The pairing key has no endpoint identity, so this operation pairs with all of them and some of those pairs are wrong.
  boundary: graphql-documents (http-graphql)
```

Storage says it for a container. A table declared as `{StageName}-orders-blue` and one declared as `prod-orders-{Colour}` both cover `prod-orders-blue`, and each states as much of its own name as the other, so nothing in the run says which one the code reaches. The access pairs with neither and the finding says which two were in the way. Where one states more of its name, that one takes the access and no finding is emitted.

**Legitimate when:** the two providers are the same route in two documents, so whichever the consumer reaches behaves the same.

**A bug when:** they are different services that happen to share a method and a path. The consumer is being checked against an API it never calls, so every finding on that pair is suspect until the collision is settled.

## Reserved kinds

These six are in the enum and no checker emits them today. They cover failure modes distinct enough not to fold into the generic family.

- `restMethodOnUnknownPath`: error. The consumer's call targets a `(method, path)` the provider does not expose, so every call to the missing endpoint returns a 404 the caller wrote no branch for. It is at boundary-identity level rather than field level, which is why it is separate from `boundaryFieldUnknown`. Today's pairing layer leaves both summaries unmatched, which quietly hides what is probably a typo. The emitter ships once pairing has a "consumer with no provider" finding distinct from "unmatched".
- `authPolicyMismatch`: error. The provider requires authentication and the consumer's call does not supply it, so the request is rejected whenever it runs. It needs auth-policy modeling on both sides, OpenAPI security schemes against the client's own header or interceptor patterns.
- `boundaryFieldRequired`: error. The provider declares a field as required and the consumer does not supply it, so the provider rejects the request every time: a 4xx, or a component that fails to render. The `aspect` would point at the payload. It takes the place of `requiredHeaderMissing`, `componentRequiredPropMissing` and `graphqlRequiredArgMissing`.
- `boundaryConstraintViolation`: error. The value has the type the provider declared and breaks a value-level rule it declared, such as enum membership or a length. It takes the place of `storageEnumConstraintViolation` and `graphqlEnumValueUnknown`.
- `envVarRequiredButUnmarked`: warning. The code treats `process.env.X` as required (`if (!process.env.X) throw …`) and the runtime contract does not mark it required. Nothing misreads while the variable is set, so tightening the contract is a judgement. The emitter waits for the runtime contract to grow a required attribute on env-var entries.
- `opaquePredicateBlocking`: info. A pairing pass refused to emit substantive findings because too many predicates on the relevant transitions are opaque. It is per pair, where `lowConfidence` is per summary.

## Intent findings

These come from a second checker and travel in a second list. `suss check --intent DIR` pairs the intent docs your team writes against the same code summaries and puts what it found under `intent` in the JSON rather than under `findings`.

They have a different shape, because one side is a document rather than code, so there is no `provider` and no `consumer`:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | One of the ten below. |
| `severity` | `error` \| `warning` \| `info` | The default. |
| `boundary` | string | A readable label, such as `GET /users/:id` or `fn:@suss/cli::contract`. The key the intent and the code paired on. |
| `intent` | `{ name, outcomeId? }` | The document's `name` for a boundary intent or `title` for a PRD, plus the declared outcome where the finding is about one. |
| `code` | string? | The matched summary as `${file}::${name}`. Absent on `unimplementedBoundary`, where no code matched. |
| `scenario` | `{ title?, link }`? | Set only on the three scenario kinds. |
| `message` | string | One line of human-readable text. |
| `suppressed` | `IntentFindingSuppression?` | Set only when a `.sussignore` rule matched. |

One rule cuts across all ten: **a finding against intent suss inferred rather than a person wrote is downgraded one level.** An intent doc has a `source` field, and `inferred` means suss guessed the declaration from the code. Curating the document restores the full severity, so an `error` you see at `warning` may mean nobody has confirmed the intent yet rather than that the problem is smaller.

The severity split follows from what an intent doc is. A person sat down and wrote it, so code that does not satisfy it is a defect and reads as an error. An intent that cannot be checked, or a scenario pointing at nothing, is a gap in the documents and reads as a warning. Code that does more than the document claims reads as info.

### `unimplementedBoundary`

**Severity:** error.

Somebody declared a boundary in an intent doc and no code in the run produces it.

```
[error] DELETE /users/{id}: Intent "delete-users-id" declares boundary DELETE /users/{id} with 1 outcome(s); no code produces this boundary.
```

**Legitimate when:** the intent was written ahead of the code on purpose, or the implementation is in a repository this run did not read.

**A bug when:** the code is supposed to be here. Either the boundary was never built, or it is built under a key that does not match the one the intent declares, and a spelling that differs by one path parameter is the usual cause. Run `suss inspect --dir` and compare the key the code claims against the one the intent declares.

### `uncoveredOutcome`

**Severity:** error.

The code implements the boundary and none of its transitions produce one of the outcomes the intent declares.

```
[error] GET /users/{id}: Intent "get-users-id" declares status 410 at GET /users/{id}; get has no transition that produces it.
```

An outcome can also declare the effects it results in, and the same finding covers those: a queue consumer whose intent says an outcome results in a write to `aws.dynamodb:Invoices`, where no transition of it writes that table.

**Legitimate when:** the outcome is produced somewhere suss cannot follow, in a shared error handler or a framework layer the pack does not read. Check the summary's gaps before treating it as missing. For a declared effect, an access whose container the code is handed as an argument is one the storage pass grounds and this pass does not, so it matches nothing here.

**A bug when:** the branch is absent. The declared behavior is not implemented, which is the case this checker exists for.

### `outcomeShapeMismatch`

**Severity:** error.

A branch produces the declared outcome and the body it returns disagrees with the body the intent declares.

```
[error] GET /users/{id}: Body shape for status 200 at GET /users/{id} disagrees with intent "get-users-id": get produces an incompatible shape.
```

Several branches can produce one status with different bodies, so the check is satisfied when any matching branch produces a conforming shape. This fires only when none of them does.

**Legitimate when:** the intent doc describes the body loosely and the code is right. Fix the document.

**A bug when:** a caller reading the field the intent promised gets something else. This is the same failure as `boundaryShapeMismatch`, with a written declaration on one side instead of a second piece of code.

### `undeclaredOutcome`

**Severity:** info.

The code returns a REST status the intent never mentions, or it reaches a boundary no outcome mentions.

```
[info] GET /users/{id}: get produces status 404 at GET /users/{id}; intent "get-users-id" does not declare it.
```

One finding per status, so two catch arms both returning 500 produce one, and one per verb and boundary, so a unit writing the same table twice produces one. Statuses are limited to REST on purpose, because function-call returns are too numerous for every undeclared one to mean something.

**Legitimate when:** the status is a framework default or an infrastructure response nobody intended to write down. A 500 from an unhandled throw is not a promise anybody made. For a boundary, the intent may be scoped to one part of what the unit does.

**A bug when:** the status is part of the contract callers depend on and the document does not say so, or the unit writes a store the document never mentions. Add it, since a person reading the document will not know about it.

### `renamedBoundary`

**Severity:** error.

A declared store the unit never touches, paired with an undeclared store of the same system that the unit touches instead, with the same verbs and outcomes.

```
[error] bus:aws_sqs InvoicesQueue: Intent "bus-aws-sqs-invoices-queue" declares aws.dynamodb:PaidInvoices; InvoiceWorkerFunction.handler writes aws.dynamodb:Invoices instead, with the same outcomes. If the store was renamed, update the intent.
```

Renaming a store without updating the intent doc would otherwise produce an `uncoveredOutcome` for every verb and outcome declared against the old store, plus an `undeclaredOutcome` for every verb the code touches the new one with. This replaces that whole set with one finding. Pairing requires the two boundaries to share a system prefix, their verbs to match exactly, the new one to satisfy every declared use the old one had, and each side to have exactly one candidate on the other.

**Legitimate when:** never. The document and the code disagree either way, and the pairing is a guess about the cause rather than a change in whether that disagreement matters.

**A bug when:** always. Update the intent if the store was renamed, and fix the code if it was not.

### `unreadInputField`

**Severity:** warning when the field is `required`, info otherwise.

The intent's `receives` block declares a field, and no transition of the unit reads that path or anything under it.

```
[warning] fn:@suss/checker::checkPair: Intent "checker-check-pair" says fn:@suss/checker::checkPair receives consumer and needs it; checkPair never reads it.
```

A read that goes deeper satisfies the declaration, and so does a read of the object the field belongs to: declaring `pair.provider` is satisfied by a unit that reads `pair` whole. The comparison is skipped altogether when the read set could be shorter than what the unit really reads, which is a rest parameter, a payload used whole, or a summary that recorded nothing.

On a REST route, what every wrapper registered around the route reads counts as what the route reads, so a header checked in middleware satisfies the declaration. A handler that passes the body to a validator has used it whole, and no declared body field is reported against it. Storage and unit-invocation boundaries accept a block and compare nothing against it yet.

**Legitimate when:** the field was written ahead of the code that will read it.

**A bug when:** the field was renamed on one side. The declaration says the caller must supply it and nothing uses it, so either the code stopped reading it or the document has the old name.

### `undeclaredInputRead`

**Severity:** info.

The unit reads a path off what it was handed that the `receives` block does not list.

```
[info] fn:@suss/checker::checkPair: checkPair reads options.stream off what it was handed at fn:@suss/checker::checkPair; intent "checker-check-pair" does not declare it under receives.
```

Reported only when the doc has a `receives` block: a doc without one says nothing about the input, the same way a doc without `results` says nothing about effects. One finding per path, so a field read in three branches is one.

On a REST route, a read under `body` is never reported when the block declares a body, since the shape is where the body gets described. Header names compare case-insensitively.

Info rather than warning because a block lists the fields the author wanted checked and is never a full description of the input. A handler often reads a header for logging or tracing that no author would write down.

**Legitimate when:** the field is one the document deliberately leaves out. Treat the list as what the code asks for beyond what anybody wrote down.

**A bug when:** the code reads a field callers were never told to send. Add it to the block, or stop reading it.

### `unkeyableBoundary`

**Severity:** warning.

The intent doc is well-formed and its boundary cannot be keyed for pairing, so nothing was checked against it.

```
[warning] function-call:intent: Intent "user-cache" has a function-call boundary that can't be keyed for pairing (a function-call boundary needs package + exportPath); it was not checked against code.
```

A function-call boundary needs a package and an export path, a message-bus boundary needs a channel, and without those there is nothing to match the code against. The message says what the boundary's own protocol would need.

A store is the one case where filling the fields in does not help. Storage has no identity key by design, because a container name can be a pattern only a caller or the deployment settles, and the storage pass grounds it before pairing. Say what the store is for by putting `- writes: aws.dynamodb:Invoices` on an outcome of the boundary that touches it, and the checker compares that.

**Legitimate when:** the boundary is a store, or the intent was written ahead of the keying suss can do. The author declared coverage they are not getting either way, so the finding is worth reading.

**A bug when:** the missing part is a field the author could write. Add it and the boundary starts being checked.

### `unlinkedScenario`

**Severity:** info.

A scenario in a PRD is not linked to any system-intent outcome. It reads fine on its own, and nothing checks whether the behavior it describes exists.

```
[info] prd:Reading a user: Scenario #3 in PRD "Reading a user" has no structured link to a system-intent outcome; it reads on its own, but its coverage can't be checked until a link is added.
```

**Legitimate when:** the PRD is still being written, or the scenario describes something outside any one boundary. This is a valid pending state rather than a defect.

**A bug when:** never on its own. Treat the count as a coverage number: how much of what the PRD describes is connected to something suss can check.

### `danglingScenarioLink`

**Severity:** warning.

A scenario links to an intent or an outcome nothing declares. Either no boundary intent goes by that name, or the intent exists and declares no outcome with that id. The message lists the outcomes it does declare.

```
[warning] GET /users/{id}: Scenario #4 in PRD "Reading a user" links to "get-users-id.301-moved", but boundary intent "get-users-id" declares no outcome "301-moved" (known outcomes: 410-gone, 200-ok).
```

**Legitimate when:** the boundary intent is in a directory this run did not read. Point `--intent` at both.

**A bug when:** the name is wrong, or the intent was renamed and the link was not. The scenario claims coverage of something that does not exist.

### `ambiguousScenarioLink`

**Severity:** warning.

A scenario links to a name two or more boundary intents share, so the link resolves to more than one and suss will not pick.

```
[warning] prd:Reading a user: Scenario #1 in PRD "Reading a user" links to "get-users-id.410-gone", but 2 boundary intents are named "get-users-id"; rename them so the link resolves to one.
```

**Legitimate when:** never. Two intent docs sharing a name is a problem whatever the link does.

**A bug when:** it fires. Rename the intents so the link resolves to one.

### `undescribedOutcome`

**Severity:** info.

A boundary intent declares an outcome and no PRD scenario links to it.

```
[info] DELETE /users/{id}: Intent "delete-users-id" declares 204-deleted and no PRD scenario says why it is there.
```

The other three scenario kinds ask whether a scenario points at something that exists. This asks it the other way, which is the question a product reader has: which of these behaviors has nobody written down a reason for. It stays quiet until at least one PRD is loaded, because before that the answer is every outcome, which tells nobody anything. `suss infer prd` writes a scenario per outcome, so a fresh set of drafts starts with none of these.

**Legitimate when:** the outcome is one nobody needs a reason for, such as a 500 from an unhandled throw. Treat the count as a coverage number rather than a list to empty.

**A bug when:** never on its own. It becomes one when the outcome turns out to be behavior nobody meant to ship, which is what reading the list is for.

## Run findings

A third list, under `run` in the JSON. These are about the run rather than about a boundary, so they have no two sides and no boundary key:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | Which problem this is. |
| `severity` | `error` \| `warning` \| `info` | |
| `description` | string | What happened. |
| `remedy` | string | What to do about it. A run-level problem has no boundary to point at, so it says the next step instead. |

### `nothingPaired`

**Severity:** error. Emitted by `suss check --dir` unless `--allow-empty` was passed.

The run read summaries and paired none of them. No boundary had both a provider and a consumer, so nothing was compared, and without this the report would say what it says when both sides agree.

```
error: nothingPaired
  Read 6 summaries and paired nothing. No boundary in this run had both a provider and a consumer, so nothing was compared.
  Check that both sides of at least one boundary are in the directory. A provider extracted from code needs its consumer extracted too, or its contract read with `suss contract`. `suss inspect --dir` over the same files lists the boundaries each side claims, and two spellings of one boundary is the usual cause.
```

It fires only when there was something to compare. A run over no summaries at all says so on its own, and a run with `--intent` that checked at least one intent doc did compare something.

**Legitimate when:** you meant to extract one side. Checking a service against a contract you have not read yet pairs nothing, correctly.

**A bug when:** both sides are in the directory and still nothing paired. The two sides are spelling the boundary differently, and `suss inspect --dir` over the same files shows both spellings side by side.

### `mostlyUnpaired`

**Severity:** error. Emitted under `--fail-on-unpaired`.

More boundaries had nothing to pair with than the floor allows. A run that pairs three boundaries out of hundreds otherwise exits the same as one that paired everything, and a CI gate on it goes green.

```
error: mostlyUnpaired
  4 of 5 boundaries had nothing to pair with, over the --fail-on-unpaired floor of 1. 1 paired.
  The unmatched lists in this report say which side each boundary is missing. Extract the missing side, read its contract with `suss contract`, or raise the floor if this share is expected.
```

The floor takes a count (`25`) or a share (`50%`).

**Legitimate when:** the corpus is one-sided on purpose and the floor was set for a different mix. Raise the floor, or drop the flag for that run.

**A bug when:** both sides were extracted and the share is still high. The usual causes are unpathed providers, whose routes have a gap message saying why, and two spellings of one boundary.

### `unreadableInput`

**Severity:** error. Emitted under `--fail-on-unreadable`.

A file in the summaries directory could not be read as summaries.

```
error: unreadableInput
  1 file in the directory could not be read as summaries: report.json: suss could not read [...] as summaries. It should be the output of `suss extract` or `suss contract`. What did not fit:
      - <root>: Invalid input: expected array, received object
  Fix or remove the files, or write summaries somewhere reports are not written back to. A truncated extract output and a report saved into the summaries directory are the usual causes.
```

Without the flag the file is skipped with a warning on stderr and the run exits by findings alone, so a truncated extract output reads as a pass. The `--json` body lists the skipped files whether or not the flag is on.

**Legitimate when:** the directory deliberately mixes summaries with other JSON a different tool reads. Move the other files, or leave the flag off.

**A bug when:** the skipped file was written by extract. A truncated output means the extract was interrupted, and a report written back into the summaries directory means an `-o` path pointed at the wrong place.
