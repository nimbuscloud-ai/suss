# runtime-config/

This check pairs runtime-config providers (CloudFormation Lambda env blocks, ECS task definitions, container env, k8s pod env) with the places where code reads `process.env.X`. It checks that every variable the code reads is declared, and for some variables, that every declared one is read.

## Place in the pipeline

`checkAll()` runs it after pairing. Its inputs are the runtime-config providers (the ones with `metadata.runtimeContract` and `metadata.codeScope`) and the code summaries with `config-read` interaction effects. For legacy summaries it scans invocation arguments for the `process.env.X` pattern instead. It emits `boundaryFieldUnknown` (aspect: read), `boundaryFieldUnused`, and `runtimeScopeUnknown`.

## Key files

- `runtimeConfigPairing.ts:checkRuntimeConfig` is the main orchestrator.
- `runtimeConfigPairing.ts:collectEnvVarReads` pulls env-var names out of `config-read` effects. When there are none it falls back to matching the legacy pattern in invocation arguments.
- `runtimeConfigPairing.ts:readProvidedEnvVars` parses the declared env-var list out of `metadata.runtimeContract.envVars`.
- `runtimeConfigPairing.ts:readEnvVarSources` parses the per-variable source map (`platform` vs. `template` provenance).

## Gotchas

- **Pairing requires `codeScope`.** A runtime-config provider without `metadata.codeScope.kind === "codeUri"`, or with a missing path, emits one `runtimeScopeUnknown` finding and is then skipped. Without a scope there is no way to tell which code reads belong to it.
- **A directory decides only when it is the only one that could.** When the code says which deployable unit it belongs to, the pairing goes by the two units. When it does not, `scope/`'s `contestedFiles` counts how many runtimes declare a directory that contains the file. A file that two or more of them contain is paired against none of them. A service that builds every function from the service root gives them all the same directory, so going by that directory would report one `process.env` read once per function. Each such file gets one `runtimeScopeUnknown` finding with the number of runtimes that claimed it.
- **When the scope is ambiguous, the check holds back one finding and keeps the other.** A read the directory could not place still counts toward `readNames`. That way `boundaryFieldUnused` never tells a runtime that nothing reads a variable when some code may well read it. Only `boundaryFieldUnknown` is held back.
- **Config-read effects are the preferred form in v0.** The env-var recognizer in `@suss/runtime-node` emits them. The checker falls back to the legacy scan of invocation arguments (looking for the literal pattern `process.env.X` in call arguments) only when no summary in the set has a `config-read` effect. The fallback runs less often as more code is re-extracted with the node runtime pack.
- **A metadata read does not count as a variable.** `__dirname`, `import.meta.url` and `process.cwd` arrive on the same runtime-config boundary under the `metadata-read` class, and this pass only looks at `config-read`. A template has no way to declare `__dirname`, so pairing these reads used to report an error for every function that resolved a path. They do not count as an environment read either. A run whose only reads are metadata still gets the one info finding that says no environment read was recorded.
- **`envVarUnused` only fires for template-declared vars.** Variables marked `source: "platform"` are ones the runtime injects itself, such as `AWS_REGION` and `LAMBDA_TASK_ROOT`. They are part of the runtime contract and are never flagged as unused, even when no code reads them. This only works when the stub layer fills in `envVarSources`.
- **A var marked `source: "globals"` is judged once for the document that declares it.** A SAM `Globals` section gives the same variable to every function in the template, so one function not reading it is fine. What matters is whether anything in the document reads it. When nothing does, the check emits one warning per (document, variable). When no runtime in the document matched any code, it emits none, because a document that paired with nothing gives no evidence that a variable goes unread.

## Sibling modules

- `interactions/dispatcher.ts` provides the optional index parameter, for fast lookups of `config-read` effects.
- `coverage/responseMatch.ts` provides the `makeSide` helper for the location strings on findings.
- `message-bus/messageBusPairing.ts` uses the `envVarTargets` metadata to resolve queue channels.
