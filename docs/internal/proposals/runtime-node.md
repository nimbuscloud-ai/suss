# `@suss/runtime-node` — design proposal

A single pack that models the Node.js runtime: scheduling primitives, the `process` surface, and module-loading conventions. Sits below framework packs in the layering — Express handlers stay in `framework-express`, but a `setImmediate(handler)` call inside an Express handler is the runtime pack's responsibility.

## Why this exists

Today, suss has no model for asynchronous scheduling outside of what individual framework packs declare. A function passed to `setImmediate`, `queueMicrotask`, or `setTimeout(fn, 0)` is invisible — it's treated as a function reference passed as data, with no record that it will run. This means:

- Backend services with deferred work (job queues, batched writes, late side effects) under-report their behavior. Coverage looks complete, but the deferred branch is missing.
- A handler that does `setImmediate(() => sendNotification(user))` shows the `sendNotification` reference as unused, when it's actually scheduled.
- The dogfood pipeline, which runs against suss itself, won't notice because the suss codebase doesn't lean on `setImmediate`. This invisibility shows up as soon as we point suss at a non-trivial Node service.

The same problem applies to the `process` surface (env vars, exit codes, argv) and to module loading (`require.resolve`, `__dirname`). Some of these are partially handled today: `@suss/framework-process-env` covers `process.env.X` reads. The platform pack absorbs that work and extends it.

## Scope — v0

Three areas, in order of leverage.

### 1. Scheduling primitives

The runtime functions whose argument is a callback that will execute later:

- `setImmediate(fn)`
- `setTimeout(fn, ms)`
- `setInterval(fn, ms)`
- `queueMicrotask(fn)`
- `process.nextTick(fn)`
- `Promise.resolve().then(fn)` — when `.then` is the *only* operation on a fresh Promise.

For each, the pack:

1. Emits a `subUnits` declaration so the callback `fn` becomes its own code unit, parented to the calling unit.
2. Emits a `schedule` effect on the calling transition (a new `Effect` discriminator).

The sub-unit has no `boundaryBinding` — being scheduled isn't a contract. It exists as code; cross-unit pairing happens only if it touches a contracted boundary internally (calls a tracked import, hits a queue, registers a handler).

`clearTimeout` / `clearInterval` are no-ops for v0 — they cancel scheduled work, which we don't track temporally.

### 2. Process surface

- `process.env.X` reads — already covered by `framework-process-env`. Move that recognizer here. Keep the existing pack as a stub that re-exports for compat, deprecate later.
- `process.argv` reads — runtime config channel of the deployable unit (cf. `project_env_var_boundary.md`). Same boundary semantics as env vars.
- `process.exit(code)` — terminal. Status code from the argument; fallback `0`. Adds a `processExit` terminal kind.
- `process.cwd()`, `process.platform`, `process.version` — opaque reads against runtime metadata. Mark as `opaque` predicates with a clear reason so downstream tooling sees the dependency without inventing structure.

### 3. Module-loading surface

- `require.resolve(specifier)` — invocation effect with the specifier captured. Useful for dependency analysis.
- `__dirname` / `__filename` — opaque-source reads tied to the file's location. Mark with `opaque` and a reason so the user knows we know.
- `import.meta.url` (ESM) — same treatment.
- `process.versions.node` — opaque runtime metadata.

Bare `require(specifier)` calls are out of scope for v0 — they overlap with the existing import-resolution pipeline and would need design for "synthetic import declaration."

## Out of scope, deferred

Each of these is a follow-up because each is its own design problem.

- **EventEmitter / streams.** `emitter.on("event", handler)` is a registration call shaped like `app.get(path, handler)`, but cross-file `emitter.emit("event", ...)` pairing needs an event-name registry the pack can share with consumers. Separate pack: `@suss/framework-events`.
- **`fs.*` and `node:fs`.** Storage protocol family. Belongs in a storage-protocol pack; the platform pack would only hand off, not handle. Separate pack: `@suss/storage-fs`.
- **`crypto`.** Source of opacity (random IDs, hashes). Each call collapses an unbounded value space to one identifier. Worth its own pack so the opacity reasons are domain-specific.
- **Worker threads / `child_process`.** New unit boundaries (cross-process). Needs IR work for cross-process pairing, not just a pack.
- **Timers as proper temporal primitives.** v0 treats `setTimeout(fn, 5000)` and `setImmediate(fn)` identically — both schedule `fn`. The 5000ms isn't modeled. Temporal modeling is its own arc.

## Mechanics

The pack uses three existing extension points:

### `subUnits` — parent-unit body walker

For each parent code unit, walk descendants for `CallExpression` nodes whose callee matches one of the scheduling primitives. When the first argument is an `ArrowFunction` or `FunctionExpression`, synthesize a sub-unit:

