# @suss/framework-cloudflare-workers

Says what a Cloudflare Worker serves, from the shape of its entrypoint.

## What this package is

A pattern pack. A Worker registers nothing, so there is no `app.get(...)` to match on. What it exports is the whole declaration:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) { ... },
  async scheduled(controller: ScheduledController, env: Env) { ... },
  async queue(batch: MessageBatch, env: Env) { ... },
};
```

```ts
import { cloudflareWorkersFramework } from "@suss/framework-cloudflare-workers";

const pack = cloudflareWorkersFramework();
```

Each property Cloudflare invokes becomes one unit. A property whose value is a function written elsewhere is followed to that function, so a service that keeps its handler in its own file still gets read. The older `addEventListener("fetch", handler)` form registers the same triggers and comes out as the same units.

## One boundary for the Worker, not one per path

A Worker usually routes inside `fetch`, on `new URL(request.url).pathname`, with an `if` chain or a switch. Nothing in the code declares those paths as routes, and the route the Worker is bound to (`example.com/*`) lives in `wrangler.toml` or in the deployment's Terraform.

So the `fetch` unit says it serves every method at a path it does not state. Its binding is a REST binding with a null path, which pairs with nothing. suss reports the Worker as an HTTP boundary and invents no routes for it, because a route it invented would pair with a caller and be wrong.

A Worker that mounts a router library gets its routes from that library's pack instead. Run this pack alongside `@suss/framework-hono` and each claims what it recognizes.

## The other three triggers

`scheduled`, `queue` and `tail` are each their own boundary, on their own wire, so none of them claims to serve HTTP:

| Trigger | Boundary |
| --- | --- |
| `fetch` | REST, every method, no path |
| `scheduled` | message-bus consumer on `cloudflare-cron` |
| `queue` | message-bus consumer on `cloudflare-queues` |
| `tail` | message-bus consumer on `cloudflare-tail` |

The channel is null on all three, because the code never says which queue feeds it or what the cron expression is. `wrangler.toml` says both, and `@suss/contract-wrangler` reads it.

Cron and tail are wires with no producer, the same way an EventBridge schedule is, so nothing reports them as consumers waiting on a message nobody sends.

## Bindings

A Worker gets no `process.env`. Its secrets, vars and resource handles arrive as the second argument to every trigger:

```ts
async fetch(request: Request, env: Env) {
  const table = env.EDITION_TABLE;
}
```

A read off that argument becomes a `config-read` interaction, the same one `@suss/runtime-node` records for `process.env.X`, so the runtime-config check pairs it against whatever declares the variable. The argument is found by resolving the identifier back to its declaration and asking whether that parameter belongs to a trigger, so a project that calls it something other than `env` is read the same way.

## Store calls on a binding

A call through a binding becomes a `storage-access` interaction as well:

```ts
async fetch(request: Request, env: Env) {
  await env.SESSIONS.put(`session:${id}`, "started");   // cloudflare-kv
  const report = await env.ARCHIVE.get("latest.csv");    // r2
  await env.LEDGER.prepare("SELECT total FROM entries"); // d1
}
```

The container is the binding name, which is the identity `wrangler.toml` declares for the same store, so the storage check pairs the two sides name-to-name. Which store a binding is comes from the type its `Env` declaration states: `KVNamespace`, `R2Bucket` or `D1Database`. Cloudflare defines those names, a project spells them on its own `Env` interface, and the type reference is readable whether or not `@cloudflare/workers-types` is installed. `get` alone does not say which store it reaches, so a Worker with no such type on the binding, a JavaScript Worker included, gets config reads and no storage accesses.

KV and R2 record the key an operation addresses as the selector. A D1 call is judged by its SQL: `SELECT` is a read, anything else a write, and a statement the SQL reader cannot parse records nothing rather than a guessed kind.

## Out of scope for now

- **A read one hop away from the trigger.** Most services hand `env` to a service class and read the bindings there. Only reads in the trigger's own body, or in a function the entrypoint exports as a trigger, come out as config reads.
- **`env["SOME_VAR"]`.** Access recognizers see property accesses, so the bracket form is not read.
- **Durable Object classes.** A `DurableObject` subclass is its own deployable with its own methods, and it is not part of the entrypoint object.
- **The status a Worker sends through a helper of its own.** `new Response(...)` and the two static helpers are read where they are written; a project's own `jsonResponse()` comes out as an unread return.

## Where it fits in suss

Depends on `@suss/extractor` for the pack shape, `@suss/behavioral-ir` for the bindings it writes, `@suss/adapter-typescript` for name reading, and `@suss/sql` for judging a D1 statement. `@suss/contract-wrangler` declares the other side: the variables the Worker is given, the queues it produces to and consumes from, and the stores it is bound to.
