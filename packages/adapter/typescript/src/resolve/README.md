# resolve/

AST walking, symbol resolution, and the passes after discovery that fill in context from other functions.

## Place in the pipeline

This layer runs after discovery and during summary assembly. It does three jobs:

1. **Effect extraction.** `invocationEffects.ts` walks each unit's body for `CallExpression` nodes and produces a `RawEffect` object for each captured call. Pack recognizers run here.
2. **Shape resolution.** `astResolve.ts` follows AST declaration chains (variable initializers, property access, function bodies with a single return) to keep literals as narrow as the source wrote them, where the type checker would widen them. `shapes/` tries this first and falls back to the type checker.
3. **Enrichment after extraction.** `reachableClosure.ts` builds `library`-kind summaries for functions reachable from units already discovered. `rethrowEnrichment.ts` goes back over throw transitions and adds `possibleSources` from the functions the try block calls.

## Key files

- `readName.ts:readName` reads an expression that computes a name into fixed text with a hole for each part built at run time. Every storage pack calls it for a table, a bucket or a cache key. The table below shows what it reads.
- `astResolve.ts:resolveNodeFromAst` is the public entry. It walks identifiers, property accesses, calls, and `await` expressions to resolve a node to a `TypeShape`. It stops at `MAX_HOPS` and keeps a seen set for each walk.
- `astResolve.ts:resolveCall` resolves a call only when the callee has a single return. Functions with several returns, overloads, and method calls fall through to the type checker.
- `invocationEffects.ts:extractInvocationEffects` records one `invocation` effect for each `CallExpression` in the body, wherever the call is written. It descends into arrows and function expressions, and stops at named nested declarations, at sub-unit boundaries a pack declares, and at decorators. See "Every call is an invocation" below.
- `invocationEffects.ts:runInvocationRecognizers` runs the recognizers from every loaded pack against every CallExpression in the unit's body.
- `reachableClosure.ts:discoverReachableFunctions` walks the transitive closure and emits library summaries with `recognition: "reachable"`.
- `rethrowEnrichment.ts:enrichRethrows` adds `rethrow.possibleSources` to a throw transition when its enclosing try block calls into other summarized functions.

## Every call is an invocation

`extractInvocationEffects` records one `invocation` effect for every `CallExpression` in a unit's body. A call can be written as an argument to another call, inside a ternary, inside a template literal, or as the receiver of a method chain, and it is still a call. The `calls` facts a reader queries are built from these effects. The walk does not keep a list of the positions a call may appear in (an expression statement, a spread, an initializer, a return, an element of a literal). A list like that leaves out whatever nobody thought of. Then `what calls buildPatternIndex` reports that nothing does, when the only call is `byPattern.set(pattern, buildPatternIndex(files))`.

Node identity settles everything a position list would have decided:

- Which call is the terminal. When a pack's terminal pattern matches `res.json(body)`, that call is a response, and it must not also be an effect. Assembly compares the call node against the terminal nodes. It drops a call that is the terminal or a link in its receiver chain (`res.status(404)` inside `res.status(404).json(body)`). A call whose result a terminal describes, `return toView(row)`, and a call written as the terminal's argument, `res.json(toView(row))`, are different nodes and stay.
- Which line the call is on. Every effect takes the line of the statement enclosing the call. Assembly compares that line with where each terminal ends to decide which branch the call fires on.
- What had to be true first. Preconditions are collected from the call node itself, so a call in one arm of a ternary records the ternary's condition.

The effects come out in the order the calls finish. A call in argument position comes before the call it feeds, and `f()()` records `f` and then `f()`. The `args` of the outer effect still describe the inner call as `{ kind: "call" }`, for readers that want the data flow.

`async` is true when the caller awaits the result, `await f()`, through any parentheses. An `async` arrow whose concise body is a call no longer marks that call `async`. The arrow returns a promise, but the call inside it may be synchronous.

The walk descends into arrows and function expressions the unit itself runs, such as `.then` callbacks, `forEach` bodies and Promise executors. It stops at named nested declarations and at sub-unit boundaries a pack declares, following the same rule every body walker takes from `walk/descent.ts`. A decorator's calls run when the class is defined, before the method ever runs, so the walk skips decorators too.

## Module scope is a closure root

A job that a container or a scheduled task runs has no handler. Its entry file opens a pool, calls a couple of its own functions, and exits, all in top-level statements. Pack discovery finds nothing to look for there. Without a root of its own, every query that job runs would end up in no summary at all.