```ts
{
  func: <argFn>,
  kind: "scheduled-callback",
  name: `${parent.name}.${schedulingMethodName}`,
  metadata: { node: { schedulingMethod: "setImmediate" } },
}
```

When the first argument is an identifier resolving to a function declared elsewhere, surface a sub-unit pointing at the resolved declaration. When the resolution fails, emit no sub-unit — the parent's effect record is the only trace.

`scheduled-callback` is a new `CodeUnitKind`. It pairs to nothing by default; the checker treats it as a unit-of-record.

### `invocationRecognizer` — per-call effect emission

Same calls trip a recognizer that emits a `schedule` effect:

```ts
{
  kind: "schedule",
  via: "setImmediate" | "setTimeout" | "queueMicrotask" | "process.nextTick" | "promise.then",
  target: <ref to the callback>,
}
```

The IR's `Effect` enum gets the new variant. Existing transitions accept this effect on their default branch, just as they accept `invocation` and `storage-read` today.

### `accessRecognizer` — `process.env`, `__dirname`, `import.meta.url` reads

Walks `PropertyAccessExpression` nodes; when the receiver is a tracked global (`process`, `import.meta`), emits the corresponding effect.

## Confidence

Three levels:

- **High**: literal callback expression directly passed (`setImmediate(() => doX())`). The sub-unit body is right there; no inference.
- **Medium**: identifier resolved to a function declaration in the same file. Resolution is syntactic, not type-driven.
- **Low / opaque**: identifier whose value comes from a parameter, a property access, or a non-resolvable expression. No sub-unit emitted; the `schedule` effect carries `target: { type: "opaque", reason: "non-literal-callback" }`.

Confidence lives on the sub-unit, not on the effect.

## Interactions with other packs

Two cases need a precedence rule:

1. **Framework wraps a runtime primitive.** A framework that exports its own `runOnNextTick(fn)` calling through to `process.nextTick(fn)` would, today, double-emit if both packs match the underlying call. Resolution: framework-pack discovery wins for the wrapper; the platform pack only fires on the literal runtime API. Recognizers should narrow on import provenance (`process.nextTick` from `node:process` vs `framework.runOnNextTick` from another module).

2. **Framework declares its own scheduled-callback semantics.** React's `useEffect` body is conceptually a scheduled callback, but it's already handled as a `subUnits` declaration in `@suss/framework-react`. The platform pack should not double-cover. Resolution: platform pack only covers the platform-level scheduling primitives, even if a framework's behavior is similar.

For both cases, the pack-author docs need a layering chapter: "framework packs that wrap a platform primitive own the wrapper; the platform pack owns the underlying API."

## Open questions

- **`Promise.then(fn)` as a scheduling site.** Always emits a microtask, but most `.then` chains aren't side-effect handlers — they're transformations. Treating every `.then` as a sub-unit would inflate the count by ~10×. Options: (a) only treat `.then` as scheduling when the chain ends without a `return`, (b) treat it always but mark low confidence, (c) skip entirely and rely on framework / async-aware passes elsewhere. Lean toward (c) for v0; revisit if real codebases need it.
- **Opacity reasons.** Each opaque read should carry a reason string the user can see. Current opacity reasons are ad-hoc; this pack's adoption is a forcing function for a small reason taxonomy (`runtime-metadata`, `non-literal-callback`, `dynamic-require`).
- **Where does `process.env.X = "value"` (writes) go?** Read is a config-channel access; write is mutation of the channel. Probably a separate effect kind (`processEnvWrite`), but rarely seen in real code. Defer.

## Validation

Three checkpoints before declaring v0 done:

1. Unit tests in `@suss/runtime-node` covering each scheduling primitive's recognizer + subUnit synthesis.
2. Integration test in `@suss/cli` against a synthetic Express service with `setImmediate(() => persistAudit(req))` — verify the audit-write call appears in pairings and the parent's transition lists the `schedule` effect.
3. Re-run dogfood with the platform pack added to the pipeline. Expected effect on suss itself: minimal (the codebase rarely uses these primitives). Better: point at one external Node service and observe coverage delta.

## Naming

Package: `@suss/runtime-node`. Directory: `packages/runtime/node/`. Default export: `nodeRuntimePack()`. Pack `name`: `"node"`. The `runtime-` prefix is now free after the `client-*` rename.

## Cost estimate

- Scheduling primitives: ~5 recognizers + 5 subUnit declarations + 1 new `Effect` kind. Half a day.
- Process surface: move existing process-env recognizer + add argv/exit/cwd. Half a day.
- Module surface: 3 access recognizers + opacity-reason taxonomy. Half a day.
- Tests + integration test + dogfood validation. One day.

Total: 2.5–3 days, single pass. Smaller if we defer the opacity-reason taxonomy (just use `"opaque"` with no structure for now).
