# Boundary interactions — unified IR design

Status: draft. Contract for the `clientCall` / `storageAccess` / `runtimeConfig` consolidation work.

Naming note: this doc was originally titled "service interactions" and the proposed Effect variant was `serviceInteraction`. Renamed to `interaction` because "service" implies external-API framing, and the same machinery should cover runtime/process boundaries (env vars, file system, time, entropy, signals, subprocess) that aren't usefully called "services."

## Problem

Today's IR models "code at line N talks to something across a boundary" three different ways depending on the protocol:

- **`clientCall` discovery** (fetch / axios / apollo-client). Synthesizes a separate `client`-kind summary per call site. Response branching becomes that summary's transitions. Pairs against HTTP server providers via `(method, normalizedPath)`.
- **`storageAccess` effect** (proposed Prisma path; primitives landed in commit `b2984a5`). One effect per call site, attached to the enclosing function's default-branch transition. Pairs against schema-derived provider summaries via `(storageSystem, scope, table)`.
- **`runtimeConfig` recognition** (`process.env.X` reads). Inferred at checker time by scanning the args of `invocation` effects for identifier shape `process.env.\w+`. Pairs against runtime-config provider summaries via the deployed-unit / env-var contract.

These three models exist for accidental reasons (one shipped per pass, each fitting its protocol). They fragment a generalisable concept — *boundary interaction* — into three IR shapes that the checker has to handle separately. New protocols (queues, caches, blob stores, gRPC) currently have to pick one of the three by analogy and inherit its baggage. Pack authors learn three different APIs to express what is fundamentally one concept.

The forcing function for unification is queue producers/consumers: they don't fit any of the three cleanly, so adding a fourth shape would compound the fragmentation. Better to design the unified shape against three concrete patterns now and migrate everything onto it.

## What "unification" means here

Two interpretations that aren't the same thing:

- **Mechanism unification**: one extension point on `PatternPack` (`invocationRecognizers`, just landed); one pairing dispatcher in the checker (match by `boundaryBinding`); per-class finding generators downstream. The plumbing converges. Pack authors learn ONE primitive.
- **Type unification**: one Effect variant covering every boundary kind, discriminated at runtime via a class field. The IR has one shape; type checking via discriminated union narrows it.

This design proposes BOTH. One Effect variant (`interaction`), discriminated by `interaction.class` (`storage-access`, `service-call`, `message-send`, `config-read`, ...), emitted via the `invocationRecognizers` primitive, paired by one generic dispatcher with per-class finding generators.

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

### A new effect type: `interaction`, discriminated by `interaction.class`

```typescript
type InteractionEffect = {
  type: "interaction";
  binding: BoundaryBinding;          // identity — which boundary
  callee?: string;                    // source-text for inspect rendering
  groupId?: string;                   // correlation id when one call site emits
                                      // multiple effects (Prisma joins, SQL multi-table)
  interaction:                        // discriminated by .class
    | { class: "storage-access";  kind: "read" | "write"; fields: string[]; selector?: string[]; operation?: string; }
    | { class: "service-call";        method: string; payload?: EffectArg; responseShape?: TypeShape; }
    | { class: "message-send";    body?: EffectArg; routingKey?: string; }
    | { class: "config-read";     name: string; defaulted: boolean; };
};
```

**Why discriminated and not a flat optional-fields type.** A flat shape with optional `payload?`/`selector?`/`fields?`/`headers?` covering every protocol either loses precision (everything is a generic `payload`) or accumulates protocol-specific fields on a generic type. Discriminated keeps each class's fields precise and lets the type checker carry its weight.

**Why one Effect variant and not N (storage-access + service-call + ...).** Because the unification is real: the pairing dispatcher walks one effect type, matches by binding, then dispatches to per-class finding generators by `interaction.class`. Pack authors learn one extension point. Adding a class is a strictly additive IR change.

**Why discriminated by `interaction.class` and not by `binding.semantics.name`.** Both encode protocol semantics, but they answer different questions:
- `binding.semantics.name` answers "which boundary identity scheme does this use?" — used for pairing (matching consumers against providers).
- `interaction.class` answers "which kind of operation shape does this call have?" — used for finding-generator dispatch and for narrowing the effect's typed fields.

These line up most of the time but aren't always 1:1 (a single semantics could host multiple operation shapes). Discriminating in the effect itself keeps narrowing local to the effect; reading `binding.semantics.name` for type narrowing would mean every reader carries the binding-semantics taxonomy in its head.

### Class taxonomy (v0)

| Class | Examples | Structural fields |
|---|---|---|
| `storage-access` | Prisma, Drizzle, raw SQL | `kind` (R/W), `fields`, `selector`, `operation` |
| `service-call` | fetch, axios, Apollo Client, gRPC unary | `method`, `payload`, `responseShape` |
| `message-send` | SQS producer, BullMQ.add, Kafka producer | `body`, `routingKey` |
| `config-read` | `process.env.X`, dotenv lookups | `name`, `defaulted` |

