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
- **A directory answers only when it is the only one that could.** Where the code names a deployable unit, the two units decide. Where it does not, `scope/`'s `contestedFiles` asks how many runtimes declare a directory holding the file, and a file two or more of them hold is paired against none of them. A service that builds every function from the service root hands them all the same directory, and taking it would report one `process.env` read once per function. Each such file gets one `runtimeScopeUnknown` naming how many runtimes claimed it.
- **Ambiguity stops both accusations.** A read the directory could not place still counts toward `readNames`, so `boundaryFieldUnused` does not then tell a runtime that nothing reads a variable somebody may well read. Only `boundaryFieldUnknown` is withheld.
- **Config-read effects are the v0 preferred form.** `@suss/runtime-node`'s env-var recognizer emits them. The checker falls back to legacy invocation-arg scanning (looking for the literal pattern `process.env.X` in call arguments) only when no `config-read` effects exist anywhere in the summary set. The fallback is increasingly rare as more code is re-extracted with the node runtime pack.
- **`envVarUnused` only fires for template-declared vars.** Vars marked `source: "platform"` (auto-injected by the runtime — `AWS_REGION`, `LAMBDA_TASK_ROOT`) are part of the runtime contract and never flagged as unused, even when no code reads them. The stub layer must populate `envVarSources` for this to work.
- **A var marked `source: "globals"` is judged once for the document that declares it.** A SAM `Globals` section hands the same variable to every function in the template, so a function that does not read it is not a defect; the question is whether anything in the document reads it. One warning comes out per (document, variable) when nothing does, and none at all when no runtime in the document matched any code, since a document that paired nothing cannot say a variable goes unread.

## Sibling modules

- `interactions/dispatcher.ts` — optional index parameter for fast `config-read` effect lookup.
- `coverage/responseMatch.ts` — `makeSide` helper for finding location strings.
- `message-bus/messageBusPairing.ts` — consumes `envVarTargets` metadata to resolve queue channels.
