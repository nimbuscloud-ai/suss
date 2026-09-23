# `@suss/runtime-node`: design proposal

`@suss/runtime-node` is a single pack that models the Node.js runtime: scheduling primitives, the `process` surface, and module-loading conventions. It is one layer below the framework packs. Express handlers stay in `framework-express`, but a `setImmediate(handler)` call inside an Express handler is the runtime pack's responsibility.

## Status

Shipped as `@suss/runtime-node`. The `process.env.X` env-var recognizer, originally shipped as the standalone `@suss/framework-process-env` pack, was folded into this pack (`src/envVars.ts`) alongside the process-surface recognizer. The standalone pack was removed (it was unpublished, so no compat re-export was needed). The pack declares a `version` stamp so re-extraction with the merged pack invalidates warm caches from the pre-merge node pack.

## Why this exists

Today, suss has no model for asynchronous scheduling outside of what individual framework packs declare. A function passed to `setImmediate`, `queueMicrotask`, or `setTimeout(fn, 0)` is invisible. suss treats it as a function reference passed as data, with no record that it will run. This means:

- Backend services with deferred work (job queues, batched writes, late side effects) under-report their behavior. Coverage looks complete, but the deferred branch is missing.
- A handler that does `setImmediate(() => sendNotification(user))` shows the `sendNotification` reference as unused, when it is actually scheduled.
- The dogfood pipeline runs against suss itself, and it will not notice, because the suss codebase does not rely on `setImmediate`. The gap shows up as soon as we point suss at a non-trivial Node service.