Future classes that are strictly additive: `time-read` (clock), `random-read` (entropy — security-relevant), `signal-receive`, `process-spawn`, `file-access`, `cache-set`, `blob-write`, `stream-consume`, `metrics-emit`. Each is a structurally distinct kind of "code interacting with something outside its function-pure scope."

### Sub-summary synthesis on rich-response classes

When an `interaction` effect's class has rich response semantics (`service-call` today; future GraphQL streams, gRPC streams), the adapter synthesises a `caller`-kind sub-summary at the call site. Transitions on the sub-summary capture the response-shape branching (`if (res.ok) { ... }`). The sub-summary's `boundaryBinding` matches the effect's. Both pair against the same provider.

For other classes (`storage-access`, `message-send`, `config-read`), no sub-summary spawns. The structural fact alone is the artifact.

(The "always or never spawn per class" rule is the v0 simplification — see open question #2 below.)

### Inbound interactions stay binding-only

Inbound interactions (HTTP server handlers, queue consumers) keep today's representation: `boundaryBinding` on the discovered unit's identity. **No synthesized inbound effect.** The binding on identity carries the contract; adding a redundant effect wouldn't pay for itself.

The asymmetry is crisp: **effect = outbound interaction; binding-on-identity = inbound interaction.**

The contract-source path picks up the slack for protocols where the inbound binding lives in infra: queue consumers gain a contract-source extension that parses CFN `Events: { Type: SQS }` declarations and attaches queue `boundaryBinding` to the matching Lambda handler summary. Those pair against the producer-side `interaction(class: "message-send")` effects.

### Pairing under the unified model

Pairing collapses to one rule: an `interaction` effect (or a sub-summary it spawns) pairs against any provider summary whose `boundaryBinding` matches by `(transport, semantics.name, semantics-specific identity)`. The semantics-specific identity is whatever the existing `BoundaryBinding` machinery already encodes — `(method, path)` for HTTP, `(system, scope, table)` for storage, `(queue)` for SQS, etc.

The current per-pass pairing functions (`checkConsumerSatisfaction`, `checkRelationalStorage`, `checkRuntimeConfig`) become one generic pass that walks providers, finds matching consumers (effects + sub-summaries), and dispatches to per-class finding generators by `interaction.class`. The per-class finding generators stay (column-level checks aren't HTTP-shaped checks); the dispatch unifies.

### How each pattern lowers to the unified shape

#### A (fetch)
- Recognizer emits `interaction { binding: restClientBinding(...), interaction: { class: "service-call", method, payload, responseShape } }`.
- Adapter synthesises a `caller` sub-summary; transitions capture `if (res.ok) { ... }` branching.
- Existing OpenAPI / CFN-API-Gateway providers pair against the sub-summary the same way they pair against today's `client` summaries.

#### B (Prisma)
- Recognizer emits `interaction { binding: storageRelationalBinding(...), interaction: { class: "storage-access", kind, fields, selector, operation } }`.
- Multi-table joins → multiple effects sharing a `groupId`.
- No sub-summary.
- Existing schema-reader providers pair via `(system, scope, table)`. The `storage-access` finding generator emits `storageReadFieldUnknown` etc.

#### C (SQS producer)
- Recognizer emits `interaction { binding: queueBinding(...), interaction: { class: "message-send", body, routingKey? } }`.
- Resolving the queue identity from `QueueUrl: process.env.ORDERS_QUEUE_URL` reuses the env-var → CFN-resource resolution we already do for runtime-config.
- Pairs against CFN `AWS::SQS::Queue` provider summaries.

#### D (SQS consumer)
- The contract-source pass for CFN event-source mappings emits a `boundaryBinding` enrichment: when a Lambda has `Events: SQS`, attach a queue `boundaryBinding` to the handler summary. The consumer-side handler then pairs against the producer-side `message-send` effect via shared queue identity.

## What changes vs. what stays

**Changes:**

- `clientCall` discovery → recognizer that emits `interaction(class: "service-call")` + spawns a `caller` sub-summary. The user-facing pack API stays similar (still `clientCall` match shape), but internally it produces effects.
- `storageAccess` effect → folds into `interaction(class: "storage-access")`. Removed from the IR in the same change that adds `interaction`.
- `runtimeConfig` recognition → moves from checker arg scanning to a recognizer that emits `interaction(class: "config-read")`. Same provider summaries on the other side.
- Per-pass pairing functions consolidate into one generic dispatcher with per-class finding generators.

**Stays:**

- `BoundaryBinding` machinery: protocol-specific identity already lives here. No changes.
- `Effect` IR base type: `interaction` is a new variant alongside `mutation`, `invocation`, `emission`, `stateChange`. (`storageAccess` is removed in the same change that adds `interaction` — no transitional coexistence; suss is alpha.)
- Provider summaries: contract sources (OpenAPI, CFN, schema readers) still emit the same shapes. Only the consumer-side IR changes.
- `invocationRecognizers` primitive (commit `d4e4e16`): the extension point for emitting `interaction` effects.

## Migration plan

Build order is **SQS first** (greenfield validation of the draft IR), then IR lock-in, then the in-place migrations. Rationale: SQS is the only pattern with no existing implementation to anchor against. Building it first against a draft IR shape surfaces class-boundary and sub-summary-spawning problems before #169 commits the IR. Existing patterns (clientCall, storageAccess, runtimeConfig) anchor the migration after the IR is locked.

1. **Land this design doc** (this commit).
2. **Build SQS producer + consumer recognizer (#170)** against a draft `interaction` shape declared locally in the package. Pack: `@suss/framework-sqs`. Contract source: extension to `@suss/contract-cloudformation` for `Events: SQS`. Fixture: SAM template + producer + consumer; checker pairs via shared queue identity. Surfaces class-boundary edge cases.
3. **Add `interaction` Effect variant to IR; remove `storageAccess` (#169).** Lock in the shape SQS validated. Update the in-tree `prismaIntegration.test.ts` (commit `6eb9d9b`) to the new shape. Migrate the SQS recognizer from local-draft IR to the canonical IR (likely small).
4. **Build Prisma recognizer on the unified shape (#171).** AST-based, ts-morph type resolution, emits `interaction(class: "storage-access")`.
5. **Migrate `clientCall` discovery (#172).** Existing fetch / axios / apollo-client packs migrate to the recognizer + sub-summary path. Big change — touches the entire HTTP/GraphQL story.
6. **Migrate `runtimeConfig` recognition (#173)** from checker arg scanning to a recognizer.
7. **Consolidate pairing passes (#174)** when all consumer-side production goes through `interaction`.

## Preliminary decisions, to be confirmed by SQS implementation

These were drafted as "resolved" but the user pushback was right — they're under-specified given we haven't built any of the new patterns yet. Marked preliminary; revisit during #170 (SQS) and confirm or revise before #169 (IR lock-in).

### P1 — Fan-out: one effect per touched table

A Prisma call with nested `select` reads multiple tables. The recognizer emits **one `interaction` effect per touched table**, with a shared `groupId` correlating them. Pairing logic stays per-effect (the per-table boundary is what we're checking). The `groupId` preserves "these came from one query" for future passes (N+1 detection, performance attribution) without complicating the pairing dispatcher today.

To confirm during SQS work: does any SQS pattern produce fan-out? (Probably not — one `sqs.send` writes to one queue.) If not, the only test is Prisma; defer concrete validation until #171.

### P2 — Sub-summary spawning rule

v0 rule: `service-call` class spawns a `caller` sub-summary; other classes don't. Per-class invariant, not per-call AST.

To confirm during SQS work: does any SQS pattern want a sub-summary? Probably not — `sqs.send` is fire-and-forget; the producer doesn't branch on the response. So the rule "service-call spawns; nothing else does" stays adequate. But this is exactly the kind of thing that breaks once we hit something like a callback-shaped queue API where the consumer registers a handler and the producer awaits a response — at that point, "rich response semantics" becomes a per-call decision, not a per-class one. The recognizer probably needs a `spawnSubSummary?: boolean` field per emission to handle that future case. Defer until we hit it.

### P3 — Inbound interactions: binding-only

Effect = outbound; binding-on-identity = inbound. No synthesized inbound `interaction` effect.

To confirm during SQS work: SQS consumer Lambdas are inbound. They get a queue `boundaryBinding` attached via the contract-source pass. They pair against the producer's `message-send` effect. Does this work end-to-end without an inbound effect? If yes, P3 stands. If the pairing dispatcher gets ugly because consumers and producers have different IR shapes, revisit.

### P4 — No deprecation cycle for `storageAccess`

When #169 lands, `storageAccess` is removed in the same change. The in-tree `prismaIntegration.test.ts` updates in the same commit. Rationale: alpha software, no external users with summaries on disk.

This one is firm — no SQS-driven reason to revisit.

## Non-goals for the first cut

- Cross-service tracing (which producer feeds which consumer across services). That's a product-side concern per `project_oss_vs_product_scope.md`.
- Schema-aware payload validation (e.g., SQS message body shape against a JSON schema). Future phase; the IR just carries the payload shape.
- Streaming protocols (gRPC streams, WebSockets). The unified model accommodates them, but the recognizers for them are out of scope here.
