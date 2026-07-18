# Boundary semantics

The IR's `BoundaryBinding` carries all three layers of a boundary description
explicitly: what bytes travel (transport), what the participants think they're
doing (semantics), and how a particular library expresses that in source code
(recognition). This document describes the model, what's shipped, and where
the composition story is going.

## The three layers

A "boundary" in suss is conceptually three things, which the IR
carries as sibling fields on `BoundaryBinding`:

### Transport

What bytes travel on the wire.

- HTTP / HTTPS
- TCP, AMQP, Kafka's own framing
- In-process function call
- AWS SDK over HTTPS (to an AWS service API)

Transport is mostly incidental to cross-boundary checking. It matters
for tooling concerns (authentication, retries, transport-level errors,
TLS, timeouts) but not for "does the provider's contract match what the
consumer reads?"

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
- **React component ↔ DOM**: a single component source yields multiple
  code units sharing a component identity: the render body (inputs=props/
  state/context, output=JSX tree), one code unit per event handler
  (inputs=synthetic event + closed-over state, outputs=state mutations +
  callback-prop invocations), and one per `useEffect` body
  (inputs=dependency array, outputs=side-effects + optional cleanup).
  Discriminator is the unit kind; payload is the tree-or-effect produced.
  Pairing key: `(component identity, unit kind, unit name?)`. See
  [`roadmap-react.md`](roadmap-react.md) for the multi-unit framing.
- **gRPC unary call**: discriminated by gRPC status enum (its own code
  space, not HTTP status); payload is the response message. Pairing
  key: `(service, method)`.

The same transport can carry many semantics. REST, GraphQL, and Lambda
all travel over HTTPS but describe entirely different boundary shapes.
Conversely, the same semantics can travel over multiple transports , 
an SQS queue and a Kafka topic are both message-queue semantics with
different transports.

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
  GraphQL endpoint exposes the REST shape and requires a different
  recognition strategy.
- For Lambda invoke semantics, `@aws-sdk/client-lambda` returns
  `{ StatusCode, FunctionError, Payload, LogResult, ExecutedVersion }`;
  a direct call through `lambda.invoke().promise()` (v2 SDK) returns a
  different shape.

Recognition is a per-pack concern. Semantics determines what the pack is
ultimately describing, not what the recognition rules look like.

## Shipped shape

`packages/ir/src/schemas.ts` exports `BoundaryBinding` as:

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

`Semantics` is a discriminated union of seven variants today:

```ts
type Semantics =
  | { name: "rest"; method: string; path: string; declaredResponses?: number[] }
  | { name: "function-call"; module?: string; exportName?: string; package?: string; exportPath?: string[] }
  | { name: "graphql-resolver"; typeName: string; fieldName: string }
  | { name: "graphql-operation"; operationType: "query" | "mutation" | "subscription"; operationName?: string }
  | { name: "runtime-config"; deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment"; instanceName: string }
  | { name: "storage-relational"; storageSystem: "postgres" | "mysql" | "sqlite"; scope: string; table: string }
  | { name: "message-bus"; messageBus: "sqs" | "bullmq" | "kafka" | "nats"; channel: string };
```

### Semantics in use today

**`rest`** is the dispatch-dominant case, pairing, provider coverage,
consumer satisfaction, body compatibility, and semantic bridging all read
`semantics.name === "rest"` and narrow to `method` + `path`. `method === ""`
or `path === ""` signals "extracted but unresolved"; `boundaryKey` returns
`null` for these, keeping them out of automatic pairing.

**`function-call`** handles in-process units (React components, bare function
exports, Storybook stub components) that don't participate in REST pairing.
It carries two distinct identity slots because library consumers and
intra-repo callers look each other up through different keys:

- **`module` / `exportName`**: a repo-relative module path and a named
  export within it. Used by packs that pair inside a single repo.
- **`package` / `exportPath`**: a package name (`"@suss/behavioral-ir"`)
  and the path to the export within the package. Set by the `packageExports`
  discovery variant. The checker's pairing key for `function-call` reads
  these slots as `fn:<package>::<exportPath>` and pairs package exports
  that way; intra-repo `module`/`exportName` pairing is not yet wired.

A React component discovered in-repo and the same component imported from a
shipped package are different bindings, conflating the two would lose provenance.