The same problem applies to the `process` surface (env vars, exit codes, argv) and to module loading (`require.resolve`, `__dirname`). `process.env.X` reads were handled first, originally in a standalone `@suss/framework-process-env` pack and now merged into this runtime pack (see [Status](#status)). The runtime pack takes over that work and extends it.

## Scope (v0)

v0 covers three areas, most valuable first.

### 1. Scheduling primitives

These runtime functions take a callback that runs later:

- `setImmediate(fn)`
- `setTimeout(fn, ms)`
- `setInterval(fn, ms)`
- `queueMicrotask(fn)`
- `process.nextTick(fn)`
- `Promise.resolve().then(fn)`: when `.then` is the *only* operation on a fresh Promise.

For each, the pack:

1. Emits a `subUnits` declaration so the callback `fn` becomes its own code unit, parented to the calling unit.
2. Emits a `schedule` effect on the calling transition (a new `Effect` discriminator).

The sub-unit has no `boundaryBinding`, because being scheduled is not a contract. It exists as code. Cross-unit pairing happens only if its body touches a contracted boundary: it calls a tracked import, sends to a queue, or registers a handler.

`clearTimeout` / `clearInterval` do nothing in v0. They cancel scheduled work, and v0 does not track when scheduled work runs.

### 2. Process surface

- `process.env.X` reads: the `envVarRecognizer` now lives in this pack (`src/envVars.ts`). The standalone `framework-process-env` pack was removed outright instead of being kept as a compat re-export stub, since it was never published.
- `process.argv` reads: these are the runtime config channel of the deployable unit (cf. `project_env_var_boundary.md`). They have the same boundary semantics as env vars.
- `process.exit(code)`: this is a terminal. The status code comes from the argument, and it falls back to `0`. This adds a `processExit` terminal kind.
- `process.cwd()`, `process.platform`, `process.version`: opaque reads of runtime metadata. Mark them as `opaque` predicates with a clear reason, so downstream tooling sees the dependency and nothing invents structure for it.

### 3. Module-loading surface

- `require.resolve(specifier)`: this is an invocation effect with the specifier captured, and it is useful for dependency analysis.
- `__dirname` / `__filename`: opaque-source reads tied to the file's location. Mark them `opaque` with a reason, so the user can see that suss noticed them.
- `import.meta.url` (ESM): same treatment.
- `process.versions.node`: opaque runtime metadata.

Bare `require(specifier)` calls are out of scope for v0. They overlap with the existing import-resolution pipeline, and would need their own design for a "synthetic import declaration."

## Out of scope for now

Each of these is left for later, because each is its own design problem.

- **EventEmitter / streams.** `emitter.on("event", handler)` is a registration call that looks like `app.get(path, handler)`. But pairing it with a cross-file `emitter.emit("event", ...)` needs an event-name registry the pack can share with consumers. It belongs in a separate pack, `@suss/framework-events`.
- **`fs.*` and `node:fs`.** These are part of the storage protocol family. They belong in a storage-protocol pack, `@suss/storage-fs`, and the platform pack would only hand them off.
- **`crypto`.** This is a source of opacity (random IDs, hashes). Each call collapses an unbounded value space to one identifier. It should get its own pack so the opacity reasons can be specific to the domain.
- **Worker threads / `child_process`.** These are new unit boundaries (cross-process). Cross-process pairing needs IR work, and a pack alone cannot provide it.
- **Timers as proper temporal primitives.** v0 treats `setTimeout(fn, 5000)` and `setImmediate(fn)` identically: both schedule `fn`. The 5000ms is not modeled. Modeling time is a separate piece of work.

## Mechanics

The pack uses three existing extension points:

### `subUnits`: parent-unit body walker

For each parent code unit, walk descendants for `CallExpression` nodes whose callee matches one of the scheduling primitives. When the first argument is an `ArrowFunction` or `FunctionExpression`, synthesize a sub-unit:

```ts
{
  func: <argFn>,
  kind: "scheduled-callback",
  name: `${parent.name}.${schedulingMethodName}`,
  metadata: { node: { schedulingMethod: "setImmediate" } },
}
```

When the first argument is an identifier resolving to a function declared elsewhere, emit a sub-unit pointing at the resolved declaration. When resolution fails, the pack does not emit a sub-unit, and the parent's effect record is the only trace.

`scheduled-callback` is a new `CodeUnitKind`. It does not pair with anything by default, and the checker treats it as a unit-of-record.

### `invocationRecognizer`: per-call effect emission

The same calls trigger a recognizer that emits a `schedule` effect:

```ts
{
  kind: "schedule",
  via: "setImmediate" | "setTimeout" | "queueMicrotask" | "process.nextTick" | "promise.then",
  target: <ref to the callback>,
}
```

The IR's `Effect` enum gets the new variant. Existing transitions accept this effect on their default branch, the same way they accept `invocation` and `storage-read` today.

### `accessRecognizer`: `process.env`, `__dirname`, `import.meta.url` reads

The recognizer walks `PropertyAccessExpression` nodes, and when the receiver is a tracked global (`process`, `import.meta`), it emits the corresponding effect.

## Confidence

Three levels:

- **High**: a literal callback expression passed directly (`setImmediate(() => doX())`). The sub-unit body is right there, so nothing is inferred.
- **Medium**: an identifier that resolves to a function declaration in the same file. Resolution is syntactic and does not use types.
- **Low / opaque**: an identifier whose value comes from a parameter, a property access, or an expression that cannot be resolved. The pack does not emit a sub-unit, and the `schedule` effect gets `target: { type: "opaque", reason: "non-literal-callback" }`.

Confidence goes on the sub-unit. The effect does not record it.

## Interactions with other packs

Two cases need a precedence rule:

1. **Framework wraps a runtime primitive.** Take a framework that exports its own `runOnNextTick(fn)`, which calls through to `process.nextTick(fn)`. Today it would emit twice if both packs match the underlying call. The rule: framework-pack discovery wins for the wrapper, and the platform pack fires only on the runtime API itself. Recognizers should narrow on where the import came from (`process.nextTick` from `node:process` vs `framework.runOnNextTick` from another module).

2. **Framework declares its own scheduled-callback semantics.** React's `useEffect` body is conceptually a scheduled callback, but `@suss/framework-react` already handles it as a `subUnits` declaration. The platform pack should not cover it a second time. The rule: the platform pack covers only the platform-level scheduling primitives, even when a framework behaves the same way.

For both cases, the pack-author docs need a chapter on layering: "framework packs that wrap a platform primitive own the wrapper; the platform pack owns the underlying API."

## Open questions

- **`Promise.then(fn)` as a scheduling site.** It always emits a microtask, but most `.then` chains transform a value and are not side-effect handlers. Treating every `.then` as a sub-unit would inflate the count by about 10×. Options: (a) only treat `.then` as scheduling when the chain ends without a `return`, (b) treat it always but mark low confidence, (c) skip entirely and rely on framework / async-aware passes elsewhere. We lean toward (c) for v0, and would revisit it if production codebases need it.
- **Opacity reasons.** Each opaque read should include a reason string the user can see. Current opacity reasons are ad hoc, and adopting this pack forces a small reason taxonomy (`runtime-metadata`, `non-literal-callback`, `dynamic-require`).
- **Where does `process.env.X = "value"` (writes) go?** A read is an access to the config channel, and a write changes that channel. It is probably a separate effect kind (`processEnvWrite`), but we rarely see it in practice, so it waits.

## Validation

v0 is done after three checks:

1. Unit tests in `@suss/runtime-node` covering each scheduling primitive's recognizer and subUnit synthesis.
2. An integration test in `@suss/cli` against a synthetic Express service with `setImmediate(() => persistAudit(req))`. It verifies that the audit-write call appears in pairings and that the parent's transition lists the `schedule` effect.
3. A dogfood re-run with the platform pack added to the pipeline. The expected effect on suss itself is small, since the codebase rarely uses these primitives. A better check is to point it at one external Node service and look at how coverage changes.

## Naming

Package: `@suss/runtime-node`. Directory: `packages/runtime/node/`. Default export: `nodeRuntimePack()`. Pack `name`: `"node"`. The `runtime-` prefix is now free after the `client-*` rename.

## Cost estimate

- Scheduling primitives: about 5 recognizers, 5 subUnit declarations and 1 new `Effect` kind. Half a day.
- Process surface: move the env-var recognizer into this pack and add argv/exit/cwd. Half a day.
- Module surface: 3 access recognizers and the opacity-reason taxonomy. Half a day.
- Unit tests, the integration test and dogfood validation. One day.

Total: 2.5 to 3 days in a single pass. It is less if the opacity-reason taxonomy waits and v0 uses `"opaque"` with no structure.