The module-init summary is that root. `moduleInit.ts` records the calls the top-level statements make as invocation effects. It emits the summary when the module either does something a pack recognized or calls a function the project declares. A file whose top level only configures its dependencies still gets nothing. Without that condition, every file in a project would get a summary.

`expandReachableClosure` seeds each module-init summary as an `entry`. The key is the file's extent (`file:0-<end>`), because module scope has no function node to key a declaration on. `collectReachable` then scans the file the way it scans a function body, and `isModuleScopeStop` keeps the descent out of every function and class the module only defines. From there the closure works as usual: `calls` facts, `reachable` derived by the shared rules, and a library summary for each function reached.

A function the module invokes on the spot is the exception to the stop rule. The body of `(async () => { await sync(); })()` runs while the module loads. All three module-scope walks (access recognizers, invocation capture, the closure) read through it, and what it does goes on the module's summary. The call itself is left off the summary, since there is no name behind it for a reader to follow, and the module's summary already has everything the body does.

## Which unfollowed calls leave a gap

A call the closure cannot follow looks exactly like a call that is not
there. Both produce nothing. A reader cannot tell "this handler touches
no storage" from "this handler touches storage through something we
lost". So the closure records the stop as an `unfollowedCall` gap on the
summary of the body that made the call, with the callee and the reason.
`unfollowedCall.ts:classifyStop` makes that decision.

It sorts a stop using the declarations the type checker offers for the
callee, and the function whose body made the call. An imported or
re-exported name is followed through to its last declaration first.
Otherwise a barrel forwarding a dependency's function would look like
project code.

| Reason | What it is | Gap? |
| --- | --- | --- |
| `noBody` | A declaration the project wrote that states a signature and leaves the body to whoever implements it: a method on an interface, an abstract method, an ambient declaration. | yes |
| `unsettledValue` | The project declares the callee as something other than a function: a field, a variable whose initializer is a call, a parameter of some enclosing function. | yes |
| `multipleSources` | The resolution store followed the callee to two different functions. Examples are a fallback whose branches both resolve, or a field two construction sites fill differently. No single body can be followed. The gap records that at the call, so it is not lumped in with the calls that could not be settled at all. | yes |
| `outsideRun` | Every declaration is in a dependency, or inside `declare module "name"`. | no |
| `noDeclaration` | Nothing declares the callee. A call on an untyped value ends up here. | no |
| `callerSupplied` | The callee is a parameter of the function being scanned, so the call runs whatever that function's caller passed in: a middleware's `next`, a callback handed to a higher-order helper. | no |
| `multipleReceivers` | A registration whose receiver comes down to more than one of the pack's own routables. A helper called with two different apps leaves this behind. Discovery records this one, since the call it stopped at is the registration itself. The closure does not. | yes |
| `unresolvedWrapper` | Middleware registered as a call, `app.use(pickMiddleware())`, where the store could not settle on the returned function: the factory has no body, or returns two different functions. The wrapper index records it on every route the registration would have wrapped. A call into a dependency, `app.use(cors())`, is `outsideRun` and leaves nothing. | yes |

The three that leave no gap fail the same test: nothing about any of
them says the callee is code the project wrote. A codebase makes tens of
thousands of calls into its dependencies, and `JSON.parse` in a gap list
buries every stop a reader could act on. The run already describes a
call into another package as a boundary crossing instead of a body, so
leaving it out here loses nothing.

`callerSupplied` is the newest of the three and moves the count the
most. A parameter used to come out as `unsettledValue`. That told a
reader resolution had failed, and sent them looking for a bug that was
not there. A pack declares a middleware's continuation through
`wraps.continuationParam`, so the call to `next` is the call the run
knows most about. Over the whole dogfood pass, 77 of 250 recorded stops
were calls to a parameter of the function being scanned. None of them
was a resolution failure, and none could be fixed, because each caller
decides what runs there.

So `unfollowedCalls` now means one thing: a count of the calls better
resolution could reach. A count of the calls a project makes through a
callback would be a separate measure, and could be added on its own if
anyone wants it.

A third case belongs on the "gap" side and cannot get here yet: a call
whose receiver a pack recognized but whose method it did not, such as a
Redis client calling a command the redis pack has no entry for. A
recognizer returns `null` both for "not my library" and for "my
library, a method I do not know", so telling those apart needs a change
to what a recognizer returns.

A body gets one gap per callee, however many times it calls that
callee. A stop deeper in the call chain stays on the summary where it
happened and does not climb to every caller, so a reader has one place
to look.

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

