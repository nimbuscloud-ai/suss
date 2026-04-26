# runtime-config/

Pairs runtime-config providers (CloudFormation Lambda env blocks, ECS task definitions, container env, k8s pod env) against code reads of `process.env.X`. Verifies every read variable is declared and (selectively) every declared variable is read.

## Place in the pipeline

Runs in `checkAll()` after pairing. Consumes runtime-config providers (with `metadata.runtimeContract` and `metadata.codeScope`) and code summaries with `config-read` interaction effects (or, for legacy summaries, scans for the `process.env.X` pattern in invocation arguments). Emits `boundaryFieldUnknown` (aspect: read), `boundaryFieldUnused`, and `runtimeScopeUnknown`.

## Key files

- `runtimeConfigPairing.ts:checkRuntimeConfig` — main orchestrator.
- `runtimeConfigPairing.ts:collectEnvVarReads` — extracts env-var names from `config-read` effects, falling back to legacy invocation-arg pattern matching.
- `runtimeConfigPairing.ts:readProvidedEnvVars` — parses the declared env-var list from `metadata.runtimeContract.envVars`.
- `runtimeConfigPairing.ts:readEnvVarSources` — parses the per-var source map (`platform` vs. `template` provenance).

## Non-obvious things

- **`codeScope` is mandatory for pairing.** A runtime-config provider without `metadata.codeScope.kind === "codeUri"` (or with a missing path) emits one `runtimeScopeUnknown` finding and is then skipped. No way to tell which code reads belong to it without a scope.
- **File-path matching is prefix, not equality.** A shared utility file under multiple Lambdas pairs against all of them — multi-attribution. Same-file env-var reads are correctly attributed to every runtime that includes the file in scope.
- **Config-read effects are the v0 preferred form.** `@suss/framework-process-env` emits them. The checker falls back to legacy invocation-arg scanning (looking for the literal pattern `process.env.X` in call arguments) only when no `config-read` effects exist anywhere in the summary set. The fallback is increasingly rare as more code is re-extracted with the env-var pack.
- **`envVarUnused` only fires for template-declared vars.** Vars marked `source: "platform"` (auto-injected by the runtime — `AWS_REGION`, `LAMBDA_TASK_ROOT`) are part of the runtime contract and never flagged as unused, even when no code reads them. The stub layer must populate `envVarSources` for this to work.

## Sibling modules

- `interactions/dispatcher.ts` — optional index parameter for fast `config-read` effect lookup.
- `coverage/responseMatch.ts` — `makeSide` helper for finding location strings.
- `message-bus/messageBusPairing.ts` — consumes `envVarTargets` metadata to resolve queue channels.
