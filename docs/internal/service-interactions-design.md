# Service interactions — unified IR design

Status: draft. Predecessor of the `clientCall` / `storageAccess` / `runtimeConfig` consolidation work.

## Problem

Today's IR models "code at line N talks to external service S" three different ways depending on the protocol:

- **`clientCall` discovery** (fetch / axios / apollo-client). Synthesizes a separate `client`-kind summary per call site. Response branching becomes that summary's transitions. Pairs against HTTP server providers via `(method, normalizedPath)`.
- **`storageAccess` effect** (proposed Prisma path; primitives landed in commit `b2984a5`). One effect per call site, attached to the enclosing function's default-branch transition. Pairs against schema-derived provider summaries via `(storageSystem, scope, table)`.
- **`runtimeConfig` recognition** (`process.env.X` reads). Inferred at checker time by scanning the args of `invocation` effects for identifier shape `process.env.\w+`. Pairs against runtime-config provider summaries via the deployed-unit / env-var contract.

These three models exist for accidental reasons (one shipped per pass, each fitting its protocol). They fragment a generalisable concept — *service interaction* — into three IR shapes that the checker has to handle separately. New protocols (queues, caches, blob stores, gRPC) currently have to pick one of the three by analogy and inherit its baggage.

The forcing function for unification is queue producers/consumers: they don't fit any of the three cleanly, so adding a fourth shape would compound the fragmentation. Better to design the unified shape against three concrete patterns now and migrate everything onto it.

## Three concrete patterns to design against

### Pattern A — HTTP outbound (`fetch`-style)

```typescript
async function getUser(id: string) {
  const res = await fetch(`/users/${id}`);
  if (res.ok) {
    return await res.json();
  } else if (res.status === 404) {
    return null;
  }
  throw new Error("upstream error");
}
```

- Direction: outbound (we initiate).
- Sync, with **rich response branching**: code forks on `res.ok`, `res.status`, body shape. The response handling IS the function's behaviour at this boundary.
- Today: discovery synthesises one `client` summary per fetch call site; response branching becomes that summary's transitions; the enclosing `getUser` summary doesn't reflect the fetch call at all.

### Pattern B — Database outbound (Prisma-style)

```typescript
async function getUser(id: string) {
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true },
  });
  if (user === null) {
    throw new NotFoundError();
  }
  return user;
}
```

- Direction: outbound (we initiate).
- Sync, with **throw-or-return** semantics: errors raise; the only branching is on the typed return value (often null/not-null). No status codes, no header inspection.
- Today: nothing structural — the Prisma call is captured as a generic `invocation` effect with the callee text. The DB columns the call touches are not extracted.

### Pattern C — Queue producer (SQS-style)

```typescript
async function enqueueOrder(order: Order) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.ORDERS_QUEUE_URL,
    MessageBody: JSON.stringify(order),
  }));
}
```

- Direction: outbound (we send).
- **Fire-and-forget**: the response is just an ack (`MessageId`); the caller almost never branches on it. The semantic boundary is "this queue receives orders shaped like X."
- Today: same as Prisma — generic `invocation`, no structural attribution. The queue identity (URL → CFN logical resource → declared queue name) is invisible.

### Pattern D — Queue consumer (SQS-via-Lambda-style)

```yaml
# CFN
OrdersHandler:
  Type: AWS::Serverless::Function
  Events:
    OrderEvents:
      Type: SQS
      Properties:
        Queue: !GetAtt OrdersQueue.Arn
```

```typescript
export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    await processOrder(order);
  }
}
```

- Direction: **inbound** (they invoke us).
- Async, **event-driven**: the function IS the handler. Errors thrown surface as DLQ routing; success is implicit.
- Today: discovered as a generic Lambda handler (via a `namedExport` pack in dogfood); the queue binding from the CFN event source is invisible. No checker pairing fires.

### Patterns we already have under control (for reference)

- **HTTP inbound** (Express/Fastify handlers). Discovered via framework packs as `handler`-kind summaries. Response branching is the function's transitions. Pairs against contract-source provider summaries.
- **Runtime config reads** (`process.env.X`). Recognised at checker time. Pairs against runtime-config providers.

## Dimensions that vary

Across the patterns:

| Dimension | A (fetch) | B (Prisma) | C (SQS prod) | D (SQS cons) |
|---|---|---|---|---|
| Direction | outbound | outbound | outbound | inbound |
| Sync / async | sync | sync | sync (ack only) | async (event) |
| Response branching | rich | throw-or-return | fire-and-forget | n/a (we ARE the handler) |
| Function unit | call site | enclosing function | enclosing function | the handler itself |
| Boundary identity | (method, path) | (system, scope, table) | (queue) | (queue) |
| Payload shape | request body / query | columns | message body | message envelope |
| Where the contract lives | server | schema | producer & consumer share | producer & consumer share |

