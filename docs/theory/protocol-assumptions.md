---
title: Protocol assumptions
description: What the checker takes for granted about HTTP, GraphQL, storage and the message bus, and where each assumption stops being true.
---

# What the checker assumes about each protocol

Every comparison the checker makes rests on a claim about how the
protocol behaves. "The provider returns 404 and the consumer has no
branch for it" is a statement about HTTP as much as about the two
files: it treats the status the handler wrote as the status the caller
receives. Where a claim like that stops being true, the finding stops
meaning what its description says, and nothing in the output shows the
difference.

Two examples of what that looks like. An OpenAPI reader that takes
whichever media type a document lists first will compare a JSON caller
against an XML schema and report the two as agreeing. Storage that
treats a table name plus the scope `default` as enough to identify a
table will check two services' `users` queries against each other's
schema, at error severity.

Each entry below gives the claim, where in the checker it matters, and
what a finding means once the claim stops being true.

## Identity: when two sides describe one boundary

### A method and a normalized path identify one endpoint in the whole run

`pairSummaries` buckets REST summaries on `rest <path>` and decides the
method inside the bucket. `checkContractAgreement` groups declared
contracts on `METHOD /normalized/path`. Neither key contains a host, a
base URL, or the service the summary came from.

When two services in one repository serve the same route, a provider in
one gets paired with a consumer in the other, and every per-pair check
runs on that pair. `misreadProviderResponse` is an error, so a wrong
answer here fails a build. GraphQL and storage both filter by workspace
to avoid this. REST does not, and
[#514](https://github.com/nimbuscloud-ai/suss/issues/514) tracks it.

### Both sides state the path as a route template

`pathShape` reduces every parameter to its position, so `/users/{id}`
and `/users/:userId` both key as `/users/{}`. A parameter matches a
parameter in the same place and never matches a literal segment, so
`/users/me` stays apart from `/users/{id}`.

That leaves the claim on the consumer's side. A client summary that
recorded the URL it built, `/users/123`, keys as itself and pairs with
no route, and nothing gets reported: the summary lands in the unmatched
list, which a reader has to notice on their own. Whether a client pack
should record the template it interpolated rather than the string it
produced is a question for the pack rather than for the key.

### A wildcard route serves whichever method the caller sends

`methodsAgree` pairs `"*"` with any stated method, and pairs a null
method with nothing, because a source that never stated a method made
no claim to agree with.

### A subject identifies one channel, and a side with no bus stated meets that subject on any bus

`busesAgree` returns true when either side is null, so a send that knows
its queue but not its bus pairs with that subject wherever it is
declared. Two accounts, or a staging bus and a production bus in one
template, pair with each other on the subject alone.

The subject itself compares byte for byte, because AWS compares
detail-types and queue ids that way, so a producer that writes
`ordersqueue` orphans against a queue declared as `OrdersQueue`.

### A `#` in a channel string separates a bus from a subject

`parseChannel` splits on the first `#` whatever the bus is, although
only EventBridge writes two things into one channel string. SQS and
Kafka restrict their names to characters that exclude `#`, so the split
does no harm there. BullMQ takes an arbitrary string, and a queue called
`orders#priority` pairs with one called `priority`.

### A store is identified by its system, its scope, its container and its access path, inside one service

`nameCovering` compares the system, the scope and the access path for
equality, matches the container through `namesAgree` so a name built at
deploy time can cover what the code reached, and then asks
`sameService`, which reads `location.workspace`. A summary that states no workspace is
treated as a single-project run and pairs with anything, which is what
keeps a shared utility file working. Two databases behind one scope, a
staging instance and a production instance, are one store here; that
half is [#412](https://github.com/nimbuscloud-ai/suss/issues/412).

### A metric's system and its type string identify one series

`MetricSemantics` has three fields, and none of them is a tag, a
dimension, a unit, or a region. An alert filtering on `service="a"`
pairs with a declaration for `service="b"`. The pass indexes providers
into a `Map` keyed on the identity, so a second declaration of one
series replaces the first and the reading gets compared against
whichever came last.

### A GraphQL schema's root types are called Query, Mutation and Subscription

`rootTypeNameFor` maps an operation type to one of those three strings
and looks it up in the SDL index. A schema that renames a root type with
`schema { query: RootQuery }` has no `Query` for the walk to find, so
the walk returns and nothing under the operation gets checked.

## HTTP: what a status and a body mean

### The status a handler returns is the status the caller sees

Every finding about a status says this. A middleware that maps an error,
or an API gateway response mapping, can change the number between the
two sides, and neither of them is in the pair.

When it fails, a finding reports a status no caller receives, or stays
quiet about one every caller receives. Summaries cannot decide this,
because the pairing never puts the rewriting unit between the two sides.
Answering it needs the chain of hops `flow/` already builds for routing,
with each hop's own effect on the status attached, and nothing reads
that chain for statuses today.

### The value a handler returns is the response body

`checkBodyCompatibility` and `checkResponseMisread` compare the
consumer's reads against `transition.output.body`. For a framework
handler that is the body. For a Lambda behind API Gateway it is the body
under proxy integration; under a non-proxy integration a mapping
template decides what goes on the wire, and the handler's return value
is that template's input.

When it fails, every body-field finding at that boundary describes a
shape the caller never receives. Summaries cannot decide this either.
No reader records the integration type on the boundary, so a proxy
handler and a non-proxy handler produce the same summary.

### A status the code computes states one outcome, and that outcome is unknown

`hasOpaqueStatus` reports `lowConfidence` at info and the transition
takes no further part. `return res.status(error.status ?? 500)` states
two outcomes: whatever the caught error contains, and 500. One opaque
record covers both, so the 500 never gets covered and never gets
reported.

### A field the consumer reads is present under that name, with whatever type the consumer wants

`providerCoversConsumerFields` walks field presence. The consumer's
leaves are `unknown`, because the IR records which fields were read and
not what was expected of them, and an unknown leaf matches anything.

A provider that sends `id` as a string where the consumer does
arithmetic on it agrees. A provider that sends `email: null` on every
response agrees. Two sides that use the same field names and different
encodings agree, and
[#387](https://github.com/nimbuscloud-ai/suss/issues/387) covers that
half of it.

### A consumer's fall-through path runs on the 2xx class and nothing else

A consumer branch with no guard on it is the success path. Widening it
to the whole space would call a 404 handled by code that never mentions
it.

### A `catch` covers every failure only when the client rejects on a non-2xx

axios and ky reject, so the caller never sees a response to guard on and
every failure arrives at the `catch`. `fetch` returns the response
instead, so the same `catch` covers nothing there.
A pack declares which of the two its client does, in
`metadata.http.failureDelivery`.

### A consumer is a statement made apart from the contract

`checkContractConsistency` skips comparing a provider against a contract
marked `derived`, because both came from the same source. It never skips
the consumer, on the grounds that a consumer is always an independent
observation.

A client generated from the same OpenAPI document agrees with that
document by construction, so the comparison records that the generator
ran. That is [#391](https://github.com/nimbuscloud-ai/suss/issues/391).

### The provider's transitions are every response it can send

A framework's own 500 on an uncaught throw is not one of them unless the
pack recorded a gap for it, and a `lowConfidence` from an
`unreadOutcome` gap is how a missing branch reaches the reader.

## Storage

### A field the query selects is the field the store knows by that name

`declaredFields.has(field)` compares strings. A Prisma `@map` or a SQL
`AS` gives a name in the code that differs from the name in the schema,
and the comparison reports an error-severity `boundaryFieldUnknown`
about a column that exists.

### A contract that calls its field set exhaustive saw the whole schema

`fieldSetIsComplete` is `contract.fieldSet === "exhaustive"`, and only a
contract that says so can call a selected field unknown. A reader that
parsed part of a schema and still declared the set exhaustive turns
every field it missed into an error.

### A secondary access path copies part of an item

A read that states no fields asks for the whole item, and the rule says
a secondary way in cannot serve that. The behaviour it describes is a
DynamoDB global secondary index with a `KEYS_ONLY` or `INCLUDE`
projection. Nothing in the rule reads the projection or restricts it to
DynamoDB, so a GSI projecting `ALL` or a PostgreSQL index would each
report the same error.

Only the CloudFormation and Terraform DynamoDB readers emit an access
path today, so the wider claim does not fire yet.

### The store refuses a request keyed on anything but its key fields

The `boundarySelectorMismatch` description says the store refuses the
request and the code fails when it runs. DynamoDB does. A SQL database
runs `WHERE email = ?` against a table whose primary key is `id` without
complaint. The rule fires for any store whose contract declares
`identifies`, and only the DynamoDB readers declare it today.

### A field is read when a query asks for it by name

The pass counts a read from what the query asked for, so a field the code
takes off a record the query already returned is invisible to it. A
codebase that selects whole rows and picks fields out of them in the
application leaves every column looking unread.

The finding's own text warns you about this: "suss counts a column as
read only when a query selects it, so before you treat the column as
dead, look for code that takes it off a record it already fetched". The
warning still fires on that evidence.
[#510](https://github.com/nimbuscloud-ai/suss/issues/510) is where
field-level access tracing would fix it properly.

### The run is the whole world

Even with a read counted correctly, `boundaryFieldUnused` only knows
about code in the analysed repository. A migration and an analytics
query are both outside the run, and either one turns the warning into a
claim about a field that has readers.

## Message bus

### A queue delivers each message at least once

SQS standard queues and SNS subscriptions both redeliver. Nothing in the
pass asks whether a consumer can take the same message twice, so a
handler that appends a row or charges a card per message has a defect
that no finding describes. Filed as
[#516](https://github.com/nimbuscloud-ai/suss/issues/516).

### Any producer on a channel could have sent any message a consumer receives

`collectProducerFields` unions the fields of every producer whose
channel pairs, and compares the consumer's reads against that union. One
channel that takes two message types is ordinary, and a field only the
other producer sends stops a `boundaryFieldUnknown` that was true.

### Every message-receive inside a consumer's code scope is on that consumer's channel

`collectReceives` filters by whether the summary runs in the scope, and
never consults the receive effect's own channel. A function wired to two
queues has both of its receives compared against each channel's producer
union.

### The body compared is the top-level object a producer builds

`readObjectBodyFields` reads the keys of an object literal. SQS wraps
the payload in a JSON string under `body` and EventBridge puts it under
`detail`. Where a pack does not unwrap the envelope for both sides, the
two field sets being compared sit at different levels.

### A declared subscription means messages are consumed

A handler bound to a subject counts the channel as consumed. Nothing
checks the permission to send or receive, or whether the code behind the
subscription is deployed. `metadata.messageBus.enabled` is treated as
the deployed state of a rule.

### A rule whose pattern resolved exactly receives everything on the subject

Prefix matching and content filtering come through as `unresolvable` and
get reported as `unsupportedSemantics` at info, so a filter that narrows
delivery without stopping it never takes part in pairing.

## Runtime config

### Every config-read effect is an environment variable on that unit's runtime config channel

`lookupConfigReads` flattens every semantics bucket in the interaction
index and casts the records, with a comment saying that in practice the
semantics are always runtime-config. Nothing checks it, and the
`instanceName` and `deploymentTarget` a finding prints come from a cast
of the runtime's binding.

A pack that recognized AWS Secrets Manager or SSM Parameter Store as a
config read would have its keys reported as environment variables the
runtime does not provide, at error severity. Only the node runtime pack
and the Cloudflare Workers env-bindings pack emit `config-read` today,
and both write runtime-config semantics, so the claim is true for now.

### A variable is its name

The comparison is `providedSet.has(read.name)`. A runtime declaring
`DATABASE_URL: ""` satisfies any read of `DATABASE_URL`, and nothing
compares the value or its format against what the code does with it.

### The provided set is everything the process receives

The stub layer that builds a runtime provider is responsible for folding
in the variables the platform injects, `AWS_REGION` and its neighbours.
The pass cannot verify that it did, and a stub that missed them makes
every `boundaryFieldUnknown` at that runtime a false one.

### A name read outside every closure was read by every runtime in the run

A dynamic import and a `require` call are both absent from the module
graph, so a read that no entry closure claims may still run somewhere.
`unclaimedReadNames` gives such a read to every scoped runtime, which
keeps the unused warning away from a variable whose reader the run
could not place. It also stops the warning when the only code reading
that name belongs to a different runtime in the same template.

## GraphQL

### A selection stops at a type the schema index does not contain

`objectTypes` contains object types, object extensions and interfaces. A
union field's type is absent from it, and so is a fragment condition
whose type the SDL never declares, so the walk returns and reports
nothing about the selection under it. A typo'd `... on Doge` and a
correct selection through a union come out the same way.

### A document defines one operation

`parseFirstOperation` reads the first operation definition and the rest
of the document goes unexamined. A file that ships two named queries has
one of them checked.

### An interface's fields are the ones its own definition declares

`extend interface` is missing from the SDL kinds the index accepts,
while `extend type` is there. A field added to an interface by extension
gets reported as one the schema does not declare, at error severity,
against a selection that is correct. Filed as
[#517](https://github.com/nimbuscloud-ai/suss/issues/517).

## What summaries cannot decide

Four of the claims above cannot be checked from summaries at all. Each
one needs something the IR does not record today.

- **The status the caller sees.** Needs the chain of hops between the
  two sides, with each hop's own effect on the status. `flow/` builds
  that chain for routing, and nothing attaches status behaviour to a
  hop.
- **The response body under a non-proxy integration.** Needs the
  integration type on the boundary, which no reader records.
- **Deployment state on a message bus.** Needs the account rather than
  the template: whether a subscription was confirmed, and whether the
  code behind it is deployed.
- **Whether the run is the whole world.** Needs to know what reads a
  store or a variable outside the analysed repository, which is a
  cross-repository question rather than a checker one.

## Where a claim is false today

- REST pairs across services:
  [#514](https://github.com/nimbuscloud-ai/suss/issues/514).
- A client that recorded a built URL pairs with no route, and the run
  stays quiet about it. No issue yet: the answer belongs to the client
  packs rather than to the pairing key.
- At-least-once delivery, and a consumer that cannot take a repeat:
  [#516](https://github.com/nimbuscloud-ai/suss/issues/516).
- A field added by `extend interface` gets reported as undeclared:
  [#517](https://github.com/nimbuscloud-ai/suss/issues/517).
- The media type is dropped from the body comparison:
  [#387](https://github.com/nimbuscloud-ai/suss/issues/387).
- A generated client gets compared against the document it came from:
  [#391](https://github.com/nimbuscloud-ai/suss/issues/391).
- A database instance is not part of a table's identity:
  [#412](https://github.com/nimbuscloud-ai/suss/issues/412).
