# discovery/

Discovery of code units, driven by patterns. Each `DiscoveryMatch` variant has its own handler file. `index.ts` is the dispatcher, and it also does the dedup pass.

## Place in the pipeline

This runs after the bootstrap pre-filter has decided which files each pack applies to. It takes a parsed `SourceFile` and the pack's `DiscoveryPattern[]`, and it produces `DiscoveredUnit[]`, one per code unit the patterns recognized. Its output goes to the terminals and effects extraction layer, then the closure walk, then summary assembly.

## Key files

- `index.ts:discoverUnits`, the public API. It runs every pattern, then dedupes the results by `(func, kind, packageExportInfo, routeInfo)`.
- `index.ts:runPattern`, a dispatch table from `match.type` to the per-handler module.
- `shared.ts:DiscoveredUnit`, the result type. It has `func`, `kind`, `name`, plus optional pattern-specific payloads (`callSite`, `operationInfo`, `resolverInfo`, `packageExportInfo`, `routeInfo`).
- `decoratedMembers.ts:decoratedCallablesOf`, the decorated callables a class declares, whether they are written as methods or as properties that contain a function. Both decorator-driven handlers read a class through this.
- `shared.ts:findEnclosingFunction` and `toFunctionRoot`, AST helpers most handlers need.
- `resolveValue.ts:functionValueOf` / `objectLiteralOf` / `arrayLiteralOf` / `writtenNodeOf`, the value a handler is looking at, whether it was written out at the position or referred to there by name. Every handler that reads an argument, a property or an iterable goes through these.
- `factoryTracking.ts:trackFactoryBindings`, a scope-aware binding tracker that `packageImport` uses to follow factory results through one syntactic hop.
- `factorySurface.ts:surfaceMethods`, which `packageExports` uses to enumerate methods on object-literal returns and class declarations.
- `registrationCall.ts:registrationSubjectsOf`, the variables in a file that contain the routable a `DiscoveryPattern.match`'s import produces. Route discovery and mount discovery share it, so both work out which variable is the routable the same way.
- `wrapperIndex.ts:buildWrapperIndex`, which scans the same files for the registrations a pack declares through `DiscoveryPattern.wraps` (Express `app.use(fn)`, Hono `app.use(path, mw)` and `app.onError(fn)`). It gives back two things: the wrappers as units, so each one is summarized where what it does is written, and the edge from a wrapped unit to them. The edge is keyed on the routable the registration was made on, which a unit records through `DiscoveredUnit.registrationSubjectId`.
- `mountPrefix.ts:buildMountPrefixIndex`, which scans every file the pack's gate already applies to for mount calls (`DiscoveryPattern.mount`, Express `app.use`, Hono `app.route`) and builds the index that route discovery uses to put together a mounted router's prefix. It follows the mounted value across a file when the file refers to it by name, and chains through however many routers it was mounted onto in turn.

## Non-obvious things

- **The dedup key says which function, and on which boundary.** `(func.file:start-end, kind, bindingSuffix, routeSuffix)`. Offsets are positions within one file, so the file has to be part of identifying the function once you ask the question across a whole run. The binding suffix tells apart consumer summaries that share an enclosing function but consume different exports (`extract` calling both `createTypeScriptAdapter` and its `.extractAll`). The route suffix tells apart registrationTemplate-derived units that share a handler but expand to different `(method, path)` pairs.
- **A unit is claimed once per run, not once per file.** A barrel that re-exports a component reaches the same function the file declaring it reaches, and both claims would otherwise produce a summary with the same name and the same boundary. Nothing in the key mentions the file the question was asked from, so the second claim collapses into the first. A route file that re-exports a `loader` keeps both, because the route it serves is part of the key.
- **Per-pattern dispatch isn't pluggable.** Each match type has a hardcoded branch in `runPattern`. Adding a new variant means editing the dispatcher, editing the framework `DiscoveryMatch` union, and writing the handler. There is no generic registry. What we get in exchange is exhaustiveness checking on `match.type`.
- **Recognizer-only packs.** A pack with no `discovery` patterns still gets its `invocationRecognizers`, `accessRecognizers` and `subUnits` run across whatever units other packs discover. Discovery handlers know nothing about recognizers. The adapter pipeline collects them across packs and dispatches them separately.
- **Handlers walk their own scope.** Most of them descend the source file with `forEachDescendant` and bring their own scope rules (`factoryTracking`, for instance, scopes bindings to enclosing functions). The dispatcher does not require any particular kind of walk.
- **A route can outlive its handler.** `func` is null on a unit whose registration states a route and then passes on a handler that the registering function was itself handed. There is no chain to follow from there, so the summary keeps the boundary, points at the registration (`announcedAt`), and uses an `unreadOutcome` gap to say that nothing about the handler was read. A boundary reported with nothing behind it is worth more than no boundary at all. Every other unresolved argument goes unreported, because a chain nobody has followed yet means a missing rule rather than a fact about the code.
- **A handler asks rather than follows.** Reading whatever syntax is at a position gets you an identifier and no further, so a handler hands the value to `resolveValue.ts` and the fact layer follows it through a property read, an array element, an alias, an import and a barrel. When there are two candidates it comes back with neither, which is what stops a wrong handler from being reported with confidence. So a handler run without a `ResolutionStore` finds only what is written out at the position, and the adapter always supplies one.
- **`packageImport` dedup happens at TWO layers.** Once inside the handler (which collapses repeated calls to the same export within an enclosing function) and once in the dispatcher's bindingSuffix dedup (which handles cross-pattern collisions). You need both layers; removing either one misses cases.
- **Mount composition asks rather than follows, same as a handler.** A mount call's target argument goes through `resolveValue.ts:writtenNodeOf`, the same resolution store a handler argument goes through, so a router mounted through an import in another file resolves the same way a handler imported from another file does. A mount whose prefix is not a string literal, or whose target the store cannot follow, contributes nothing, which is the same rule `extractRouteInfoFromBinding` follows for a route's own path.

