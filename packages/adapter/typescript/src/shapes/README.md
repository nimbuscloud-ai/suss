# shapes/

Decomposes TypeScript expressions into `TypeShape` IR — the language-agnostic shape vocabulary used in summaries.

## Place in the pipeline

Called whenever the extractor needs to know what a value looks like: return-statement bodies (terminals), throw arguments, effect arguments, contract-derived response shapes. Three-pass strategy: syntactic decomposition first (literals preserve their narrowness), then AST declaration resolution via `resolve/astResolve.ts` (follow imports / variable chains), then type-checker fallback (generics, cross-module types).

## Key files

- `shapes.ts:extractShape` — public entry. Module-local recursion guard caps cross-extractor cycles at `MAX_EXTRACT_DEPTH = 64`.
- `shapes.ts:shapeFromObjectLiteral` / `shapeFromArrayLiteral` — syntactic decomposition for object and array literals. Preserves literal values that the type checker would widen.
- `typeShapes.ts:shapeFromNodeType` / `shapeFromType` — type-checker fallback. `MAX_DEPTH = 6` and a per-call `seen` Set on `objectToShape` to handle recursive types.
- `typeShapes.ts:typeToShape` — central dispatch. Decides which `TypeShape` variant matches the type checker's `Type`.
- `fieldAccesses.ts:findResponseAccessor` — locates the response binding in a call expression (named param, destructured, or assigned-to).
- `fieldAccesses.ts:collectPropertyAccesses` — traces property reads through a statement subtree, normalizing chains rooted at the response.

## Non-obvious things

- **Literal narrowness is the whole point.** Most type-checker queries widen literals (`"ok"` becomes `string`). The syntactic pass runs first because at the source site the literal is right there. Only when the AST can't decide do we ask the type checker.
- **Cross-extractor recursion.** `extractShape → resolveNodeFromAst → extractShape` is a real call path. Each entry to `resolveNodeFromAst` resets its own seen-set, so the cycle detection there is per-walk, not per-shape. `shapes.ts` adds a module-local depth counter that drops to the type-checker path past `MAX_EXTRACT_DEPTH`. This caught a real crash on adapter-typescript self-extraction.
- **Object-literal seen-set vs. union seen-set.** `objectToShape` records its own type key in `seen` to short-circuit cycles. Unions and intersections also record, because recursive type aliases (`Json = string | number | Json[] | { [k: string]: Json }`) bypass the object-only seen check and would otherwise blow the stack.
- **Spreads in records.** `{ ...user, admin: true }` resolves through the pipeline: spread sources contribute their fields in source order (JS override semantics). When a spread can't be resolved, only the unresolvable spread escapes to a `spreads[]` field; the resolvable parts still merge into `properties`.
- **Opaque named types.** Date, RegExp, Error, Promise, Map, Set, etc. don't expand — their structural shape isn't useful for reasoning about the value. Surfaced as `{ type: "ref", name: ... }` with the type-checker's text representation (so `Promise<User>` keeps the parameterization in the ref name).
- **Module-level constant inlining.** `invocationEffects` inlines simple module-scoped const initializers in call args before calling `extractShape`, so `const Q = process.env.QUEUE_URL; send(Q)` collapses to the env-var read shape instead of leaving `Q` opaque.

## Sibling modules

- `resolve/astResolve.ts` — mutual recursion partner. The two together implement the "AST first, type-checker fallback" strategy.
- `terminals/extract.ts` — calls `extractShape` on returned objects and throw arguments.
- `resolve/invocationEffects.ts` — calls `extractShape` on effect arguments (storage call payloads, message bodies, env-var reads).
