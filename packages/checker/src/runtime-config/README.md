# runtime-config/

This check pairs runtime-config providers (CloudFormation Lambda env blocks, ECS task definitions, container env, k8s pod env) with the places where code reads `process.env.X`. It checks that every variable the code reads is declared, and for some variables, that every declared one is read.

## Place in the pipeline

`checkAll()` runs it after pairing. Its inputs are the runtime-config providers (the ones with `metadata.runtimeContract` and `metadata.codeScope`) and the code summaries with `config-read` interaction effects. For legacy summaries it scans invocation arguments for the `process.env.X` pattern instead. It emits `boundaryFieldUnknown` (aspect: read), `boundaryFieldUnused`, and `runtimeScopeUnknown`.

## Key files

- `runtimeConfigPairing.ts:checkRuntimeConfig` is the main orchestrator.
- `chargedReads.ts:chargeRuntimes` finds where each runtime starts and which functions those starts reach.
- `runtimeConfigPairing.ts:collectEnvVarReads` pulls env-var names out of `config-read` effects. When there are none it falls back to matching the legacy pattern in invocation arguments.
- `runtimeConfigPairing.ts:readProvidedEnvVars` parses the declared env-var list out of `metadata.runtimeContract.envVars`.
- `runtimeConfigPairing.ts:readEnvVarSources` parses the per-variable source map (`platform` vs. `template` provenance).

## Which reads a runtime is charged with

A runtime is charged with a read only when a call from where it starts reaches the function that makes the read. `chargedReads.ts` works this out. A runtime starts at three kinds of unit:

- its handler, which a pack stamped with the runtime's deployable unit, or, when no pack did, the function `codeScope.entryExport` says in the entry file;
- the module-init unit of every file its import closure contains, since loading a file runs its top level;
- every unit a framework runs, such as a route or a queue consumer, in a file the runtime loads. A FastAPI app behind `Mangum(app)` has no call from the handler to its routes, and the routes still run in that Lambda.

The import closure is right for module-init and wrong for a function. A client file that three hundred handlers import is loaded by all of them, and its `getFlag()` runs only in the handlers that call it. Charging by the closure reported that read against every one of them.

The pass builds the call facts once and asks `reachedFromEach` once for every start, with `certainOnly`, so a call that takes its function out of a table charges nothing. A read in a file the runtime loads that no settled call reaches is not a finding and is not clear either. It goes on `unchecked.runtimeConfig` in the `checkAll` result, with `notReached` or, when only a call through a table reaches it, `possibleCall`. Only a read that would otherwise have been a finding is listed, since a declared or defaulted read is fine whether it runs or not. `check` prints one line per runtime that has any.

## One finding per read

A `boundaryFieldUnknown` here is about the read, so the reading summary is on both sides, the consumer side gives the variable as `field`, and the boundary is the read's own binding, which says no deployment. Each runtime that runs the read without declaring the variable contributes the same finding, and `dedupeFindings` keeps one with every such runtime in `sources`. Adding a function that runs the read only adds to `sources`, so the finding keeps its identity and `check --base` reports nothing new. The rule that accepts one is `consumer: { summary, field }`.

`boundaryFieldUnused` still goes by the closure. A variable that code in the runtime's files reads is never called unused, reached or not.

## Gotchas

- **Pairing requires `codeScope`.** A runtime-config provider without `metadata.codeScope.kind === "codeUri"`, or with a missing path, emits one `runtimeScopeUnknown` finding and is then skipped. Without a scope there is no way to tell which code reads belong to it.
- **A directory contains only code in its own project.** The reader records which project a template's paths are measured from as `codeScope.workspace`, the package the template is in. A sibling package's `src/config.ts`, which a TypeScript run can reach through a workspace link, is not under a template's `src` even though its path is. Code or a scope that gives no project, such as a Python file, is compared by path alone.
- **A directory decides only when it is the only one that could.** When the code says which deployable unit it belongs to, the pairing goes by the two units. When it does not, `scope/`'s `contestedFiles` counts how many runtimes declare a directory that contains the file. A file that two or more of them contain is paired against none of them, unless a call from one runtime's handler reaches it, which says that runtime runs it. A service that builds every function from the service root gives them all the same directory, so going by that directory would report one `process.env` read once per function. Each such file gets one `runtimeScopeUnknown` finding with the number of runtimes that claimed it.
- **When the scope is ambiguous, the check holds back one finding and keeps the other.** A read the directory could not place still counts toward `readNames`. That way `boundaryFieldUnused` never tells a runtime that nothing reads a variable when some code may well read it. Only `boundaryFieldUnknown` is held back.
- **A runtime whose entry file the run never read gets no unused warning.** Wrangler's `main` and a Lambda handler often point at a bundle a build step writes, such as a framework adapter's generated worker. The directory still places the source, so a read the runtime does not supply is reported. Whether the bundle reads a declared variable is unknown, so the check emits one info `boundaryFieldUnused` per runtime that lists the variables it did not check.
- **Config-read effects are the preferred form in v0.** The env-var recognizer in `@suss/runtime-node` emits them. The checker falls back to the legacy scan of invocation arguments (looking for the literal pattern `process.env.X` in call arguments) only when no summary in the set has a `config-read` effect. The fallback runs less often as more code is re-extracted with the node runtime pack.
- **A metadata read does not count as a variable.** `__dirname`, `import.meta.url` and `process.cwd` arrive on the same runtime-config boundary under the `metadata-read` class, and this pass only looks at `config-read`. A template has no way to declare `__dirname`, so pairing these reads used to report an error for every function that resolved a path. They do not count as an environment read either. A run whose only reads are metadata still gets the one info finding that says no environment read was recorded.
- **`envVarUnused` only fires for template-declared vars.** Variables marked `source: "platform"` are ones the runtime injects itself, such as `AWS_REGION` and `LAMBDA_TASK_ROOT`. They are part of the runtime contract and are never flagged as unused, even when no code reads them. This only works when the stub layer fills in `envVarSources`.
- **A var marked `source: "globals"` is judged once for the document that declares it.** A SAM `Globals` section gives the same variable to every function in the template, so one function not reading it is fine. What matters is whether anything in the document reads it. When nothing does, the check emits one warning per (document, variable). When no runtime in the document matched any code, it emits none, because a document that paired with nothing gives no evidence that a variable goes unread.

## Sibling modules

- `interactions/dispatcher.ts` provides the optional index parameter, for fast lookups of `config-read` effects.
- `coverage/responseMatch.ts` provides the `makeSide` helper for the location strings on findings.
- `message-bus/messageBusPairing.ts` uses the `envVarTargets` metadata to resolve queue channels.
