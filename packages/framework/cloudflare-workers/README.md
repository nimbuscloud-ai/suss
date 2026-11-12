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

Each property Cloudflare calls becomes one unit. When a property's value is a function written somewhere else, the pack follows it to that function, so a service that keeps its handler in its own file is still read. The older `addEventListener("fetch", handler)` form registers the same triggers and comes out as the same units. The pack reads a registration the module body makes, outside every function, and reads an event name kept in a const. A file that registers one trigger both ways, on two functions, gets a unit for each.

Both forms are declared patterns: a [`namedExport`](../../../docs/packs/patterns.md#namedexport) with `names: ["default"]` and the four triggers as its `members`, and a [`registeredFunction`](../../../docs/packs/patterns.md#registeredfunction) on the global `addEventListener`. Neither states an import, since a Worker imports nothing to be one, so the pack reads every file.

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

A read from that argument becomes a `config-read` interaction, the same one `@suss/runtime-node` records for `process.env.X`, so the runtime-config check pairs it with whatever declares the variable. A read with a fallback, such as `env.TIMEOUT_MS ?? "500"`, records the fallback as its default when it settles to one value. Each trigger's unit says that its second parameter is the bindings, with `handedIn`, and the adapter records that on the parameter when it claims the unit. The pack's read chain is off `handedIn("env")`, so a project that calls the parameter something other than `env` is read the same way, and so is a trigger written in another file and imported into the entrypoint. The rules follow the parameter into a local set to it and into a helper the trigger passes it to, however many calls deep, so `readOrigin(env)` records the reads the helper makes. Every read is spelled `env.<name>`, whatever the parameter is called.

## Store calls on a binding

A call through a binding becomes a `storage-access` interaction as well:

```ts
async fetch(request: Request, env: Env) {
  await env.SESSIONS.put(`session:${id}`, "started");   // cloudflare-kv
  const report = await env.ARCHIVE.get("latest.csv");    // r2
  await env.LEDGER.prepare("SELECT total FROM entries"); // d1
}
```

The container is the binding name, which is also the identity `wrangler.toml` declares for the same store, so the storage check pairs the two sides by name. A call is read wherever the env reads are, so a store call in a helper the trigger passes `env` to, or on a local set to `env` or to one binding, is recorded too. The pack tells which store a binding is from the type on its `Env` declaration: `KVNamespace`, `R2Bucket` or `D1Database`. Cloudflare defines those type names and a project writes them on its own `Env` interface, so the pack can read the type reference whether or not `@cloudflare/workers-types` is installed. It also reads one through an alias, an intersection, or a union such as `KVNamespace | undefined`. A binding typed as two stores, `KVNamespace | R2Bucket`, gets an access on each, since the code can reach either. A `get` call alone does not show which store it reaches. So a Worker with no such type on the binding, including any JavaScript Worker, gets config reads and no storage accesses.

For KV and R2, the key an operation addresses is recorded as the selector. A D1 call is classified by its SQL: `SELECT` is a read and anything else is a write. If the SQL reader cannot parse the statement, the pack records nothing instead of guessing a kind.

## Out of scope for now

- **Bindings kept on an object.** A service class that stores `env` in a field and reads `this.env.X` in its methods is not followed into the field, so those reads do not come out as config reads.
- **`env["SOME_VAR"]`.** Access recognizers only see property accesses, so the bracket form is not read.
- **Durable Object classes.** A `DurableObject` subclass is its own deployable with its own methods, and it is not part of the entrypoint object.
- **The status a Worker sends through a helper of its own.** `new Response(...)` and the two static helpers are read where they are written. A project's own `jsonResponse()` comes out as an unread return.

## Where it fits in suss

Every path is a `@suss/recognize` declaration: two discovery patterns for the triggers, a read chain for `env`, and a chain for each store, so the pack doesn't read a syntax tree itself. It depends on `@suss/extractor` for the pack type, `@suss/recognize` for the declarations, and `@suss/resolution` for the name the store types are declared under. `@suss/contract-wrangler` declares the other side: the variables the Worker is given, the queues it produces to and consumes from, and the stores it is bound to.
