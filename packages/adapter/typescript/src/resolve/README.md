# resolve/

AST walking, symbol resolution, and post-discovery passes that fill in cross-function context.

## Place in the pipeline

This layer runs after discovery and during summary assembly. It has three roles:

1. **Effect extraction.** `invocationEffects.ts` walks each unit's body for `CallExpression` nodes and produces `RawEffect` objects (one for each captured call). Pack recognizers fire here.
2. **Shape resolution.** `astResolve.ts` follows AST declaration chains (variable initializers, property access, single-return function bodies) to preserve literal narrowness that the type checker would widen. `shapes/` tries this first, before it falls back to the type checker.
3. **Post-extraction enrichment.** `reachableClosure.ts` synthesizes `library`-kind summaries for functions reachable from already-discovered units. `rethrowEnrichment.ts` post-processes throw transitions to add `possibleSources` from try-block callees.

## Key files

- `readName.ts:readName`, what a name-valued expression says, as fixed text with a hole for each part built at run time. Every storage pack calls it for a table, a bucket or a cache key. The table below says what it reads.
- `astResolve.ts:resolveNodeFromAst` — public entry; walks identifiers, property accesses, calls, and `await` expressions to resolve a node to a `TypeShape`. Caps at `MAX_HOPS` and uses a per-walk seen set.
- `astResolve.ts:resolveCall` — single-return-only call resolver. Multi-return functions, overloads, and method calls fall through to the type checker.
- `invocationEffects.ts:extractInvocationEffects` — captures bare expression-statement calls + container-building calls (array/object-literal-returning fns). Skips nested function bodies.
- `invocationEffects.ts:runInvocationRecognizers` — dispatches recognizers from every loaded pack against every CallExpression in the unit's body.
- `reachableClosure.ts:discoverReachableFunctions` — transitive-closure walk; emits library summaries with `recognition: "reachable"`.
- `rethrowEnrichment.ts:enrichRethrows` — adds `rethrow.possibleSources` to throw transitions whose enclosing try-block calls into other summarized functions.

## Which unfollowed calls leave a gap

A call the closure cannot follow reads exactly like a call that is not
there. Both produce nothing, and a reader cannot tell "this handler
touches no storage" from "this handler touches storage through something
we lost". So the closure records the stop as an `unfollowedCall` gap on
the summary of the body that made the call, saying which callee and why.
`unfollowedCall.ts:classifyStop` is where that decision is made.

It sorts a stop from the declarations the type checker offers for the
callee, and from the function whose body made the call. An imported or
re-exported name is followed through to its last declaration first, or a
barrel forwarding a dependency's function would look like project code.

| Reason | What it is | Gap? |
| --- | --- | --- |
| `noBody` | A declaration the project wrote that states a signature and leaves the body to whoever implements it: a method on an interface, an abstract method, an ambient declaration. | yes |
| `unsettledValue` | The project declares the callee as something other than a function: a field, a variable whose initializer is a call, a parameter of some enclosing function. | yes |
| `multipleSources` | The resolution store followed the callee to two different functions, a fallback whose branches both resolve, or a field two construction sites fill differently. No single body can be followed, and the gap says so at the call rather than folding into a plain could-not-settle. | yes |
| `outsideRun` | Every declaration is in a dependency, or inside `declare module "name"`. | no |
| `noDeclaration` | Nothing declares the callee, which is what a call on an untyped value comes to. | no |
| `callerSupplied` | The callee is a parameter of the function being scanned, so the call runs whatever that function's caller passed in: a middleware's `next`, a callback handed to a higher-order helper. | no |
| `multipleReceivers` | A registration whose receiver comes down to more than one of the pack's own routables, which is what a helper called with two different apps leaves behind. Discovery rather than the closure records this one, since the call it stopped at is the registration itself. | yes |

The three that leave no gap fail the same test: nothing about any of them
says the callee is code the project owns. A codebase makes tens of
thousands of calls into its dependencies, and `JSON.parse` in a gap list
buries every stop a reader could act on. The run also already describes a
call into another package, as a boundary crossing rather than as a body,
so leaving it out here loses nothing.

`callerSupplied` is the newest of the three and the one that moves the
count most. A parameter used to come out as `unsettledValue`, which told
a reader that resolution had failed and sent them looking for a bug that
was not there: a pack declares a middleware's continuation through
`wraps.continuationParam`, so the call to `next` is the one call the run
knows most about. Over the whole dogfood pass, 77 of 250 recorded stops
were calls to a parameter of the function being scanned. None of them was
a resolution failure, and none of them was fixable, because what runs
there is decided by each caller.

That leaves `unfollowedCalls` meaning one thing rather than two: a count
of the calls better resolution could reach. A count of the calls a
project makes through a callback would be a different measure, and worth
having separately if anyone wants it.

A third case belongs on the "gap" side and cannot get here yet: a call
whose receiver a pack recognized but whose method it did not, a Redis
client calling a command the redis pack has no entry for. A recognizer
returns `null` for "not my library" and for "my library, a method I do
not know" alike, so telling those apart needs a change to what a
recognizer hands back.

