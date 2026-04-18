# Boundary semantics

Design-only. Captures the layered model for boundary descriptions and the
refactor arc the checker will take when a second protocol lands. Today's
implementation is HTTP-shaped throughout; this doc exists so we can make
small decisions now in a way that's consistent with where we're heading,
and so we have a single north star when the second protocol forces the
abstraction.

## The three layers

A "boundary" in suss is conceptually three things, and we currently smush
them all into `BoundaryBinding.protocol` + `BoundaryBinding.framework`:

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
- **React parent-child render** — discriminated by which child component is
  rendered; payload is props passed to that child. Pairing key: component
  name.
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

## What the current code conflates

- `BoundaryBinding.protocol: string` is doing the work of *both* transport
  and semantics with no distinction (`"http"` covers everything from REST
  to GraphQL to Lambda-invoke over HTTPS).
- `BoundaryBinding.framework: string` is doing the work of recognition
  identity ("ts-rest", "express", "fetch", "axios") but only for HTTP
  frameworks.
- `BoundaryBinding.(method, path)` are REST-specific and would be empty
  for any non-REST semantics even if they're HTTP-transported (e.g. a
  GraphQL endpoint served at a single path).
- Pairing is hardcoded to `(method, normalizedPath)` in
  `packages/checker/src/pairing.ts`.
- The checker's helpers — `extractResponseStatus`,
  `consumerExpectedStatuses`, `bodyAccessorsFor`, `statusAccessorsFor`,
  the 2xx success-range heuristic in provider-coverage — all encode REST
  semantics.

None of this is wrong today; REST is our one concrete case. But each
piece quietly assumes the shape will never change.

## The target shape

When we need a second semantics, the cleanest destination looks something
like:

### `BoundaryBinding` splits

```ts
interface BoundaryBinding {
  /** Wire protocol (HTTP, TCP, AMQP, in-process, aws-https). */
  transport: string;

  /**
   * What the participants think they're doing. This determines how the
   * checker dispatches.
   */
  semantics:
    | { name: "rest"; method: string; path: string }
    | { name: "graphql"; operationName: string; operationType: "query" | "mutation" | "subscription" }
    | { name: "lambda-invoke"; functionName: string; qualifier?: string }
    | { name: "kafka-message"; topic: string }
    | { name: "queue-job"; queue: string; jobName: string }
    | { name: "function-call"; module: string; exportName: string }
    | { name: "react-render"; component: string };

  /** Pack-level recognition identity ("axios", "ts-rest", "apollo-client"). */
  recognition: string;
}
```

Tools that only care about transport stay happy; tools that care about
semantics (the checker) dispatch on the discriminated union.

### `BoundarySemantics` interface

```ts
interface BoundarySemantics<Binding extends BoundaryBinding> {
  /** How pairing keys are derived from this binding. */
  pairingKey(binding: Binding): string | null;

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

The checker's high-level flow (`checkPair`, `checkAll`) stays the same; each
check function (provider coverage, consumer satisfaction, body
compatibility, semantic bridging) is rewritten to call the semantics
interface instead of hardcoding REST operations.

Today's HTTP-specific helpers become the `"rest"` implementation. `GraphQL`
gets its own implementation where the discriminator is error-presence and
per-field nullability rather than a status code. `Lambda-invoke` gets its
own implementation where the discriminator is `FunctionError` vocabulary.

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

A real-world invocation often crosses more than one boundary. An HTTP
client hitting API Gateway → Lambda is *two* boundaries composed:

1. REST: client → API Gateway
2. Lambda-invoke: API Gateway → Lambda function

We partly handle this today via stubs — the API Gateway stub encodes the
Lambda integration → HTTP response mapping, so checking the HTTP client
against the API Gateway stub implicitly accounts for Lambda semantics.
Long-term, composition could become first-class: a transition's output
could reference another boundary it triggers, and checking becomes a
graph traversal. Tabled; stubs are adequate for now.

## What we're not doing today

The target shape above is a full refactor. Doing it now is premature: we
have one concrete semantics (REST), and architectures designed in the
abstract without a second concrete case to check against usually put the
seams in the wrong places — GraphQL's per-field errors, Lambda's
invocation failure modes, and gRPC's trailing metadata each surface
decisions you won't predict in the abstract.

The committed moves today:

1. **Namespace HTTP metadata under `metadata.http.*`** (already done).
2. **Pair by `(method, normalizedPath)` only for HTTP boundaries** (would
   be an early-follow move; today's pairing code hardcodes it, and
   non-HTTP summaries would be rejected by `pairSummaries` going into
   `noBinding`). Gate when we add a protocol where pairing shape differs.
3. **Keep `BoundaryBinding` as-is** until a second semantics lands.

## The forcing function

When a second semantics lands, it forces all the above. My recommendation
for which one to pick:

**Pick GraphQL first.** It's the cleanest forcing function because it
shares transport with REST but has completely different boundary
semantics. That surfaces the transport/semantics split without the
additional variable of a brand-new transport. All of the per-field
error / partial-data / operation-name-vs-method-path surprises come out
clean.

**Pick Lambda-invoke (or AWS SDK calls generally) second.** That's the
forcing function for "transport completely drops out of the abstraction"
— a Lambda invoke is behaviorally identical whether it's called from an
AWS SDK on a laptop or from API Gateway over a different HTTPS hop.
Getting this right fixes `BoundaryBinding`'s misleading coupling to HTTP
in a way REST → GraphQL alone wouldn't.

**Don't let either of these land before we have a concrete consumer.**
The worst outcome is a semantics registry with no consumer, locking us
into an abstraction that didn't need to survive first contact.

## Related decisions

See also:

- [`docs/status.md`](status.md) — decisions #18 (pack-aware checker via
  summary metadata), #22 (`BOUNDARY_ROLE`), #24 (pack-driven status
  accessors), #25 (this doc).
- [`docs/architecture.md`](architecture.md) — current package
  dependency shape and protocol assumptions.
- [`docs/framework-packs.md`](framework-packs.md) — how packs describe
  recognition today; extension points when semantics becomes a
  first-class axis.
- [`docs/stubs.md`](stubs.md) — boundary layering via the API Gateway
  stub is a precursor to first-class boundary composition.