A hole takes the name of what the caller passed, and the name of the parameter it landed on is dropped. So `keyFor(userId)` reading `` `session:${id}` `` gives `session:{userId}`, which is the name a reader at the call site knows.

A fallback reads differently depending on where it is. At the top of a name, `process.env.TABLE ?? "orders-prod"` reads as the default, because a whole name that is one hole would pair with every table there is. Inside a longer name, `` `${process.env.STAGE || "staging"}-orders` `` keeps the hole. A deployment sets that variable, and the default is what runs when nobody did.

A caller that passes `unsettled: "reference"` gets a hole instead of null when the code says the name is defined somewhere else. Which hole it gets depends on who can be asked about the value.

| Written as | Reads as | Who settles it |
| --- | --- | --- |
| `location.bucket`, `location` a parameter | `{location.bucket}` | whoever called this function |
| `bucket`, a parameter | `{bucket}` | whoever called this function |
| `env.ORDERS_TABLE`, `env` a local or a module const | `{ORDERS_TABLE}` | the deployment that sets the variable |
| `config[which]` | null | nobody, so the name says nothing |

A value that arrived as an argument is looked up at the call sites, so its reference spells out the parameter and every field read inside it. Anything else, such as a local or a field of one, has no call site to look at. Its reference gives what the part is called and leaves settling it to whoever knows. `referenceName` in `@suss/ir-core` writes both kinds, and the checker reads them back with `parseBoundaryName` from the same module. Every hole this reader spells inside a longer name also goes through `patternHole` there, so neither side spells or parses the braces on its own.

An expression this cannot name at all still gives null, since a reference has to say what to look up. `namesNothing` in `@suss/ir-core` keeps a name like that out of pairing, because a name that is one hole would otherwise match every name there is.

A hole inside a longer name works differently and keeps its short name: `` `${stage}-orders` `` reads as `{stage}-orders`. That hole labels the part a deployment fills in. It does not point at someone to ask, and a name with fixed text around it pairs on the fixed text.

Following a helper stops after two hops. It also stops at a body that does more than return one expression, because a name that depends on a branch has no single value.

## Gotchas

- **astResolve and shapes call each other.** `extractShape` (in `shapes/shapes.ts`) calls `resolveNodeFromAst`, and `resolveNodeFromAst` calls `extractShape` back. Each entry to `resolveNodeFromAst` resets its own `seen`/`hops` context, so the cycle detection there does not catch recursion that crosses between the two. `shapes/shapes.ts` has a depth guard local to the module (`MAX_EXTRACT_DEPTH`) as the safety net for self-referential call graphs.
- **The `isInformativeInitializer` filter.** When walking a variable's initializer, we descend only into call, await and new. Those are the cases where the AST tells you something the type checker would not. For example, `const u = await db.find()` returns `T | null`, but past a null guard the use site is only `T`. For other initializers, such as literals and plain expressions, we use the type at the use site.
- **Recognizer errors are isolated.** When a recognizer throws, the error is caught, logged to stderr with file:line, and that call is skipped. Extraction continues, so a buggy recognizer does not crash the run.
- **The closure walk goes one hop.** `reachableClosure` resolves the direct callees of discovered units to library summaries. Transitive throws (`A` throws because `A → B → C` throws) are left to `rethrowEnrichment`, which walks try blocks only one level deep.
- **Terminal dedup compares nodes.** Each invocation effect records the call node it came from, and assembly drops only the calls that are a terminal or a link in a terminal's receiver chain. Two calls on the same line as a terminal, `return [...f(), ...g()]`, both survive.
- **Rethrow lookup goes by line range.** The lookup key is `summary.location.range` (`startLine-endLine`). It does not use the function name or symbol identity. That works because we never have two summaries for the same function at the same line range.

## Sibling modules

- `bootstrap/sourceFileLookup.ts`: `reachableClosure` and `rethrowEnrichment` use it to find summaries by file.
- `shapes/`: `astResolve` and `shapes` call each other recursively, and the depth cap and seen sets keep both bounded.
- `discovery/`: `invocationEffects` runs recognizers against `DiscoveredUnit.func`. The recognizer dispatcher walks the same body the invocation walk does, stopping at `isDescentStop`, so a recognizer fires inside an arrow callback or an IIFE and stops at a named nested declaration.
- `terminals/`: both walk function bodies, but `terminals/` matches against terminal patterns a pack declares, and `invocationEffects` captures everything else.
