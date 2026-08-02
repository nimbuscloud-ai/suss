# discovery/

Pattern-driven unit discovery. Each `DiscoveryMatch` variant has its own handler file; `index.ts` is the dispatcher and the dedup pass.

## Place in the pipeline

Runs after the bootstrap pre-filter has decided which files each pack applies to. Receives a parsed `SourceFile` and the pack's `DiscoveryPattern[]`; produces `DiscoveredUnit[]` — one per code unit the patterns recognized. Output feeds the terminals + effects extraction layer, then the closure walk, then summary assembly.

## Key files

- `index.ts:discoverUnits` — public API. Runs every pattern, then dedupes results by `(func, kind, packageExportInfo, routeInfo)`.
- `index.ts:runPattern` — dispatch table from `match.type` to the per-handler module.
- `shared.ts:DiscoveredUnit` — the result type. Carries `func`, `kind`, `name`, plus optional pattern-specific payloads (`callSite`, `operationInfo`, `resolverInfo`, `packageExportInfo`, `routeInfo`).
- `shared.ts:findEnclosingFunction` / `toFunctionRoot` — AST helpers most handlers need.
- `resolveValue.ts:functionValueOf` / `objectLiteralOf` / `arrayLiteralOf` — the value a handler is looking at, whether it was written out at the position or named there. Every handler that reads an argument, a property or an iterable goes through these.
- `factoryTracking.ts:trackFactoryBindings` — scope-aware binding tracker used by `packageImport` to follow factory results through one syntactic hop.
- `factorySurface.ts:surfaceMethods` — used by `packageExports` to enumerate methods on object-literal returns and class declarations.

## Non-obvious things

- **The dedup key says which function, and on which boundary.** `(func.file:start-end, kind, bindingSuffix, routeSuffix)`. Offsets are positions within one file, so the file is part of naming the function once the question is asked across a whole run. The binding suffix distinguishes consumer summaries that share an enclosing function but consume different exports (`extract` calling both `createTypeScriptAdapter` and its `.extractAll`). The route suffix distinguishes registrationTemplate-derived units that share a handler but expand to different `(method, path)` pairs.
- **A unit is claimed once per run, not once per file.** A barrel re-exporting a component reaches the same function the file declaring it reaches, and both claims would otherwise produce a summary carrying the same name and the same boundary. Nothing in the key mentions the file the question was asked from, so the second claim collapses into the first. A route file re-exporting a `loader` keeps both, because the route it serves is part of the key.
- **Per-pattern dispatch isn't pluggable.** Each match type has a hardcoded branch in `runPattern`. Adding a new variant means editing the dispatcher, the framework `DiscoveryMatch` union, and writing the handler. There's no generic registry — the typed exhaustiveness on `match.type` is the trade.
- **Recognizer-only packs.** A pack with no `discovery` patterns still gets its `invocationRecognizers` / `accessRecognizers` / `subUnits` invoked across whatever units other packs discover. Discovery handlers don't know about recognizers; the adapter pipeline aggregates them across packs and dispatches separately.
- **Handlers walk their own scope.** Most descend the source file with `forEachDescendant` and carry their own scope rules (e.g. `factoryTracking` scopes bindings to enclosing functions). The dispatcher doesn't enforce a walk shape.
- **A handler asks rather than follows.** Reading the syntax sitting at a position sees an identifier and stops, so a handler hands the value to `resolveValue.ts` and the fact layer follows it through a property read, an array element, an alias, an import and a barrel. Two candidates answer with neither, which is what keeps a wrong handler from being reported confidently. A handler run without a `ResolutionStore` therefore finds only what is written out at the position, and the adapter always supplies one.
- **`packageImport` dedup happens at TWO layers.** Once inside the handler (collapses repeated calls to the same export within an enclosing function) and once in the dispatcher's bindingSuffix dedup (handles cross-pattern collisions). Both layers are necessary; removing either misses cases.

## Sibling modules

- `bootstrap/preFilter.ts` decides which patterns get dispatched per file.
- `terminals/` extracts response/return/throw shapes from each unit's body.
- `resolve/invocationEffects.ts` runs cross-pack recognizers against the same units.
- `resolve/reachableClosure.ts` extends discovered units transitively into callees.

## When adding a new match type

1. Add the variant to `DiscoveryMatch` in `packages/extractor/src/framework.ts`.
2. Write a handler module in this directory exporting `discover<Kind>(sourceFile, match, kind, resolution?): DiscoveredUnit[]`.
3. Add a branch to `runPattern` in `index.ts`.
4. If the units carry new identity (like `routeInfo` or `packageExportInfo`), make sure the dedup key in `discoverUnits` includes it — otherwise units that share `func` get collapsed.
