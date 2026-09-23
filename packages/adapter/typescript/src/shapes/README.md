# shapes/

This layer breaks TypeScript expressions down into `TypeShape` IR, the shape vocabulary that summaries use for every language.

## Place in the pipeline

The extractor calls this layer whenever it needs to know what a value looks like: return-statement bodies (terminals), throw arguments, effect arguments, and response shapes derived from contracts. It works in three passes. The first breaks the expression down syntactically, which keeps literals as narrow as they were written. The second resolves AST declarations through `resolve/astResolve.ts`, following imports and variable chains. The last falls back to the type checker for generics and types from other modules.

## Key files

- `shapes.ts:extractShape` is the public entry point. A recursion guard local to the module stops cycles between the extractors at `MAX_EXTRACT_DEPTH = 64`.
- `shapes.ts:shapeFromObjectLiteral` / `shapeFromArrayLiteral` break object and array literals down syntactically. They keep literal values that the type checker would widen.
- `typeShapes.ts:shapeFromNodeType` / `shapeFromType` are the type-checker fallback. They use `MAX_DEPTH = 6` and a per-call `seen` Set on `objectToShape` to handle recursive types.
- `typeShapes.ts:typeToShape` is the central dispatch. It decides which `TypeShape` variant matches the type checker's `Type`.
- `fieldAccesses.ts:findResponseAccessor` locates the response binding in a call expression, whether it is a named param, destructured, or assigned to a variable.
- `fieldAccesses.ts:collectPropertyAccesses` traces property reads through a statement subtree, and normalizes chains rooted at the response.

## Gotchas

- **Keeping literals narrow is the reason for the syntactic pass.** Most type-checker queries widen literals, so `"ok"` becomes `string`. At the source site the literal is written out, so the syntactic pass runs first. The type checker is asked only when the AST can't decide.
- **The extractors can recurse into each other.** `extractShape → resolveNodeFromAst → extractShape` is a call path that does happen. Each entry to `resolveNodeFromAst` resets its own seen-set, so the cycle detection there works per walk and not per shape. `shapes.ts` adds a depth counter local to the module, which switches to the type-checker path past `MAX_EXTRACT_DEPTH`. This counter stopped a crash when adapter-typescript extracted itself.
- **Object-literal seen-set vs. union seen-set.** `objectToShape` records its own type key in `seen` to short-circuit cycles. Unions and intersections record theirs too. Recursive type aliases such as `Json = string | number | Json[] | { [k: string]: Json }` get past the check that only covers objects, and without this they would overflow the stack.
- **Spreads in records.** `{ ...user, admin: true }` resolves through the pipeline, and spread sources contribute their fields in source order, following JS override semantics. When a spread can't be resolved, only that spread goes into a `spreads[]` field. The parts that do resolve still merge into `properties`.
- **Types the project did not declare stop at their name.** When every declaration of a named type is in the default library or under `node_modules`, the type is reported as `{ type: "ref", name }`, the same form the depth cap falls back to. A reader who sees `HTMLElement` already knows what came back, and its property set describes the DOM and says nothing about the codebase being read. On saleor-dashboard this makes the difference between a 15MB output file and a 1.3GB one. `seen` only guards a single expansion path, so a dense library graph expands the same types again through every property until `MAX_DEPTH` runs out. Anonymous types expand wherever they were written, because the compiler calls a type literal or a mapped type `__type`, and a ref would tell the reader less than the fields do. `SourceFile` decides which case a type falls in. It uses the program's own default-library and external-library flags, and does not match on paths.
- **Opaque named types.** Date, RegExp, Error, Promise, Map, Set and similar types don't expand, because their internal structure doesn't help you reason about the value. They come out as `{ type: "ref", name: ... }` with the type checker's text for the type, so `Promise<User>` keeps its type parameter in the ref name.
- **Module-level constants are inlined.** `invocationEffects` inlines simple module-scoped const initializers in call args before calling `extractShape`. As a result `const Q = process.env.QUEUE_URL; send(Q)` collapses to the env-var read shape, and `Q` does not stay opaque.

## Sibling modules

- `resolve/astResolve.ts` and this module call each other. Together they implement the "AST first, type-checker fallback" strategy.
- `terminals/extract.ts` calls `extractShape` on returned objects and throw arguments.
- `resolve/invocationEffects.ts` calls `extractShape` on effect arguments such as storage call payloads, message bodies and env-var reads.
