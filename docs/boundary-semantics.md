# Boundary semantics

Captures the layered model for boundary descriptions. As of Phase A
(the BoundarySemantics refactor), the IR's `BoundaryBinding` carries
all three layers explicitly. GraphQL, Lambda-invoke, and queue
semantics remain future work — the interfaces below are structured so
each lands as a discriminated-union variant without reshaping the
existing REST paths.

## The three layers

A "boundary" in suss is conceptually three things, which the IR
carries as sibling fields on `BoundaryBinding`:

### Transport

What bytes travel on the wire.

- HTTP / HTTPS
- TCP, AMQP, Kafka's own framing
- In-process function call
- Something over HTTPS to a cloud service API (AWS SDK over HTTPS-to-AWS)

Transport is mostly incidental to cross-boundary checking. It matters
for tooling concerns (authentication, retries, transport-level errors,
TLS, timeouts) but not for "does the provider's contract match what the
consumer reads?"

### Semantics

What the participants think they're doing. This is the layer cross-boundary
checking actually cares about.

- **REST resource** — discriminated by HTTP status code; payload is the
  response body (typically JSON). Pairing key: `(method, normalizedPath)`.
- **GraphQL operation** — discriminated by `errors.length === 0` plus
  per-field nulls in `data`; payload is the structured `data` object.
  Pairing key: operation name + variables shape.
- **Lambda direct invoke** — discriminated by `FunctionError === undefined`
  vs `"Handled"` vs `"Unhandled"`; payload is `Payload`. Pairing key:
  `FunctionName`. The HTTP layer is invisible to an `aws-sdk` consumer.
- **Kafka consume** — discriminated by topic + message headers; payload is
  `value` plus headers. Pairing key: topic.
- **Queue job (SQS, Celery, BullMQ, …)** — discriminated by job type;
  payload is job arguments. Pairing key: queue name + job name.
- **In-process function call** — discriminated by thrown exception type vs
  normal return; payload is the return value.
- **React component ↔ DOM** — a single component source yields *multiple*
  code units sharing a component identity: the render body (inputs=props/
  state/context, output=JSX tree), one code unit per event handler
  (inputs=synthetic event + closed-over state, outputs=state mutations +
  callback-prop invocations), and one per `useEffect` body
  (inputs=dependency array, outputs=side-effects + optional cleanup).
  Discriminator is the unit kind; payload is the tree-or-effect produced.
  Pairing key: `(component identity, unit kind, unit name?)`. See
  [`roadmap-react.md`](roadmap-react.md) for the multi-unit framing.
- **gRPC unary call** — discriminated by gRPC status enum (its own code
  space, *not* HTTP status); payload is the response message. Pairing
  key: `(service, method)`.

The same transport can carry many semantics. REST and GraphQL and Lambda
all travel over HTTPS but describe entirely different boundary shapes.
Conversely, the same semantics can travel over multiple transports —
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

## Shipped shape (Phase A)

`packages/ir/src/schemas.ts` exports `BoundaryBinding` as:

```ts
interface BoundaryBinding {
  /** Wire protocol (HTTP, TCP, AMQP, in-process, aws-https). */
  transport: string;

  /**
   * What the participants think they're doing. The checker dispatches
   * on the discriminator (`semantics.name`).
   */
  semantics:
    | {
        name: "rest";
        method: string;
        path: string;
        declaredResponses?: number[];
      }
    | {
        name: "function-call";
        module?: string;        // repo-relative module path
        exportName?: string;    // named export within that module
        package?: string;       // package.json `name` — set for package exports
        exportPath?: string[];  // sub-path + export trail — set for package exports
      };

  /** Pack-level recognition identity ("axios", "ts-rest", "openapi", …). */
  recognition: string;
}
```

`REST` is the dispatch-dominant case today — pairing, provider coverage,
consumer satisfaction, body compatibility, contract agreement, and
semantic bridging all read `semantics.name === "rest"` and narrow to
`method` + `path`. `function-call` is the escape hatch for in-process
units (React components, bare function exports, Storybook stub
components) that don't participate in REST pairing — it keeps the
binding shape valid and carries optional identity fields for
cross-module / cross-package pairing.