**`graphql-resolver`** and **`graphql-operation`** both ship. Resolver-level
pairing keys on `gql:${typeName}.${fieldName}`. Operation-to-resolver pairing
runs through `pairGraphqlOperations` (in `packages/checker/src/pairing/`),
which walks the operation's selection set to pair root selections against the
matching `graphql-resolver` provider. `checkGraphqlContractAgreement` then
compares `metadata.graphql.declaredContract` across sources that declare it , 
comparing return type compatibility and argument-set agreement.

**`runtime-config`** tracks the env-var channel of a deployable unit as a
boundary. Env var names are fields on the channel's contract, analogous to
response body fields on a REST endpoint. Pairing key: `(deploymentTarget,
instanceName)`. The env var list lives in `metadata.runtimeContract.envVars`;
`metadata.codeScope` declares which source files run inside the channel.

**`storage-relational`** covers Postgres, MySQL, and SQLite tables declared
via Prisma, Drizzle, TypeORM, or raw DDL. Columns are fields on the table's
contract; field-level access checks compare what code reads/writes against
`metadata.storageContract.columns`. Pairing key: `(storageSystem, scope, table)`.

**`message-bus`** covers SQS, BullMQ, Kafka, and NATS. Producer-side
`interaction(class: "message-send")` effects pair against it; consumer-side
handlers gain the same shape via the deployment-manifest contract source (CFN
event-source mappings and similar). Pairing key: `(messageBus, channel)`.

### Pack helpers

`@suss/behavioral-ir` exports eight builder helpers so packs don't hand-roll
the three-layer shape:

```ts
restBinding({ transport, method, path, recognition, declaredResponses? })
functionCallBinding({ transport, recognition, module?, exportName?, package?, exportPath? })
packageExportBinding({ recognition, packageName, exportPath, transport? })
graphqlResolverBinding({ transport, recognition, typeName, fieldName })
graphqlOperationBinding({ transport, recognition, operationType, operationName? })
runtimeConfigBinding({ recognition, deploymentTarget, instanceName })
storageRelationalBinding({ recognition, storageSystem, scope, table })
messageBusBinding({ recognition, messageBus, channel })
```

`packageExportBinding` is a thin wrapper over `functionCallBinding` that
makes call sites declarative, it defaults `transport` to `"in-process"`.

## Dispatching on semantics

The checker's dispatch today is per-semantics but ad-hoc rather than
registry-backed:

- `pairing.boundaryKey(binding)`: returns `"METHOD /path"` for `rest`,
  `"gql:Type.field"` for `graphql-resolver`, `"fn:<package>::<exportPath>"`
  for package-export `function-call`, `null` for everything else.
- `graphqlPairing.pairGraphqlOperations`: separate pass that pairs
  `graphql-operation` consumers against `graphql-resolver` providers by
  walking the selection set.
- `contract/graphqlContractAgreement.ts`: compares `metadata.graphql.declaredContract`
  across providers at the same resolver boundary.
- Per-domain checker modules (`message-bus/`, `runtime-config/`, `storage/`)
  handle their semantics directly without going through `boundaryKey`, they
  filter by `semantics.name` and apply the appropriate pairing logic.
- `cli/inspect.ts` rendering, reads `semantics.name === "rest"` and renders
  `METHOD path`; other semantics fall back to the function name or recognition
  string.

A `BoundarySemantics<S>` registry, one per semantics, with `pairingKey`,
`extractDiscriminator`, and `extractPayload` as interface methods, would
consolidate the inline narrows each check function currently does. That
abstraction has been deferred: multiple variants have shipped but the registry
hasn't been extracted yet. It's a refactor, not a design question.

### Metadata namespaced by semantics

Already moved there: `metadata.http.{declaredContract, bodyAccessors,
statusAccessors}` for REST, and `metadata.graphql.{declaredContract, schemaSdl}`
for GraphQL. The namespace convention applies across all semantics:

- `metadata.http.*`, REST-scoped
- `metadata.graphql.*`, GraphQL-scoped
- `metadata.runtimeContract.*`: runtime-config env var lists
- `metadata.storageContract.*`: column declarations for storage-relational

Keys outside those namespaces are semantics-neutral (e.g.
`metadata.derivedFromWrapper` from the wrapper-expansion post-pass).
`metadata.codeScope` is also semantics-neutral: it declares source-file scope
for any boundary whose provider and consumer need scope-aware pairing.

### Future semantics variants

Two variants remain ahead:

