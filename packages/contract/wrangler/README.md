# @suss/contract-wrangler

Reads a Cloudflare `wrangler.toml` (or `wrangler.jsonc`) and says what the Worker it deploys is given.

## What this package is

A contract source. `suss contract --from wrangler services/api` reads the document and emits the declared side of four boundaries:

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
| `[[kv_namespaces]]`, `[[r2_buckets]]`, `[[d1_databases]]` | one store each |
| `[[queues.producers]]`, `[[queues.consumers]]` | one channel each, on `cloudflare-queues` |
| `[env.<name>]` | the same Worker deployed again, with the top-level document as its default |

## The values, not only the names

A runtime-config contract usually records which variables a runtime supplies, and that is enough to say whether code reads one nobody set. A Worker needs more, because it addresses its stores through a variable:

```ts
await dynamoRequest(env, aws, "Query", { TableName: env.EDITION_TABLE });
```

Nothing at that call site says which table. The container comes out as `{EDITION_TABLE}`, which pairs with nothing until something says what the variable is. `[vars]` says it, so the summary keeps the values under `metadata.runtimeContract.envVarValues`, and the storage check grounds the access through the runtime that runs it.

A value the document does not state stays out. A secret is set with `wrangler secret put` or by the deployment's own tooling, never in the file, so the reader has nothing to record and the container stays unresolved.

## Environments

`[env.staging]` deploys the same Worker again under its own name, `greeting-router-staging` unless the block gives a `name`. Each one gets its own summary.

Wrangler replaces a whole block rather than merging it, so an environment that declares `[env.staging.vars]` supplies those variables and none of the top-level ones. A variable that comes through untouched is recorded as `globals`, which is the same provenance a SAM `Globals` section gets, and the checker judges it once for the document instead of once per deployment.

## Code scope

The Worker's code is the directory the document is in, and `main` says which file it enters. `main` often points at a bundle a build step writes rather than at source; an entry that matches no file leaves the directory in charge, which is what places the code either way.

## Out of scope for now

- **Durable Object and service bindings.** `[[durable_objects.bindings]]` and `[[services]]` are boundaries between two Workers, and pairing them needs both sides of a deployment suss does not read yet.
- **Routes.** `routes` says which hostnames reach the Worker. The code side states no path, so a declared route would pair with nothing.
- **Cron expressions.** `[triggers] crons` says when a Worker runs, not what it exchanges.
- **`.dev.vars`.** It is local development configuration, and it is not what a deployment supplies.

## Where it fits in suss

Depends on `@suss/behavioral-ir` and `@suss/ir-core` for the bindings it writes. `@suss/framework-cloudflare-workers` reads the code side: the triggers the Worker serves and the variables it reads. The storage check in `@suss/checker` pairs a store this reader declares, or one a Terraform module declares, against the accesses that reach it.
