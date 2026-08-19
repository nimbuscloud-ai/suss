# Boundary semantics

The IR's `BoundaryBinding` has all three layers of a boundary description as
separate fields: what bytes travel (transport), what the participants think
they're doing (semantics), and how a particular library expresses that in
source code (recognition).

Eight semantics variants ship today: `rest`, `function-call`,
`graphql-resolver`, `graphql-operation`, `runtime-config`,
`storage`, `message-bus`, and `metric`, each as its own module under
`packages/ir-core/src/semantics/`. If you came to ask whether a protocol
already works, go to [What's shipped vs what's deferred](#whats-shipped-vs-whats-deferred);
everything else explains the model those variants share.

## The three layers

A "boundary" in suss is three things at once, which the IR stores as
sibling fields on `BoundaryBinding`:

### Transport

What bytes travel on the wire.

- HTTP / HTTPS
- TCP, AMQP, Kafka's own framing
- In-process function call
- AWS SDK over HTTPS (to an AWS service API)

Transport is mostly beside the point for cross-boundary checking. It
matters for tooling concerns (authentication, retries, transport-level
errors, TLS, timeouts) but not for "does the provider's contract match
what the consumer reads?"

### Semantics

What the participants think they're doing. This is the layer cross-boundary
checking actually cares about.

- **REST resource**: discriminated by HTTP status code; payload is the
  response body (typically JSON). Pairing key: `(method, normalizedPath)`.
- **GraphQL operation**: discriminated by `errors.length === 0` plus
  per-field nulls in `data`; payload is the structured `data` object.
  Pairing key: `(typeName, fieldName)` for resolver-level; operation-to-
  resolver mapping via `pairGraphqlOperations`.
- **Lambda direct invoke**: discriminated by `FunctionError === undefined`
  vs `"Handled"` vs `"Unhandled"`; payload is `Payload`. Pairing key:
  `FunctionName`. The HTTP layer is invisible to an `aws-sdk` consumer.
- **Kafka consume**: discriminated by topic + message headers; payload is
  `value` plus headers. Pairing key: topic.
- **Queue job (SQS, BullMQ, …)**: discriminated by job type; payload is
  job arguments. Pairing key: queue name + job name.
- **In-process function call**: discriminated by thrown exception type vs
  normal return; payload is the return value.
- **React component ↔ DOM**: one component source produces several
  code units that share a component identity: the render body (inputs=props/
  state/context, output=JSX tree), one code unit per event handler
  (inputs=synthetic event + closed-over state, outputs=state mutations +
  callback-prop invocations), and one per `useEffect` body
  (inputs=dependency array, outputs=side-effects + optional cleanup).
  The discriminator is the unit kind, and the payload is the tree or the
  effect it produces.
  Pairing key: `(component identity, unit kind, unit name?)`. See
  [`roadmap-react.md`](internal/roadmap-react.md) for the multi-unit framing.
- **gRPC unary call**: discriminated by gRPC status enum (its own code
  space, not HTTP status); payload is the response message. Pairing
  key: `(service, method)`.

One transport can serve many semantics. REST, GraphQL, and Lambda all
travel over HTTPS but describe entirely different kinds of boundary.
It works the other way too: one semantics can travel over several
transports, since an SQS queue and a Kafka topic are both message-queue
semantics with different transports.

### Recognition

How a particular library expresses a given semantics in source code. This
is what today's `PatternPack` already describes and what
`responseSemantics` partially captures.

- For REST semantics, axios recognises the response via `.data` and the
  status via `.status`; fetch via `.body` / `.json()` / `.status`; ts-rest
  via the `.body` of its typed result. All three are REST packs with
  different recognition rules.
- For GraphQL semantics, urql exposes `{ data, error }`; Apollo client
  exposes `{ data, error, loading }`; a raw fetch wrapper around a
  GraphQL endpoint exposes the same structure a REST call does and needs
  a different recognition strategy.
- For Lambda invoke semantics, `@aws-sdk/client-lambda` returns
  `{ StatusCode, FunctionError, Payload, LogResult, ExecutedVersion }`;
  a direct call through `lambda.invoke().promise()` (v2 SDK) returns
  something different.

Recognition is a per-pack concern. Semantics says what the pack is
describing in the end, not what its recognition rules look like.

## Shipped shape

`packages/behavioral-ir/src/schemas.ts` exports `BoundaryBinding` as:

```ts
interface BoundaryBinding {
  /** Wire protocol (http, tcp, amqp, in-process, aws-https, …). */
  transport: string;

  /**
   * What the participants think they're doing. The checker dispatches
   * on the discriminator (`semantics.name`).
   */
  semantics: Semantics; // discriminated union — see below

  /** Pack-level recognition identity ("axios", "ts-rest", "openapi", …). */
  recognition: string;
}
```

`Semantics` is a discriminated union of eight variants today:

```ts
type Semantics =
  | { name: "rest"; method: string | null; path: string | null; declaredResponses?: number[] }
  | { name: "function-call"; module?: string; exportName?: string; package?: string; exportPath?: string[] }
  | { name: "graphql-resolver"; typeName: string | null; fieldName: string }
  | { name: "graphql-operation"; operationType: "query" | "mutation" | "subscription"; operationName?: string }
  | { name: "runtime-config"; deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment"; instanceName: string }
  | { name: "storage"; storageSystem: string; scope: string; container: string | null; accessPath: string | null }
  | { name: "message-bus"; messageBus: "aws_sqs" | "aws.sns" | "s3" | "eventbridge" | "bullmq" | "kafka" | "nats"; channel: string | null }
  | { name: "metric"; metricSystem: string; metricType: string | null };
```

An identity field is null when the source never states it. A queue
URL that comes from a variable is the common case:

```json
{ "name": "message-bus", "messageBus": "aws_sqs", "channel": null }
```

The send is recorded. It pairs with nothing. The empty string is
invalid in these fields, and the builders throw on it. REST's method
also allows `"*"`, which means the handler responds to every method.

### Semantics in use today

**`rest`** is the case most of the dispatch is built around: pairing,
provider coverage, consumer satisfaction, body compatibility, and
semantic bridging all read `semantics.name === "rest"` and narrow to
`method` + `path`. A null method or path means the source never stated
one, and `boundaryKey` returns `null` for these, which keeps them out of
automatic pairing. A `"*"` method groups by path and pairs with whatever
method each consumer uses.

**`function-call`** handles in-process units (React components, bare function
exports, Storybook contract components) that don't take part in REST pairing.
It has two separate identity slots, because library consumers and callers
inside the same repo look each other up through different keys:

- **`module` / `exportName`**: a repo-relative module path and a named
  export within it. Packs that pair inside a single repo use these.
- **`package` / `exportPath`**: a package name (`"@suss/behavioral-ir"`)
  and the path to the export within the package. The `packageExports`
  discovery variant sets these. The checker's pairing key for `function-call`
  reads these slots as `fn:<package>::<exportPath>` and pairs package exports
  that way; pairing on `module`/`exportName` within a repo is not wired up yet.

A React component found in the repo and the same component imported from a
shipped package are different bindings. Treating them as one would lose track
of where each came from.

**`graphql-resolver`** and **`graphql-operation`** both ship. Resolver-level
pairing keys on `gql:${typeName}.${fieldName}`. Operation-to-resolver pairing
runs through `pairGraphqlOperations` (in `packages/checker/src/pairing/`),
which walks the operation's selection set and pairs root selections against the
matching `graphql-resolver` provider. `checkGraphqlContractAgreement` then
compares `metadata.graphql.declaredContract` across the sources that declare
it, checking that the return types are compatible and the argument sets agree.

**`runtime-config`** treats the env-var channel of a deployable unit as a
boundary. Env var names are fields on that channel's contract, the same way
response body fields are fields on a REST endpoint's contract. Pairing key:
`(deploymentTarget, instanceName)`. The env var list lives in
`metadata.runtimeContract.envVars`, and `metadata.codeScope` says which source
files run inside the channel.

**`storage`** covers every store: a Postgres table declared through Prisma,
Drizzle, TypeORM, or raw DDL, and a DynamoDB table, a bucket, or an index the
same way. The container is the table, bucket, or collection, and `accessPath`
is a secondary way in, a global secondary index or an alias, or null for the
container's own primary key. What a store declares an item has are fields on
the container's contract, and field-level access checks compare what the code
reads and writes against `metadata.storageContract.fields`. Pairing key: `(storageSystem, scope,
container, accessPath)`.

Whether a field the code touches can be called unknown is a property the
provider declares, not something the store's name implies:
`metadata.storageContract.fieldSet` is `"exhaustive"` for a SQL schema that
declares every column, `"partial"` for a store that declares its keys and lets
the rest vary, and `"none"` for a blob. Only an exhaustive contract produces
`boundaryFieldUnknown`. `metadata.storageContract.identifies` says what picks
one item out of the container, either the key fields in the order the store
keys on them or a convention the key follows.

**`message-bus`** covers SQS, SNS, S3, EventBridge, BullMQ, Kafka, and NATS.
Producer-side `interaction(class: "message-send")` effects pair against it, and
consumer-side handlers get the same binding from the deployment-manifest
contract source (CFN event-source mappings and similar). Pairing key:
`(messageBus, channel)`. A send whose queue the code works out at runtime
has a null channel. A receive effect always has one: the event-source
mapping is what states which queue the handler drains, and the checker joins
the two by code scope.

**`metric`** is a named series of measurements: one side declares it, another
side reads it back by the type string the monitoring system gives it. Neither
side can see the other's declaration, so the type string is the whole identity.
Pairing key: `(metricSystem, metricType)`. What only the declaring side knows,
whether a measurement is one number or a histogram, goes on its summary's
metadata, the way a storage contract's field list does.

### Pack helpers

`@suss/behavioral-ir` exports nine builder helpers so packs don't hand-roll
the three-layer structure themselves:

```ts
restBinding({ transport, method /* string | null */, path /* string | null */, recognition, declaredResponses? })
functionCallBinding({ transport, recognition, module?, exportName?, package?, exportPath? })
packageExportBinding({ recognition, packageName, exportPath, transport? })
graphqlResolverBinding({ transport, recognition, typeName /* string | null */, fieldName })
graphqlOperationBinding({ transport, recognition, operationType, operationName? })
runtimeConfigBinding({ recognition, deploymentTarget, instanceName })
storageRelationalBinding({ recognition, storageSystem, scope, table })
messageBusBinding({ recognition, messageBus, channel /* string | null */ })
metricBinding({ recognition, metricSystem, metricType /* string | null */ })
```

The builders throw on an empty string in an identity field. Write null
when the source does not state a value.

`packageExportBinding` is a thin wrapper over `functionCallBinding` that
makes call sites declarative. It defaults `transport` to `"in-process"`.

## Where the words come from

A summary says what a unit can reach; a trace says what it did reach.
Comparing them is what neither static analysis nor observability does
today, and it needs both sides to spell a boundary the same way. So
wherever OpenTelemetry's semantic conventions have a word for something
in a binding, suss writes their word, and the rest of the vocabulary is
ours. A span stays a record of one execution and a summary stays a
statement about a unit, and suss does not emit traces.

### The values are theirs

| suss field | values | OpenTelemetry attribute |
| --- | --- | --- |
| `storage.storageSystem` | `postgresql`, `mysql`, `sqlite`, `redis`, `aws.dynamodb` | `db.system.name` |
| `storage.scope` | the database, schema, or keyspace | `db.namespace` |
| `storage.container` | the table, bucket, or collection | `db.collection.name` |
| `message-bus.messageBus` | `aws_sqs`, `aws.sns`, `kafka` | `messaging.system` |
| `message-bus.channel` | the queue, topic, or subject | `messaging.destination.name` |
| `rest.method` | `GET`, `POST`, … | `http.request.method` |
| `rest.path` | `/users/{id}` | `http.route` |
| `graphql-operation.operationType` | `query`, `mutation`, `subscription` | `graphql.operation.type` |
| `graphql-operation.operationName` | the document's name | `graphql.operation.name` |

`aws_sqs` has an underscore and `aws.sns` has a dot because that is how
the conventions spell them, one predating the other.

Summaries written before this used `postgres`, `dynamodb`, `sqs`, and
`sns`. They read back with the new names through the normalizer in
`@suss/behavioral-ir`, which brought the format to schema version 5;
the metric words above followed at version 6. Pack
config takes the new name too: a project passing
`{ "storageSystem": "postgres" }` to the sqlalchemy, activerecord,
prisma or drizzle pack writes `postgresql` instead.

### The field names are ours

An attribute name is a flat namespaced key (`db.system.name`), and an
identity field is a member of a union that `semantics.name` already
namespaces. Renaming the fields would leave a consumer working out the
prefix anyway, so the fields keep their names and each protocol module
declares which attribute each field goes under:

```ts
semconv: {
  storageSystem: { name: "db.system.name" },
  scope: { name: "db.namespace", placeholderValues: ["default"] },
  container: { name: "db.collection.name" },
},
```

`semconvAttributes(binding)` reads a binding through those declarations:

```ts
semconvAttributes(binding);
// { "db.system.name": "postgresql", "db.namespace": "orders",
//   "db.collection.name": "users" }
```

A field is in that projection only when our value is the value a span
gets, so a consumer joining a summary against a trace compares strings
and keeps no table of its own.

### Where it stops

Three kinds of field stay out of the projection, and every protocol
module says which case it is in:

- **The conventions never named it.** A secondary index
  (`storage.accessPath`) is one. A `graphql-resolver` is another: the
  conventions describe the operation a client sent, not the resolver the
  server ran for one field of it.
- **The value is ours because no source stated one.** `storage.scope` is
  `"default"` when nothing said which database, and `rest.method` is
  `"*"` for a route that responds to every method. A span says neither,
  so emitting them would only ever produce a mismatch.
- **The same thing under a different string.** `service.name` and
  `cloud.resource_id` both point at the deployable that a
  `runtime-config` boundary belongs to, but `instanceName` is the
  deployment template's logical id, which is neither of those strings.

Whole protocols stay ours as well. A `function-call` boundary is a call
that never leaves the process, and a `metric` has a system and a type
string the conventions never covered. A metric's measurement words in
its contract metadata do come from OpenTelemetry, though from the
metrics data model rather than an attribute registry: `histogram` for a
bucketed measurement, and `gauge`, `delta`, `cumulative` for what one
measurement covers. Nor did the conventions cover every store or
bus: `s3`, `gcs`, `r2`, `d1` and `cloudflare-kv` on one side,
`eventbridge`, `bullmq`, `nats` and the Cloudflare triggers on the
other. `transport` is our own axis too, since the wire behind an
AWS SDK call is not something a span reports.

That is most of what makes suss useful: a boundary nobody crosses at run
time never gets a span, so nobody outside has had to give it a name. When you
add a protocol, fill in its `semconv`, empty included, and the compiler
makes you answer the question.

## Dispatching on semantics

Each protocol is one module under `@suss/ir-core`'s `semantics/`
directory: its schema and its `BoundaryBehavior` live together, and
the registry composes the modules into the `Semantics` union and the
runtime lookup. Each behavior has to answer three questions:

- `identityKey`: the name a reader sees and a suppression targets
  (`"GET /users/{id}"`, `"* /api/users"`, `"bus:aws_sqs order.placed"`), or
  null when the source never stated one.
- `pairingKey`: the bucket that pairing groups by. It contains what both
  sides always know. A REST bucket contains the path alone, so
  `GET /users` and `* /users` both land in `rest /users`.
- `sidesAgree`: decides the part the bucket left out. `GET` agrees with
  `GET` and with `"*"`. `default#order.placed` agrees with
  `order.placed` and disagrees with `staging#order.placed`.

`boundaryKey`, `pairingKey`, and `semanticsAgree` in
`packages/ir-core/src/boundaryKey.ts` are thin lookups over the
registry. Adding a protocol means adding one module and one line in each
registry list. A compile-time check fails when the two lists differ.
The definitions ship with ir-core rather than with packs, because a
published summary has to mean the same thing to a reader who never
installed the pack that wrote it.

The passes that pair through their own machinery still do so:
`pairGraphqlOperations` walks selection sets, and the per-domain checker
modules (`message-bus/`, `runtime-config/`, `storage/`) filter by
`semantics.name`. `identityKey` returns null for the `runtime-config`
and `storage` variants, and `message-bus` keys and pairs
through the generic pass as well.

### Metadata namespaced by semantics

Two sets of keys have already moved there: `metadata.http.{declaredContract,
bodyAccessors, statusAccessors}` for REST, and
`metadata.graphql.{declaredContract, schemaSdl}` for GraphQL. The same
naming convention applies across all semantics:

- `metadata.http.*`, REST-scoped
- `metadata.graphql.*`, GraphQL-scoped
- `metadata.sourceDocument.label`: which document a summary was read out
  of, so summaries from one document can find each other. The GraphQL
  schema goes on the summary standing for the schema document, and its
  resolvers reach it through the shared label
- `metadata.runtimeContract.*`: runtime-config env var lists
- `metadata.storageContract.*`: the field declarations for a storage
  container, and whether they are the complete set

Keys outside those namespaces are semantics-neutral (e.g.
`metadata.derivedFromWrapper` from the wrapper-expansion post-pass).
`metadata.codeScope` is semantics-neutral too: it says which source files a
boundary covers, for any boundary whose provider and consumer need pairing
that takes scope into account.

### Future semantics variants

Two variants are still to come:

- `{ name: "lambda-invoke"; functionName: string; qualifier?: string }` for
  AWS SDK direct invokes. What forces the issue here is that transport drops
  out entirely: a Lambda invoke behaves the same whether the SDK call comes
  from a laptop or from API Gateway's integration.
- `{ name: "kafka-message"; topic: string }` for Kafka topics beyond the
  `message-bus` variants already covered by SQS/BullMQ/NATS.

Each one ships as another discriminated-union variant, and none of them
reshape the existing variants. If something would move REST's method/path out
of `semantics`, it does not belong retrofitted onto an existing variant.

## Boundaries compose

A production invocation often crosses more than one boundary. An HTTP client
hitting Route53 → ALB → API Gateway → Lambda → Express handler crosses five
boundaries, one composed on the next. Each hop has a provider side (what it
exposes upstream) and a consumer side (what it calls downstream), and pairing
two sides at a time handles each hop the same way today's REST pairing does.

The plan is to model each cloud-infra component as a separate code unit
with its own `BoundaryBinding` on each side. For that to work, three things
need to be true:

1. **Binding identities need to be composable.** An API Gateway binding's
   `path: "/users/*"` needs to match against an Express server's mount point.
   Today's exact-path matching doesn't handle wildcards or prefix rewrites
   across hops.
2. **Contract packs need to emit both sides.** Today's `contract-aws-apigateway`
   only emits the public-facing side. Richer versions need to emit what API
   Gateway calls downstream as well, so the checker can pair the downstream
   side of one hop against the upstream side of the next.
3. **Transformations between hops have no IR representation.** Path rewrites,
   header additions, and changes to the body's structure between a unit's input
   binding and its output binding are the missing IR primitive. A proxy that
   strips a path prefix before forwarding changes the binding identity across
   the hop, and there is currently no way to declare that mapping.

A `binding.role: "proxy" | "handler" | "transform"` enum was considered and
rejected. Transformation is a continuum, so the right way to model it is a
transformation descriptor (path-rewrite rules, header-add list, etc.) rather
than a category enum.

Assembling multi-hop chains belongs in the query layer, not inside suss. Once
pairing works two sides at a time over binding identities rich enough to carry
the details, walking a chain is graph traversal over the pairing results, the
kind of thing an MCP tool or a query CLI does over the summary store. The IR
additions (a transformation descriptor, and richer contract packs for the
consumer side of each infrastructure component) are the work ahead.

## What's shipped vs what's deferred

Shipped:

1. `BoundaryBinding` has `transport`, `semantics`, and `recognition` as
   top-level fields. `@suss/behavioral-ir` exports nine binding builder
   helpers; packs and contract sources use them rather than hand-rolling
   the structure themselves.
2. Eight `semantics` variants: `rest`, `function-call`, `graphql-resolver`,
   `graphql-operation`, `runtime-config`, `storage`, `message-bus`, `metric`.
3. Metadata namespaced under `metadata.http.*` and `metadata.graphql.*`,
   with `metadata.runtimeContract.*` and `metadata.storageContract.*` for the
   newer semantics.
4. Checker modules for HTTP/REST, GraphQL (contract agreement and operation
   pairing), message-bus, storage, runtime-config, and Storybook stories.
5. `boundaryKey` dispatches on `semantics.name`. Summaries without a
   matchable key go to `unmatched.unpairable`, and each entry says why,
   instead of being fabricated
   into REST pairs.

The dispatch registry has shipped since the list above was first written.
Each variant declares its behavior (`identityKey`, `pairingKey`,
`sidesAgree`) in its own module under `packages/ir-core/src/semantics/`,
and `registry.ts` composes them with a compile-time completeness check.

Deferred:

1. `lambda-invoke` and `kafka-message` semantics variants.
2. Composable binding identities and transformation descriptors for multi-hop
   infra chains, described in the section above.
3. Operation-level consumer-side GraphQL pairing beyond root-field selection
   (nested type checking via the SDL is wired; full variable-type comparison
   against resolver arguments is not).

## Related decisions

See also:

- [`docs/internal/status.md`](internal/status.md), decisions #18 (pack-aware checker via
  summary metadata), #22 (`BOUNDARY_ROLE`), #24 (pack-driven status
  accessors), #25 (this doc).
- [`docs/architecture.md`](architecture.md), the current package
  dependency graph and protocol assumptions.
- [`docs/reference/pack-patterns.md`](reference/pack-patterns.md), how
  packs describe recognition today, and the extension points for when
  semantics becomes a top-level axis.
- [`docs/contract-sources.md`](contract-sources.md), where boundary
  layering through the AWS API Gateway contract reader is a precursor to
  explicit boundary composition.
