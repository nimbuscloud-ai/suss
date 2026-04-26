# resolve/

AST walking, symbol resolution, and post-discovery passes that fill in cross-function context.

## Place in the pipeline

Runs after discovery and during summary assembly. Three roles:

1. **Effect extraction.** `invocationEffects.ts` walks each unit's body for `CallExpression` nodes and produces `RawEffect` objects (one for each captured call). Pack recognizers fire here.
2. **Shape resolution.** `astResolve.ts` follows AST declaration chains (variable initializers, property access, single-return function bodies) to preserve literal narrowness that the type checker would widen. Used by `shapes/` as the first attempt before falling back to the type checker.
3. **Post-extraction enrichment.** `reachableClosure.ts` synthesizes `library`-kind summaries for functions reachable from already-discovered units. `rethrowEnrichment.ts` post-processes throw transitions to add `possibleSources` from try-block callees.

## Key files

- `astResolve.ts:resolveNodeFromAst` — public entry; walks identifiers, property accesses, calls, and `await` expressions to resolve a node to a `TypeShape`. Caps at `MAX_HOPS` and uses a per-walk seen set.
- `astResolve.ts:resolveCall` — single-return-only call resolver. Multi-return functions, overloads, and method calls fall through to the type checker.
- `invocationEffects.ts:extractInvocationEffects` — captures bare expression-statement calls + container-building calls (array/object-literal-returning fns). Skips nested function bodies.
- `invocationEffects.ts:runInvocationRecognizers` — dispatches recognizers from every loaded pack against every CallExpression in the unit's body.
- `reachableClosure.ts:discoverReachableFunctions` — transitive-closure walk; emits library summaries with `recognition: "reachable"`.
- `rethrowEnrichment.ts:enrichRethrows` — adds `rethrow.possibleSources` to throw transitions whose enclosing try-block calls into other summarized functions.

## Non-obvious things

- **astResolve and shapes call each other.** `extractShape` (in `shapes/shapes.ts`) calls `resolveNodeFromAst`; `resolveNodeFromAst` calls `extractShape` back. Each entry to `resolveNodeFromAst` resets its own `seen`/`hops` context, so the cycle detection there doesn't catch cross-extractor recursion. `shapes/shapes.ts` has a module-local depth guard (`MAX_EXTRACT_DEPTH`) as the safety net for self-referential call graphs.
- **`isInformativeInitializer` filter.** When walking a variable's initializer, we only descend into call/await/new — those are the cases where the AST tells you something the type checker wouldn't (e.g. `const u = await db.find()` returns `T | null`; past a null guard the use site is just `T`). For other initializers (literals, expressions), defer to the use-site type.
- **Recognizer error isolation.** A recognizer that throws is caught, logged to stderr with file:line, and skipped for that call. The extraction continues — buggy recognizers don't crash the run.
- **Closure walk is one-hop only.** `reachableClosure` resolves immediate callees of discovered units to library summaries. Transitive throws (`A` throws because `A → B → C` throws) are deferred to `rethrowEnrichment`, which only walks try-blocks one level deep.
- **Container-building calls are flagged `neverTerminal`.** Calls like `someBuilder()` that return arrays/objects become invocation effects but shouldn't compete with `return` / `throw` in the terminal-line dedup. The flag tells assembly to keep them as effects, not collapse them into the unit's terminal output.
- **Rethrow lookup is by line range, not symbol.** `summary.location.range` (`startLine-endLine`) is the lookup key — not function name or symbol identity. Works because we never have two summaries for the same function at the same line range.

## Sibling modules

- `bootstrap/sourceFileLookup.ts` — `reachableClosure` and `rethrowEnrichment` use it to locate summaries by file.
- `shapes/` — `astResolve` and `shapes` mutually recurse; the depth cap and seen sets keep both bounded.
- `discovery/` — `invocationEffects` runs recognizers against `DiscoveredUnit.func`. The recognizer dispatcher skips into nested function bodies, which means callbacks inside arrows/IIFEs don't get recognizer coverage (see `project_recognizer_scope_gap.md`).
- `terminals/` — both walk function bodies, but `terminals/` matches against pack-declared terminal patterns; `invocationEffects` captures everything else.