#### Identity: package exports vs. intra-repo references

`function-call` semantics carries two distinct identity slots because
library consumers and intra-repo callers look each other up through
different keys:

- **`module` / `exportName`** — a repo-relative module path (`"./components/Button"`) and a named export within it. Used by packs that pair inside a single repo — e.g. Storybook ↔ component pairing by identity name today; a future pass can tighten that to module pairing via these fields.
- **`package` / `exportPath`** — a package name (`"@suss/behavioral-ir"`) and the path to the export within the package (`["schemas", "BehavioralSummarySchema"]`). Set by the `packageExports` discovery variant. Sub-path exports contribute the first segment; root exports omit it.

A `React.Button` component discovered in-repo and the same component imported from a shipped package are *different bindings* — conflating the two would drop provenance. The checker's pairing key for `function-call` (landing with the consumer half) reads these slots separately.

### Future semantics variants

These aren't implemented; they're the shapes the IR will grow into
when the forcing function arrives. Each lands as an additional
discriminated-union variant:

- `{ name: "graphql-resolver"; typeName: string; fieldName: string }` —
  code-first resolvers (Apollo, Nexus, Pothos).
- `{ name: "graphql-operation"; operationName?: string; operationType: "query" | "mutation" | "subscription" }` —
  client-side operation pairing.
- `{ name: "lambda-invoke"; functionName: string; qualifier?: string }` —
  AWS SDK direct invokes.
- `{ name: "queue-job"; queue: string; jobName: string }` — SQS, BullMQ,
  Celery.
- `{ name: "kafka-message"; topic: string }`.

Anything that would shift REST's method/path out of `semantics` belongs
in its own variant — we don't retrofit existing variants.

### Pack helpers

`@suss/behavioral-ir` exports two builder helpers so packs don't
hand-roll the shape:

```ts
restBinding({ transport, method, path, recognition, declaredResponses? })
functionCallBinding({ transport, recognition, module?, exportName? })
```

`method === ""` or `path === ""` on a `rest` binding signals
"extracted but unresolved" — the adapter's wrapper-expansion post-pass
uses this to detect forwarding wrappers whose path only resolves at
caller sites. The checker's `boundaryKey` returns `null` for these,
keeping them out of automatic pairing.

## Dispatching on semantics

The checker's internal shape is:

- `pairing.boundaryKey(binding)` — returns `"METHOD /path"` for rest,
  null otherwise.
- `contract-agreement.ts` / `dedupe.ts` — use `boundaryKey` for
  grouping, treating non-rest bindings as un-paired.
- `cli/check.ts` formatting — falls back to
  `${recognition} (${transport})` when semantics isn't rest.
- `cli/inspect.ts` rendering — reads `semantics.name === "rest"` and
  renders `METHOD path`; otherwise shows the function name.

When GraphQL lands, each of these grows one dispatch arm rather than
branching on `transport === "http"` or similar transport-coupled
checks.

### Future: BoundarySemantics dispatch table

Today each check function narrows `binding.semantics.name === "rest"`
inline. That's fine for one semantics variant. The landing point when
we have two+ variants is a shared interface that each semantics
implements:

```ts
interface BoundarySemantics<S extends Semantics> {
  /** How pairing keys are derived from this binding. */
  pairingKey(binding: { semantics: S; transport: string }): string | null;

  /** What discriminator identifies this transition's outcome. */
  extractDiscriminator(transition: Transition): Discriminator | null;

  /** Find discriminator literals in a consumer transition's conditions. */
  consumerExpectedDiscriminators(
    transition: Transition,
    summary: BehavioralSummary,
  ): Discriminator[];

  /** Extract the payload shape from a provider transition. */
  extractPayload(transition: Transition): TypeShape | null;

  /** Unwrap consumer expectedInput to its payload-relative shape. */
  unwrapConsumerPayload(
    shape: TypeShape,
    summary: BehavioralSummary,
  ): TypeShape | null;
}
```

