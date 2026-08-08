# runtime-config/

This check pairs runtime-config providers (CloudFormation Lambda env blocks, ECS task definitions, container env, k8s pod env) against the places where code reads `process.env.X`. It verifies that every variable the code reads is declared and, for some of them, that every declared variable is read.

## Place in the pipeline

`checkAll()` runs it after pairing. It takes runtime-config providers (the ones with `metadata.runtimeContract` and `metadata.codeScope`) and code summaries with `config-read` interaction effects; for legacy summaries it instead scans invocation arguments for the `process.env.X` pattern. It emits `boundaryFieldUnknown` (aspect: read), `boundaryFieldUnused`, and `runtimeScopeUnknown`.

## Key files

- `runtimeConfigPairing.ts:checkRuntimeConfig` is the main orchestrator.
- `runtimeConfigPairing.ts:collectEnvVarReads` pulls env-var names out of `config-read` effects, falling back to matching the legacy pattern in invocation arguments.
- `runtimeConfigPairing.ts:readProvidedEnvVars` parses the declared env-var list out of `metadata.runtimeContract.envVars`.
- `runtimeConfigPairing.ts:readEnvVarSources` parses the per-variable source map (`platform` vs. `template` provenance).

## Non-obvious things

- **`codeScope` is mandatory for pairing.** A runtime-config provider without `metadata.codeScope.kind === "codeUri"` (or with a missing path) emits one `runtimeScopeUnknown` finding and is then skipped. Without a scope there is no way to tell which code reads belong to it.
- **A directory decides only when it is the only one that could.** Where the code says which deployable unit it belongs to, the two units decide. Where it does not, `scope/`'s `contestedFiles` asks how many runtimes declare a directory that contains the file, and a file two or more of them contain is paired against none of them. A service that builds every function from the service root gives them all the same directory, and going by that directory would report one `process.env` read once per function. Each such file gets one `runtimeScopeUnknown` finding saying how many runtimes claimed it.
- **Ambiguity stops both accusations.** A read the directory could not place still counts toward `readNames`, so `boundaryFieldUnused` does not then tell a runtime that nothing reads a variable somebody may well read. Only `boundaryFieldUnknown` is held back.
- **Config-read effects are the v0 preferred form.** The env-var recognizer in `@suss/runtime-node` emits them. The checker falls back to scanning invocation arguments the legacy way (looking for the literal pattern `process.env.X` in call arguments) only when no `config-read` effects exist anywhere in the summary set. That fallback gets rarer as more code is re-extracted with the node runtime pack.
- **`envVarUnused` only fires for template-declared vars.** Variables marked `source: "platform"` (the runtime injects them itself: `AWS_REGION`, `LAMBDA_TASK_ROOT`) are part of the runtime contract and are never flagged as unused, even when no code reads them. The stub layer has to fill in `envVarSources` for this to work.
- **A var marked `source: "globals"` is judged once for the document that declares it.** A SAM `Globals` section gives the same variable to every function in the template, so a function that does not read it is not a defect. The question is whether anything in the document reads it. One warning comes out per (document, variable) when nothing does, and none at all when no runtime in the document matched any code, since a document that paired with nothing cannot say that a variable goes unread.

## Sibling modules

- `interactions/dispatcher.ts` provides the optional index parameter, for looking `config-read` effects up quickly.
- `coverage/responseMatch.ts` provides the `makeSide` helper for the location strings on findings.
- `message-bus/messageBusPairing.ts` uses the `envVarTargets` metadata to resolve queue channels.