- `{ name: "lambda-invoke"; functionName: string; qualifier?: string }` , 
  AWS SDK direct invokes. The forcing function here is "transport drops out
  entirely", a Lambda invoke is behaviorally the same whether the SDK call
  originates from a laptop or from API Gateway's integration.
- `{ name: "kafka-message"; topic: string }`, Kafka topics beyond the
  `message-bus` variants already covered by SQS/BullMQ/NATS.

Each ships as an additional discriminated-union variant without reshaping
existing ones. Nothing that would shift REST's method/path out of `semantics`
belongs retrofitted onto an existing variant.

## Boundaries compose

A production invocation often crosses more than one boundary. An HTTP client
hitting Route53 → ALB → API Gateway → Lambda → Express handler is five
boundaries composed. Each hop has a provider side (what it exposes upstream)
and a consumer side (what it calls downstream), and pairwise pairing handles
each hop the same way today's REST pairing does.

The direction is to model each cloud-infra component as a separate code unit
with its own `BoundaryBinding` on each side. For that to work, three things
need to be true:

1. **Binding identities need to be composable.** An API Gateway binding's
   `path: "/users/*"` needs to match against an Express server's mount point.
   Today's exact-path matching doesn't handle wildcards or prefix rewrites
   across hops.
2. **Contract packs need to emit both sides.** Today's `contract-aws-apigateway`
   only emits the public-facing side. Richer versions need to also emit
   what API Gateway calls downstream, so the checker can pair the downstream
   side of one hop against the upstream side of the next.
3. **Transformations between hops have no IR representation.** Path rewrites,
   header additions, and body shape changes between a unit's input binding and
   its output binding are the genuinely missing IR primitive. A proxy that
   strips a path prefix before forwarding changes the binding identity across
   the hop, there's currently no way to declare that mapping.

A `binding.role: "proxy" | "handler" | "transform"` enum was considered and
rejected. Transformation is a continuum; the right modeling is a
transformation descriptor (path-rewrite rules, header-add list, etc.), not
a category enum.

Multi-hop chain assembly is a query-layer concern, not internal to suss. Given
pairwise pairing over rich-enough binding identities, walking chains is graph
traversal over the pairing results, the kind of thing an MCP tool or a query
CLI does over the summary store. The IR additions (transformation descriptor
and richer contract packs for each infrastructure component's consumer side)
are the work ahead.

## What's shipped vs what's deferred

Shipped:

1. `BoundaryBinding` carries `transport`, `semantics`, `recognition` as
   top-level fields. `@suss/behavioral-ir` exports eight binding builder
   helpers; packs and contract sources use them rather than hand-rolling
   the shape.
2. Seven `semantics` variants: `rest`, `function-call`, `graphql-resolver`,
   `graphql-operation`, `runtime-config`, `storage-relational`, `message-bus`.
3. Metadata namespaced under `metadata.http.*` and `metadata.graphql.*`,
   with `metadata.runtimeContract.*` and `metadata.storageContract.*` for the
   newer semantics.
4. Checker modules for HTTP/REST, GraphQL (contract agreement and operation
   pairing), message-bus, storage, runtime-config, and Storybook stories.
5. `boundaryKey` dispatches on `semantics.name`; summaries without a
   matchable key go to `unmatched.noBinding` rather than being fabricated
   into REST pairs.

Deferred:

1. A `BoundarySemantics<S>` dispatch registry. The inline narrows in each
   check function are adequate, but extracting a shared interface is overdue
   given the number of shipped variants.
2. `lambda-invoke` and `kafka-message` semantics variants.
3. Composable binding identities and transformation descriptors for multi-hop
   infra chains, described in the section above.
4. Operation-level consumer-side GraphQL pairing beyond root-field selection
   (nested type checking via the SDL is wired; full variable-type comparison
   against resolver arguments is not).

## Related decisions

See also:

- [`docs/status.md`](status.md), decisions #18 (pack-aware checker via
  summary metadata), #22 (`BOUNDARY_ROLE`), #24 (pack-driven status
  accessors), #25 (this doc).
- [`docs/architecture.md`](architecture.md), current package
  dependency shape and protocol assumptions.
- [`docs/reference/pack-patterns.md`](reference/pack-patterns.md), how
  packs describe recognition today; extension points when semantics
  becomes a top-level axis.
- [`docs/contract-sources.md`](contract-sources.md), boundary layering
  via the AWS API Gateway contract reader is a precursor to explicit
  boundary composition.