Registry lookup happens by `semantics.name`. `checkPair` / `checkAll`
don't change shape; each check function reads the appropriate
semantics via the registry instead of narrowing inline. Extraction of
the inline narrows into a registry is a follow-up once a second
variant lands — the shape is known but not worth the abstraction
until there's a concrete second case to check it against.

### Metadata stays namespaced by semantics

Already moving there: `metadata.http.{declaredContract, bodyAccessors,
statusAccessors}` today. The longer-term key space is sibling-per-
semantics:

- `metadata.http.*` — REST-scoped
- `metadata.graphql.*` — GraphQL-scoped
- `metadata.lambda.*` — Lambda-invoke-scoped
- ... and so on

Any key outside those namespaces is semantics-neutral and valid for every
boundary kind (e.g. `metadata.derivedFromWrapper` from the wrapper-
expansion post-pass).

### Boundaries compose

A production invocation often crosses more than one boundary. An HTTP
client hitting API Gateway → Lambda is *two* boundaries composed:

1. REST: client → API Gateway
2. Lambda-invoke: API Gateway → Lambda function

We partly handle this today via stubs — the API Gateway stub encodes the
Lambda integration → HTTP response mapping, so checking the HTTP client
against the API Gateway stub implicitly accounts for Lambda semantics.
Long-term, composition could become explicit in the IR: a transition's
output could reference another boundary it triggers, and checking becomes a
graph traversal. Tabled; stubs are adequate for now.

## What's shipped vs what's deferred

Shipped (Phase A):

1. `BoundaryBinding` carries `transport`, `semantics`, `recognition`
   as top-level fields. The type is the single source of truth;
   `restBinding` / `functionCallBinding` builders live in
   `@suss/behavioral-ir`.
2. `rest` + `function-call` semantics variants. Every pack and stub
   emits one or the other.
3. HTTP metadata is namespaced under `metadata.http.*`. Packs never
   write the flat form.
4. Pairing delegates to `boundaryKey` which dispatches on
   `semantics.name` — `function-call` summaries are left unmatched
   rather than fabricating a REST key.

Deferred (need a concrete consumer to force the shape):

1. A `BoundarySemantics<S>` dispatch table (above). Inline narrows are
   adequate for one dominant semantics.
2. GraphQL variants — both resolver-level (`graphql-resolver`) and
   client-side operation-level (`graphql-operation`). See the next
   section for why this is the forcing function.
3. Lambda-invoke and queue-based variants. These surface when the
   first non-HTTPS transport lands.

## The forcing function

The immediate forcing function is GraphQL. It shares transport (HTTP)
with REST but has entirely different semantics — resolver-level
dispatch (not method/path), error-presence + per-field null
discriminator (not status code), typed `data` payload (not arbitrary
body shape). Landing Apollo first (code-first resolvers, provider
side) surfaces resolver semantics cleanly before consumer shape
differences muddy the picture.

Lambda-invoke is the forcing function for "transport completely drops
out of the abstraction" — a Lambda invoke is behaviorally identical
whether the SDK call goes out from a laptop or from API Gateway's
integration. Today's HTTP-coupled defaults would silently break. Not
on the immediate path; the Apollo → AppSync arc lands first.

## Related decisions

See also:

- [`docs/status.md`](status.md) — decisions #18 (pack-aware checker via
  summary metadata), #22 (`BOUNDARY_ROLE`), #24 (pack-driven status
  accessors), #25 (this doc).
- [`docs/architecture.md`](architecture.md) — current package
  dependency shape and protocol assumptions.
- [`docs/framework-packs.md`](framework-packs.md) — how packs describe
  recognition today; extension points when semantics becomes a
  top-level axis.
- [`docs/stubs.md`](stubs.md) — boundary layering via the API Gateway
  stub is a precursor to explicit boundary composition.