Two of these dimensions matter most for IR design:

1. **Direction.** Outbound = we record an interaction; inbound = the function IS the interaction. These map to "effect on the function" vs "the function's identity carries the binding" — a difference that exists today (`storageAccess` effect vs `boundaryBinding` on a discovered handler).

2. **Response branching richness.** Rich branching → the call site gets a sub-summary whose transitions capture the branches. Throw-or-return / fire-and-forget → no sub-summary needed; the structural fact alone is the artifact.

The other dimensions (sync/async, payload shape, boundary identity) are protocol-specific details that reduce to the existing `BoundaryBinding` machinery and `EffectArg` / `TypeShape` payload shapes.

## Proposed unified IR

### A new effect type: `serviceInteraction`

```typescript
type ServiceInteractionEffect = {
  type: "serviceInteraction";
  direction: "outbound";       // inbound is modeled via boundaryBinding on the discovered unit, not as an effect
  binding: BoundaryBinding;    // protocol-specific identity (existing machinery)
  operation?: string;          // e.g. "GET", "findUnique", "send"
  payload?: EffectArg;         // structured payload (request body / data / message)
  selector?: EffectArg;        // identity narrowing (where, query string, partition key)
  responseShape?: TypeShape;   // what we expect back (sync only)
  callee?: string;             // source-text for inspect rendering
  // ...future fields per protocol
};
```

