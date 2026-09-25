# @suss/framework-cloudflare-workers

This pack records what a Cloudflare Worker serves, by reading the object its entrypoint exports.

## What this package is

A pattern pack. A Worker registers nothing, so there is no `app.get(...)` to match on. The object it exports is the whole declaration:

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

Each property Cloudflare calls becomes one unit. When a property's value is a function written somewhere else, the pack follows it to that function, so a service that keeps its handler in its own file is still read. The older `addEventListener("fetch", handler)` form registers the same triggers and comes out as the same units.

## One boundary for the whole Worker

A Worker usually routes inside `fetch`, on `new URL(request.url).pathname`, with an `if` chain or a switch. Nothing in the code declares those paths as routes, and the route the Worker is bound to (`example.com/*`) is set in `wrangler.toml` or in the deployment's Terraform.

So the `fetch` unit serves every method, at a path it does not state. Its binding is a REST binding with a null path, which does not pair with anything. suss reports the Worker as an HTTP boundary and does not invent routes for it, because an invented route would pair with a caller and be wrong.

A Worker that mounts a router library gets its routes from that library's pack instead. Run this pack alongside `@suss/framework-hono`, and each pack claims what it recognizes.

## The other three triggers

`scheduled`, `queue` and `tail` are each their own boundary, on their own wire, so none of them claims to serve HTTP:

| Trigger | Boundary |
| --- | --- |
| `fetch` | REST, every method, no path |
| `scheduled` | message-bus consumer on `cloudflare-cron` |
| `queue` | message-bus consumer on `cloudflare-queues` |
| `tail` | message-bus consumer on `cloudflare-tail` |

The channel is null on all three, because the code never says which queue feeds the Worker or what the cron expression is. `wrangler.toml` declares both, and `@suss/contract-wrangler` reads it.

Cron and tail are wires with no producer, the same as an EventBridge schedule, so suss does not report them as consumers waiting on a message nobody sends.

## Bindings

A Worker has no `process.env`. Its secrets, vars and resource handles arrive as the second argument to every trigger:

```ts
async fetch(request: Request, env: Env) {
  const table = env.EDITION_TABLE;
}
```

A read from that argument becomes a `config-read` interaction, the same one `@suss/runtime-node` records for `process.env.X`, so the runtime-config check pairs it with whatever declares the variable. The pack finds the argument by resolving the identifier back to its declaration and checking whether that parameter belongs to a trigger. So a project that calls it something other than `env` is read the same way.

## Store calls on a binding

A call through a binding becomes a `storage-access` interaction as well:

```ts
async fetch(request: Request, env: Env) {
  await env.SESSIONS.put(`session:${id}`, "started");   // cloudflare-kv
  const report = await env.ARCHIVE.get("latest.csv");    // r2
  await env.LEDGER.prepare("SELECT total FROM entries"); // d1
}
```

The container is the binding name, which is also the identity `wrangler.toml` declares for the same store, so the storage check pairs the two sides by name. The pack tells which store a binding is from the type on its `Env` declaration: `KVNamespace`, `R2Bucket` or `D1Database`. Cloudflare defines those type names and a project writes them on its own `Env` interface, so the pack can read the type reference whether or not `@cloudflare/workers-types` is installed. It also reads one through an alias, an intersection, or a union such as `KVNamespace | undefined`. A `get` call alone does not show which store it reaches. So a Worker with no such type on the binding, including any JavaScript Worker, gets config reads and no storage accesses.

For KV and R2, the key an operation addresses is recorded as the selector. A D1 call is classified by its SQL: `SELECT` is a read and anything else is a write. If the SQL reader cannot parse the statement, the pack records nothing instead of guessing a kind.

## Out of scope for now

- **A read one hop away from the trigger.** Most services pass `env` to a service class and read the bindings there. Only reads in the trigger's own body, or in a function the entrypoint exports as a trigger, come out as config reads.
- **`env["SOME_VAR"]`.** Access recognizers only see property accesses, so the bracket form is not read.
- **Durable Object classes.** A `DurableObject` subclass is its own deployable with its own methods, and it is not part of the entrypoint object.
- **The status a Worker sends through a helper of its own.** `new Response(...)` and the two static helpers are read where they are written. A project's own `jsonResponse()` comes out as an unread return.

## Where it fits in suss

The pack depends on `@suss/extractor` for the pack type, `@suss/behavioral-ir` for the bindings it writes, `@suss/adapter-typescript` for reading names, and `@suss/sql` for classifying a D1 statement. `@suss/contract-wrangler` declares the other side: the variables the Worker is given, the queues it produces to and consumes from, and the stores it is bound to.
