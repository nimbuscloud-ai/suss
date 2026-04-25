# Env-var → runtime-contract pairing (Gap 5c)

Plan for the env-var checking capability. PR-time gate; OSS scope only
(audit / cross-repo features stay product-side per
[OSS vs product scope](https://github.com/.../oss-product-split)).

## Why this is in scope (not a tangent)

Suss describes "every execution path" of code without running it. Env
var reads gate execution paths in the same way conditional inputs do:
`if (process.env.FEATURE_FLAG === "on")` decides which branch runs;
`fetch(process.env.API_URL)` decides which downstream the call hits;
a missing var resolves to `undefined`, which silently flips truthy
checks, changes comparisons, malforms URLs, or throws. The runtime-
config contract is an **input** to the execution-path graph suss
already models. Verifying the contract against what the runtime
actually provides keeps the simulacrum honest — without it, the path
suss thinks the program takes can diverge from what production sees.

## Boundary framing

The boundary is the **runtime configuration channel of a deployable
unit** (Lambda, container, ECS task, k8s pod). Env var names are
*fields* on that channel's contract — same level of abstraction as
`body.email` is a field on a REST endpoint's contract. A CFN stack
setting 30 vars on one Lambda is one producer with 30 fields, not 30
producers. A service reading 5 vars is one consumer with 5 field
accesses.

Pairing key: `(deploymentTarget, instanceName)` — e.g.
`("lambda", "MyFunction")` — with field-level access on top.

### What the boundary actually collapses

It's a **two-link chain** modeled as one boundary:

1. **CFN/SAM service ↔ runtime instance** — the template promises
   "I'll materialize this Lambda with env block X."
2. **runtime ↔ process** — the runtime hands its env block to the
   process at startup; the process reads via `process.env`.

The collapse is honest because the chain is transitive: if the
template promises `{A, B, C}` and the runtime is what the template
materialized, the process sees `{A, B, C}`. Pairing logic doesn't
need the intermediate.

The collapse does hide one thing: **platform-injected env vars**.
The runtime's side of link (2) adds vars the template never
declared — Lambda auto-sets `AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME`,
etc.; ECS sets `AWS_DEFAULT_REGION`; k8s sets `KUBERNETES_*`. The
provider summary's `provided` set is therefore
`templateDeclared ∪ platformInjected[deploymentTarget]`. The CFN
stub (5c.2) owns the platform-injected list; finding messages can
surface provenance ("declared in template" vs "injected by Lambda
runtime") when useful.

## Demo

Three SAM Lambdas in a fixture repo:

```
template.yaml
src/
├─ checkout/index.ts        # reads STRIPE_API_KEY, DATABASE_URL
├─ webhook-handler/index.ts # reads STRIPE_WEBHOOK_SECRET, KAFKA_BROKER
└─ batch-reconcile/index.ts # reads DATABASE_URL, OLD_S3_BUCKET
```

`template.yaml` deliberately drifts:
- `checkout` declares `STRIPE_KEY` (typo — code reads `STRIPE_API_KEY`) + `DATABASE_URL`
- `webhook-handler` declares `STRIPE_WEBHOOK_SECRET` only (missing `KAFKA_BROKER`)
- `batch-reconcile` declares `DATABASE_URL` + `OLD_S3_BUCKET` + an unused `LEGACY_FEATURE_FLAG`

```
suss extract -p tsconfig.json -f express -o code-summaries.json
suss stub --from cloudformation template.yaml -o cfn-summaries.json
suss check --dir .suss-summaries
```

Expected output:

```
[error] envVarUnprovided in src/checkout/index.ts:14
   STRIPE_API_KEY read by checkout Lambda; template provides STRIPE_KEY
   (did you mean STRIPE_API_KEY?)
[error] envVarUnprovided in src/webhook-handler/index.ts:8
   KAFKA_BROKER read by webhook-handler Lambda; not declared in template
[warning] envVarUnused on Lambda batch-reconcile
   LEGACY_FEATURE_FLAG declared in template but not read by any code in
   CodeUri ./src/batch-reconcile
```

## Audience

**Primary:** backend developer in a SAM/CDK serverless codebase, on the
PR before merge. Recurring pain: typo / omission / dead-config drift
between code and template. Without suss → 500 in staging → CloudWatch
trace → fix → redeploy. With suss → CI catches it at PR review.

**Secondary (weaker, not the launch story):** marginal addition for
teams already running suss for HTTP / GraphQL contracts.

## Scope

In:
- CFN + SAM Lambda env vars
- ECS TaskDefinition env vars
- PR-time `suss check` integration
- Stable summary artifact (substrate for product audit features later)

Out (deferred):
- K8s manifest stub — same boundary shape, separate stub package
- Dockerfile / docker-compose env stubs
- `.env` files (configuration defaults, not the runtime contract)
- Default-value detection (`process.env.X || "default"`)
- Required-detection (`if (!process.env.X) throw`)
- Type coercion (`Number(process.env.PORT)`)
- Dynamic access (`process.env[name]` — opaque)
- Build-time substitution (Vite `import.meta.env.X`, webpack
  `process.env.NODE_ENV`) — different boundary kind
- Audit-flavored CLI surface (e.g. `suss audit env-vars --rotate X`) —
  product scope

## Implementation

### IR (Phase 5c.1)

`packages/ir/src/schemas.ts`:
- Add `runtime-config` variant to `BoundarySemantics`:
  ```ts
  z.object({
    name: z.literal("runtime-config"),
    deploymentTarget: z.enum(["lambda", "ecs-task", "container", "k8s-deployment"]),
    instanceName: z.string(),
  })
  ```
- Add `runtimeProvides` field on `inputs[]` element OR a top-level
  `metadata.runtimeContract` field on `BehavioralSummary`. Pick during
  implementation — likely the latter for less schema disruption.
- Add `metadata.codeScope: { kind: "codeUri" | "unknown"; path?: string }`
  for runtime-config summaries.

`packages/ir/src/index.ts`:
- New helper `runtimeConfigBinding({ recognition, deploymentTarget,
  instanceName })`.
- Add `library: "provider"` already exists; runtime-config summaries
  use `kind: "library"` (a runtime "exposes" the contract that env
  vars are provided).

### Checker (Phase 5c.1)

`packages/checker/src/runtime-config/`:
- `runtimeConfigPairing.ts` — pair runtime-config-bound summaries
  against code summaries by `codeScope` overlap with `location.file`.
- `envVarMatching.ts` — extract `process.env.X` reads from
  `EffectArg.identifier` entries; compare provided vs read.
- Two finding kinds: `envVarUnprovided`, `envVarUnused`.
- Wire into `checkAll`.

### CFN stub (Phase 5c.2)

`packages/stub/cloudformation/src/`:
- Recognize `AWS::Lambda::Function`,
  `AWS::Serverless::Function`, `AWS::ECS::TaskDefinition`.
- Extract `Environment.Variables` (Lambda) /
  `ContainerDefinitions[*].Environment` (ECS).
- Append the **platform-injected** env-var set per deploymentTarget
  to whatever the template declared. Lambda's set:
  `AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME`,
  `AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`,
  `AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`,
  `AWS_LAMBDA_RUNTIME_API`, `AWS_EXECUTION_ENV`, `LAMBDA_TASK_ROOT`,
  `LAMBDA_RUNTIME_DIR`, `_HANDLER`, `TZ`.
  ECS adds: `AWS_DEFAULT_REGION`,
  `ECS_CONTAINER_METADATA_URI_V4`. K8s pods get the
  `KUBERNETES_*` set. Provenance metadata
  (`runtimeContract.envVarSources: { [name]: "template" | "platform" }`)
  lets finding messages distinguish the source when useful.
- Extract `CodeUri` (SAM only) → `metadata.codeScope.path`.
- Recognize `Metadata.SussCodeScope` annotation as escape hatch for
  raw CFN with S3-built artifacts.
- Emit one summary per resource with `runtime-config` boundary.

### End-to-end (Phase 5c.3)

- Wire stub-to-checker integration.
- Fixture project (the demo above).
- Snapshot test asserting the three findings.

## Open questions

1. **Multi-attribution** — if `src/shared/db.ts` is included in two
   Lambdas via `CodeUri: ./src/`, do its env reads pair against both?
   → Yes, multi-attribute.
2. **Indirect env access** (`const config = { db: process.env.DB };
   config.db`) — capture only the read at the literal site; downstream
   uses through an aggregating object stay opaque.
3. **`metadata.codeScope` for raw CFN** — without `CodeUri`, no
   pairing possible. Recognize `Metadata.SussCodeScope` annotation as
   the escape hatch; otherwise emit one informational finding per
   runtime ("scope unknown, can't verify env vars").

## Status

Plan: locked.
Work: not started.
Owner: shipping under #152.
