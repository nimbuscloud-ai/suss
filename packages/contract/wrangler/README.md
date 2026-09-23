# @suss/contract-wrangler

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package reads a Cloudflare `wrangler.toml` (or `wrangler.jsonc`) and records what the Worker it deploys is given.

## What this package is

A contract source. `suss contract --from wrangler services/api` reads the document and records the declared side of four boundaries:

```toml
name = "greeting-router"
main = "src/index.ts"

[vars]
GREETING_TABLE = "prod-greetings-v2"

[[kv_namespaces]]
binding = "SESSIONS"
id = "prod-sessions"

[[queues.consumers]]
queue = "greeting-events"
```

| What the document says | What comes out |
| --- | --- |
| `name`, `main` | the deployable unit and the code it runs |
| `[vars]` | the Worker's runtime configuration, names and values |
| `[[kv_namespaces]]`, `[[r2_buckets]]`, `[[d1_databases]]` | one store each, under the binding name the code spells |
| `[[queues.producers]]`, `[[queues.consumers]]` | one channel each, on `cloudflare-queues` |
| `[env.<name>]` | the same Worker deployed again, with the top-level document as its default |

A store's container is the binding name, `SESSIONS`, because that is what an access in the Worker uses (`env.SESSIONS.get(...)`). `@suss/framework-cloudflare-workers` records the same name on the code side, so the storage check pairs the two. The resource's own name, meaning the KV namespace id or the bucket name, goes on the summary as `physicalTable`. A Prisma model splits the same way, between the model name and the table it maps to.

Binding names are also listed on the runtime-config contract, next to the `[vars]` names. A binding is a property of the same `env` object, so a Worker that reads `env.AUDIT_KV` with no binding block for it gets the same finding as a read of a variable nobody set.

## Variable values

A runtime-config contract usually records which variables a runtime supplies, and that is enough to tell whether code reads one nobody set. A Worker needs more, because it addresses its stores through a variable:

```ts
await dynamoRequest(env, aws, "Query", { TableName: env.EDITION_TABLE });
```

Nothing at that call site shows which table. The container comes out as `{EDITION_TABLE}`, which does not pair with anything until something gives the variable's value. `[vars]` gives it, so the summary keeps the values under `metadata.runtimeContract.envVarValues`, and the storage check grounds the access through the runtime that runs it.

A value the document does not set is left out. A secret is set with `wrangler secret put` or by the deployment's own tooling, and never in the file, so the reader has nothing to record and the container stays unresolved.

## Environments

`[env.staging]` deploys the same Worker again under its own name, which is `greeting-router-staging` unless the block sets a `name`. Each environment gets its own summary.

Wrangler replaces a whole block instead of merging it, so an environment that declares `[env.staging.vars]` gets those variables and none of the top-level ones. A variable that comes through unchanged is recorded as `globals`, the same provenance a SAM `Globals` section gets, and the checker judges it once for the document instead of once per deployment.

## Code scope

The Worker's code is the directory the document is in, and `main` gives the entry file. `main` often points at a bundle that a build step writes, outside the source. If the entry matches no file, the directory alone decides the code scope, so the code is placed correctly either way.

## Out of scope for now

- **Durable Object and service bindings.** `[[durable_objects.bindings]]` and `[[services]]` are boundaries between two Workers, and pairing them needs both sides of a deployment, which suss does not read yet.
- **Routes.** `routes` lists the hostnames that reach the Worker. The code side does not state a path, so a declared route would not pair with anything.
- **Cron expressions.** `[triggers] crons` sets when a Worker runs, and says nothing about what it exchanges.
- **`.dev.vars`.** It is configuration for local development, and a deployment does not supply it.

## Where it fits in suss

The package depends on `@suss/behavioral-ir` and `@suss/ir-core` for the bindings it writes. `@suss/framework-cloudflare-workers` reads the code side: the triggers the Worker serves and the variables it reads. The storage check in `@suss/checker` pairs a store this reader declares, or one a Terraform module declares, with the accesses that reach it.