This **subsumes** today's `storageAccess` effect (just with `binding.semantics.name === "storage-relational"`) and would **also** carry the structural facts that today's `clientCall` discovery throws away (the enclosing function's record that it called fetch).

### Sub-summary synthesis on rich branching

When a `serviceInteraction` effect has `responseBranching === "rich"`, the adapter additionally synthesises a `caller`-kind sub-summary whose transitions capture the response-shape branching at the call site. The sub-summary's `boundaryBinding` matches the effect's `binding`. The enclosing function gets the effect; the sub-summary captures the branches; both pair against the provider via the same binding.

This means today's `clientCall` flow becomes:

1. Recognizer emits a `serviceInteraction` effect on the enclosing function.
2. If the recognizer reports `responseBranching: "rich"`, the adapter synthesises a `caller` sub-summary at the call site (the existing `client` kind, renamed).
3. Both pair against HTTP server providers via the `binding`.

### Inbound interactions stay summary-shaped

Inbound interactions (HTTP server handlers, queue consumers) are already modeled by discovery + `boundaryBinding` on the discovered unit. The unified design doesn't change them — it just notes that they're the inbound mirror of `serviceInteraction(direction: outbound)` and use the same `BoundaryBinding` machinery on identity.

The one thing that DOES change: queue consumers gain a contract-source path. CFN `Events: { Type: SQS }` declarations get parsed by a contract source (`@suss/contract-cloudformation` extension or new) into `handler`-kind summaries with queue `boundaryBinding`. Those pair against the producer-side `serviceInteraction` effects via shared queue identity.

### Pairing under the unified model

Pairing collapses to one rule: a `serviceInteraction` effect (or a sub-summary it spawns) pairs against any provider summary whose `boundaryBinding` matches by `(transport, semantics.name, semantics-specific identity)`. The semantics-specific identity is whatever the existing `boundaryBinding` machinery already encodes — `(method, path)` for HTTP, `(system, scope, table)` for storage, `(queue)` for SQS, etc.

The current per-pass pairing functions (`checkConsumerSatisfaction`, `checkRelationalStorage`, `checkRuntimeConfig`) become one generic pass that walks providers, finds matching consumers (effects + sub-summaries), and dispatches to per-semantics finding generators. The semantics-specific finding generators stay (column-level checks aren't HTTP-shaped checks); the dispatch is unified.

### How each pattern lowers to the unified shape

#### A (fetch)
- Recognizer (replacement for today's `clientCall` discovery) emits a `serviceInteraction` effect: `binding = { transport: "http", semantics: { name: "rest", method, path } }`, `responseBranching: "rich"`.
- Adapter synthesises a `caller` sub-summary; transitions capture `if (res.ok) { ... }` branching.
- Existing OpenAPI / CFN-API-Gateway providers pair against the sub-summary the same way they pair against today's `client` summaries.

#### B (Prisma)
- Recognizer emits a `serviceInteraction` effect: `binding = storageRelationalBinding(...)`, `responseBranching: "throw-or-return"`, `payload = <data/select/where shape>`.
- No sub-summary (no rich branching).
- Existing schema-reader providers pair via `(system, scope, table)`. The semantics-specific finding generator (`storageReadFieldUnknown` etc.) reads `payload`/`selector` from the effect.

#### C (SQS producer)
- Recognizer emits a `serviceInteraction` effect: `binding = { transport: "sqs", semantics: { name: "queue", queue: <resolved queue identity> } }`, `responseBranching: "fire-and-forget"`, `payload = <message body shape>`.
- Resolving `<queue identity>` from `QueueUrl: process.env.ORDERS_QUEUE_URL` requires the env-var → CFN-resource resolution we already do for runtime-config. Hand off to the existing chain-collapse logic.
- Pairs against CFN `AWS::SQS::Queue` provider summaries.

#### D (SQS consumer)
- Today: discovered as a generic Lambda handler. Under the unified design, the contract-source pass for CFN event-source mappings emits an additional `boundaryBinding` enrichment: when a Lambda has `Events: SQS`, attach a queue `boundaryBinding` to the handler summary. Then the consumer-side handler pairs against the producer-side effect.

## What changes vs. what stays

**Changes:**

- `clientCall` discovery → recognizer that emits `serviceInteraction(direction: outbound, responseBranching: "rich")` + spawns a `caller` sub-summary. The user-facing pack API stays similar (still `clientCall` match shape), but internally it produces effects, not summaries.
- `storageAccess` effect → renamed to `serviceInteraction` with `binding.semantics.name === "storage-relational"`. The existing IR field becomes a special case of the general field.
- `runtimeConfig` recognition → moves from checker-time arg scanning to a recognizer that emits `serviceInteraction(direction: outbound, semantics.name: "runtime-config")`. Same provider summaries on the other side.
- Per-pass pairing functions consolidate into one generic dispatcher with per-semantics finding generators.

**Stays:**

- `BoundaryBinding` machinery: protocol-specific identity already lives here. No changes.
- `Effect` IR base type: `serviceInteraction` is just a new variant alongside `mutation`, `invocation`, `emission`, `stateChange`, `storageAccess`. The new variant supersedes `storageAccess` for new code; old summaries keep working until they're regenerated.
- Provider summaries: contract sources (OpenAPI, CFN, schema readers) still emit the same shapes. Only the consumer-side IR changes.
- `invocationRecognizers` primitive (just landed): the right extension point for emitting `serviceInteraction` effects.

## Migration plan

1. **Land this design doc** as the contract for what's coming.
2. **Add `serviceInteraction` to the IR** (alongside `storageAccess` — both coexist during migration).
3. **Build the SQS producer + consumer recognizer** as the first new-shape consumer (no migration of existing code, just new code on the new shape).
4. **Build the Prisma recognizer** also on the new shape (no transition through `storageAccess`).
5. **Migrate `clientCall` discovery** to emit `serviceInteraction` effects + spawn `caller` sub-summaries. Keep summaries renderable identically by inspect.
6. **Migrate `runtimeConfig` recognition** from checker arg scanning to a recognizer.
7. **Consolidate pairing passes.** When all consumer-side production goes through `serviceInteraction`, the per-pass dispatchers fold into one.
8. **Deprecate `storageAccess`** as a separate effect variant. Remove after a release cycle.

## Open questions

1. **Fan-out effects from one call.** A Prisma call with nested `select` reads multiple tables: `db.user.findUnique({ select: { email: true, orders: { select: { total: true } } } })` reads User AND Order. Under the unified model, does the recognizer emit two `serviceInteraction` effects (one per table) or one with a structured payload that includes the join? My read: two effects, since the pairing logic is per-table. Same answer for SQL joins via Drizzle.

2. **Effects that DO carry rich branching but live mid-function.** Imagine a call inside a try/catch that distinguishes 404 from 500: `try { await fetch(...) } catch (e) { ... }`. Is that "rich branching" deserving a sub-summary? Probably yes if the catch block has multiple paths; probably no if it just rethrows. The recognizer's `responseBranching` field would let the recognizer decide based on the AST around the call.

3. **Inbound interactions: effect vs. binding-only.** Today, an Express handler has `boundaryBinding` (route info) but no effect representation. Under the unified design, should the handler also CARRY a synthesized `serviceInteraction(direction: inbound)` effect on its own transitions for symmetry? My read: no — the binding on identity is enough; adding a redundant effect wouldn't pay for itself. But this is worth revisiting if it makes downstream tooling (inspect, diff) cleaner.

4. **Backward compatibility for `storageAccess` summaries.** Phase 6.1 shipped `storageAccess` effects in the IR. Existing summaries on disk would have those. The migration plan keeps both variants coexisting; the checker handles both during the transition. After the deprecation cycle, an IR migration tool rewrites old summaries.

## Non-goals for the first cut

- Cross-service tracing (which producer feeds which consumer across services). That's a product-side concern per `project_oss_vs_product_scope.md`.
- Schema-aware payload validation (e.g., SQS message body shape against a JSON schema). Future phase; the IR just carries the payload shape.
- Streaming protocols (gRPC streams, WebSockets). The unified model accommodates them, but the recognizers for them are out of scope here.