One gap per callee per body, however many times the body calls it. A
stop deeper in the call chain stays on the summary where it happened
rather than climbing to every caller, so a reader gets one place to look.

## What readName reads

| Written as | Reads as |
| --- | --- |
| `"orders"` | `orders` |
| `` `${stage}-orders` `` | `{stage}-orders` |
| `stage + "-orders"` | `{stage}-orders` |
| `process.env.TABLE ?? "orders-prod"` | `orders-prod` |
| `tableName(stage)`, one return of a template | `{stage}-orders` |
| `buildKey("users", id)`, one return of `parts.join(":")` | `users:{id}` |
| a parameter, a call result, a helper with branches | null |

A hole is named after what the caller passed rather than after the parameter it landed on, so `keyFor(userId)` reading `` `session:${id}` `` gives `session:{userId}`. That is the name somebody reading the call site knows.

A fallback is read differently depending on where it sits. At the top of a name, `process.env.TABLE ?? "orders-prod"` reads as the default, because a whole name that is one hole would pair with every table there is. Inside a longer name, `` `${process.env.STAGE || "staging"}-orders` `` keeps the hole, because a deployment sets that variable and the default is what runs when nobody did.

A caller that passes `unsettled: "reference"` gets a hole instead of null for a name the code says is somewhere else. Which hole depends on who can be asked about the value.

| Written as | Reads as | Who settles it |
| --- | --- | --- |
| `location.bucket`, `location` a parameter | `{location.bucket}` | whoever called this function |
| `bucket`, a parameter | `{bucket}` | whoever called this function |
| `env.ORDERS_TABLE`, `env` a local or a module const | `{ORDERS_TABLE}` | the deployment that sets the variable |
| `config[which]` | null | nobody, so the name says nothing |

A value that arrived as an argument is asked about at the call sites, so the reference states the parameter and every field read inside it. Anything else, a local or a field of one, has no call site to ask, so the reference states what the part is called and leaves settling it to whoever knows. `referenceName` in `@suss/ir-core` is what writes both, the checker reads them back with `parseBoundaryName` from the same module, and every hole this reader spells inside a longer name goes through `patternHole` there too, so no side spells or parses the braces on its own.

An expression this cannot even name still gives null, since a reference has to say what to ask about. `namesNothing` in `@suss/ir-core` is what keeps a name like that out of pairing, because a name that is one hole would otherwise agree with every name there is.

A hole inside a longer name is a different thing and keeps its short name: `` `${stage}-orders` `` reads as `{stage}-orders`. That hole labels the part a deployment fills in rather than saying where to go and ask, and a name with fixed text around it pairs on the fixed text.

Following a helper stops after two hops, and it stops at a body that does more than return one expression. A name that depends on a branch is not a name.

## Non-obvious things

- **astResolve and shapes call each other.** `extractShape` (in `shapes/shapes.ts`) calls `resolveNodeFromAst`; `resolveNodeFromAst` calls `extractShape` back. Each entry to `resolveNodeFromAst` resets its own `seen`/`hops` context, so the cycle detection there doesn't catch cross-extractor recursion. `shapes/shapes.ts` has a module-local depth guard (`MAX_EXTRACT_DEPTH`) as the safety net for self-referential call graphs.
- **`isInformativeInitializer` filter.** When walking a variable's initializer, we only descend into call/await/new — those are the cases where the AST tells you something the type checker wouldn't (e.g. `const u = await db.find()` returns `T | null`; past a null guard the use site is only `T`). For other initializers (literals, expressions), we defer to the use-site type.
- **Recognizer error isolation.** A recognizer that throws is caught, logged to stderr with file:line, and skipped for that call. The extraction continues — buggy recognizers don't crash the run.
- **Closure walk is one-hop only.** `reachableClosure` resolves immediate callees of discovered units to library summaries. Transitive throws (`A` throws because `A → B → C` throws) are deferred to `rethrowEnrichment`, which only walks try-blocks one level deep.
- **Container-building calls are flagged `neverTerminal`.** Calls like `someBuilder()` that return arrays/objects become invocation effects but shouldn't compete with `return` / `throw` in the terminal-line dedup. The flag tells assembly to keep them as effects, not collapse them into the unit's terminal output.
- **Rethrow lookup is by line range, not symbol.** `summary.location.range` (`startLine-endLine`) is the lookup key, not the function name or symbol identity. That works because we never have two summaries for the same function at the same line range.

## Sibling modules

- `bootstrap/sourceFileLookup.ts` — `reachableClosure` and `rethrowEnrichment` use it to locate summaries by file.
- `shapes/` — `astResolve` and `shapes` mutually recurse; the depth cap and seen sets keep both bounded.
- `discovery/` — `invocationEffects` runs recognizers against `DiscoveredUnit.func`. The recognizer dispatcher skips into nested function bodies, which means callbacks inside arrows/IIFEs don't get recognizer coverage (see `project_recognizer_scope_gap.md`).
- `terminals/` — both walk function bodies, but `terminals/` matches against pack-declared terminal patterns; `invocationEffects` captures everything else.