- **A wrapper's behavior lives on the wrapper's own summary.** The metadata on a wrapped unit is a reference: which file the wrapper is in and what it is called there, plus the path pattern the registration narrowed it to and whether the framework invokes it only for a request that threw. Nothing about what it does is copied, the same way a GraphQL resolver points at a schema document rather than repeating the SDL. Composing the two is a later step, and it becomes a rule over this edge.
- **A wrapper handed the thrown value reads one parameter further along.** Express calls an error handler with `(err, req, res, next)` and a handler with `(req, res, next)`, so the pack's terminals and its input mapping are shifted past the thrown value for a unit whose pattern declares `wraps.throwParam`. Without that, an error handler's `res.status(500)` matches nothing and the summary comes out empty.
- **The wrapper index decides which registrations are error handlers, then hands over the units.** Express writes both kinds as `app.use(fn)` and tells them apart by arity, which one pattern on its own cannot do: the plain declaration matches a four-argument function too. So the index folds every pack's candidates together first, keeps the narrowest reading of each call, and the walk adds the surviving ones to what `discoverUnits` found.
- **A wrapper's scope is composed with its router's mount prefix.** `api.use("/v1/*", requireCaller)` writes the scope against `api`, and a route on `api` is reported under whatever prefix `api` was mounted at, so mounting `api` at `/api` turns the route into `/api/v1/things/:id` while the scope still says `/v1/*`. The two are then compared against each other and nothing matches, which drops a middleware that does run. So the index runs the same mount chain through `agreedMountPrefix` that route discovery runs, and the scope comes out as `/api/v1/*`. A chain that cannot be stated, two mounts of one router landing at different paths say, composes to nothing and leaves the scope as written, which is what the route does with its own path in the same situation.
- **A wrapper reaches the units registered on the same routable, and no further.** Both the wrapper registration and the route registration have to resolve to one creation site (`const app = express()`), which is how they are matched. A file that registers routes on an app it was handed as a parameter has no such site in common with the file that created the app, so wrappers registered there do not reach those routes. Mount discovery has the same limit for the same reason. Order is not read either: a wrapper registered after a route still records against it, because the index says what is registered, not what runs first.

## Sibling modules

- `bootstrap/preFilter.ts` decides which patterns get dispatched per file.
- `terminals/` works out what each unit's body responds with, returns and throws.
- `resolve/invocationEffects.ts` runs cross-pack recognizers against the same units.
- `resolve/reachableClosure.ts` extends discovered units transitively into callees.

## When adding a new match type

1. Add the variant to `DiscoveryMatch` in `packages/extractor/src/framework.ts`.
2. Write a handler module in this directory exporting `discover<Kind>(sourceFile, match, kind, resolution?): DiscoveredUnit[]`.
3. Add a branch to `runPattern` in `index.ts`.
4. If the units come with new identity (like `routeInfo` or `packageExportInfo`), make sure the dedup key in `discoverUnits` includes it, or units that share `func` will be collapsed together.
