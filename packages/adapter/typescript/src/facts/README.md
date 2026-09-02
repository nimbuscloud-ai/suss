# facts

Discovery has to find the function behind an export, and an export is
often not a function. It is a call to a wrapper factory, an alias of an
alias, a name re-exported through a barrel, or a `.bind`. Two functions
follow those chains:

- `resolveCallable(value)` gives the function a value ends up being.
- `filesImportingTransitively(files, packages)` gives the subset of
  those files that reach any of those packages, following re-exports
  through project files.

## How it works

`extract.ts` walks one source file and writes down what it contains, as
flat tuples: which nodes are functions, what each variable is declared
as, what the file imports and exports, which call passes which argument.
Nothing is resolved here. A node's identity is its file path plus its
start and end offsets, and a side table maps that identity back to the
ts-morph node, so an answer comes back as something the rest of the
adapter can use.

`store.ts` has the rules and runs them on `@suss/datalog`. Rules
compose, so a handler wrapped twice and then re-exported through a
barrel resolves even though nobody wrote a rule for that combination.
That is why we write rules rather than one walker per pattern.

## Wrapper transparency

`unwraps(f, k)` is the rule that catches the most cases in production
code. If `f` returns a function whose body calls `f`'s parameter `k`,
then calling `f` gives you back argument `k`. That covers factories
written in the project without anyone configuring anything, including a
factory that hands its argument to another factory, and a call made
inside a closure nested in the returned function.

A library wrapper's body is not in the project, so the pack has to make
the call instead:

```ts
transparentWrappers: [{ callee: "Sentry.wrapHandler", argument: 0 }]
```

## What a decorator means

`unwraps` tells you what a factory hands back. The other question about
a wrapper is what it is. A class decorated with `@MetadataResolver()` is
a resolver, even though nothing about the class says `Resolver`.

`importedNamesOf(value, modules)` answers that, and it covers both ways
a value can refer to a library name. Either the value is that name,
whatever it is spelled as locally, which covers `import { Controller as
Resource }`. Or calling the value calls that name, which covers a
project decorator written as `(path) => Controller(path)` and one
written as `applyDecorators(Controller(path))`. The pack then asks
whether the framework's own decorator is among the names that come back.

Getting several names back is normal. A wrapper that combines two
library decorators applies both of them, so a caller asks about the one
it cares about instead of expecting a single answer.

The answer is memoized against the declaration, since one wrapper is
applied across hundreds of files and the question is about the wrapper
rather than about any use of it.

## Cost

A query extracts the file its value lives in, evaluates the rules, and
reads what they are waiting on. The rules under `deriveOnDemand` say so
as demand facts, and the demands on `moduleExport` and `moduleForwards`
with the module column bound are the ones that name a file the query
has not read. The store extracts those files, evaluates again, and
repeats until the rules ask for nothing new. Then it reads the answer.

The files a question reads are therefore fixed by the question: the
value's own file, plus every module the chain from that value imports
through, to any depth, and nothing beside them. A value that resolves
without leaving its own file costs one file of extraction. An import of
a package resolves to the package's declaration file, which is read
like any other module, and its own imports are followed only where a
name the chain reaches is re-exported from them.

Reading only what the question demands is what makes a query's answer
the same whatever was asked before it. The store keeps every file it
has extracted in one database, so an earlier query's facts are there
when a later one runs. The wave walk this replaced widened one import
hop at a time and stopped at the first hop that produced a candidate,
so the answer depended on which of two branches an earlier query
happened to have read. With the demanded closure read whole before the
answer is taken, the extra facts change nothing the question reads.

`exportsOf` is the one answer whose order is visible, since discovery
walks the table and emits summaries as it goes. The rounds derive the
table in the order the files arrived, so after the closure is loaded
the store drops that table and derives it once more from the demand
alone. That order follows the file's own statements, whatever was read
before.

`SUSS_RESOLUTION_ON_DEMAND=0` runs the rules without the rewrite, and
with no demand facts to read the store follows every import of every
file it extracts instead. That reads the whole import closure of the
value's file, which is more than the question needs and slow on a large
project, but it gives the same answers.

Nearly every file in the project gets asked the gate question, so suss
works it out for all of them at once. `moduleGraph.ts` resolves each
module specifier once, keeps the edge, and derives `reachesPackage` over
those edges with the same engine everything else here runs on. Asking
file by file used to walk the same subtree once per file that reached
it: on a NestJS monorepo of 6,400 files that came to three million
specifier resolutions for 35,000 distinct edges.

## Reading a caller's file

A query follows the imports of the file it starts in, which is where a
value's definition is. What a caller passed is the other direction: the
call is in a file that imports this one, and no rule demands a file by
who imports it, so the query never arrives there.

`ResolutionStore.extractFiles` reads a set of files before anything asks
a question, so those facts are already in the store. Route discovery
uses it for the file set the active packs apply to, which is how an app
built in one file and registered on in another is joined up. A run whose
packs register nothing reads nothing extra.

The facts on the caller's side are the call's own: `call` and `callArg`.
Extraction otherwise follows a file's exports, and `registerRoutes(app)`
is written as a statement, so those calls are written down separately.
Only a call spelled `name(args)` is; a method call is left out, since
those are most of the calls in a body and writing every argument of
every one of them down slows a run measurably.

## How a value reaches the place it is used

Discovery asks the fact layer what a value at a given position is,
rather than reading whatever syntax happens to be there.
`router.get("/users", listUsers)` is how an Express codebase usually
writes it, and the syntax at the argument is an identifier.

Generation turned up eleven ways a handler can reach its registration.
These resolve:

| How it reaches | Example |
| --- | --- |
| written there | `router.get("/p", (req, res) => {})` |
| a name | `router.get("/p", handler)` |
| a property read | `router.get("/p", routes.list)` |
| an array index | `router.get("/p", routes[0])` |
| an alias | `const alias = handler` |
| an import | `import { handler } from "./unit.js"` |
| a barrel | one re-export in between |
| two barrels | two |

An index resolves because an array stores its elements under their
positions, which is the same fact an object literal emits, so the
property rule covers both without knowing anything about arrays.

Three do not:

- **A call's return.** `const pick = () => handler; router.get("/p",
  pick())`. A rule saying a call comes to what the callee returns would
  give a wrapper factory a second answer alongside the one `unwraps`
  gives, and two answers is nothing. Telling the two apart needs the
  rule to ask whether the callee unwraps, which is negation over a
  relation derived from the rule itself, and that does not stratify.
- **A factory's object argument.** `const built = build({ handle:
  handler })`, where `build` returns `options.handle`. This is the rule
  that was tried and taken out, described above.
- **A parameter, unless the caller's file has been read.** `const
  register = (handle) => router.get("/p", handle)`. Whoever calls
  `register` supplies the function, and the call is in a file that
  imports this one, which a query following imports never reaches.
  A caller that already knows the file set can read it first; see
  "Reading a caller's file" below.

## What it over-approximates

`unwraps` asks whether the returned function calls a parameter, not
whether the wrapper's behavior is that parameter's behavior. So a guard
factory, `requireRole(check)`, resolves to the predicate rather than to
the route it guards, and `instrument(onDone)` resolves to the callback.

The nested-closure hop is where most of that looseness comes from, and
it is also where most of the recall does. Dropping it on a production
serverless monorepo took summaries from 304 to 139, so it stays.

Two arguments both qualifying is the one case suss treats as a failure
rather than guessing. `resolveCallable` returns null when the rules
reach two different functions, since picking one would make the answer
depend on the order the facts arrived in.

Nothing here models conditional exports or scope-sensitive dataflow.
Discovery filters what comes back, and that is where the precision comes
back.

Reassignment is modelled where control flow cannot change the answer.
A name written straight through a module's statement list ends up with
its last write, which is what an importer gets, and that is the fact
the extractor writes down. A write under a branch, in a loop, or in a
function body could run any number of times, so the extractor writes
nothing down, and the name resolves to nothing rather than to whichever
write came first.

## Why a written value has to be an expression

`resolveWrittenValue` gives back the expression a value was written as,
and it returns null when there are two of them. One chain produces two
candidates that are not two values at all:

```ts
const command = new GetObjectCommand({ Bucket: "uploads", Key: key });
```

`command` is written as the construction. The rules also read a
construction as arriving at an instance, so the chain runs on one more
step to the class `GetObjectCommand`, and a class is an object value,
which is a stopping point for this question too. Both candidates
describe the same value: the expression that made it, and the class it
is an instance of.

That second candidate only exists once the file declaring the class has
been extracted, and facts stay in the store after the query that pulled
them in. So the same question answered on its own and answered after an
unrelated query gave different results: the construction the first
time, null the second, with nothing about the code changed in between.
Requiring the answer to be an expression drops the class, because a
class declaration is not an expression, and the question is what the
source wrote the value as. `resolveObject` is the question that wants
the class.

One question stays open to what was read before it: a parameter's
value. The argument step runs from a call to the parameter it fills,
and the call is in a file that imports this one, which no demand asks
for. So a parameter resolves to whatever the files read so far pass it, and
`extractFiles` is how a caller who knows the file set makes that the
same every time; see "Reading a caller's file" above.

## When something does not resolve

Suspect the facts before the rules.

Every rule here describes one hop. A factory chain three deep, a
closure two levels down, a barrel re-exporting a wrapper: nobody wrote
a rule for any of those, and all of them work, because the engine
composes what it has. So when something comes back null, it usually
means the extractor never wrote down a fact the rules needed, not that
a rule is missing.

A production service made the point. Against it, suss resolved 11 of
the handlers the deployment template declared and missed the rest.
Those went through a factory in another package that reached its
argument from inside a closure written as an arrow without braces, and
the extractor skipped the body of any arrow written that way. One
condition in extraction, and the existing rules found every handler
that had a body to find.

The same reasoning runs the other way. If smaller rules could build up
a pattern between them, the rule that spells that pattern out is worth
trying to delete, because a pattern with its own rule is one the
inference never had to get right. The shorthand-arrow body used to be
described twice, once in the walk and once next to it, and the copy
next to it is what hid the closure above. Deleting it meant making the
walk cover the one node it could not see, which is a smaller thing to
keep correct.

## Why a reassigned default export says nothing

`export { x }` exports the live binding, so an importer reads whatever
the last write left in `x`. `export default x` runs once and takes the
value `x` has at that moment; a write after the statement changes the
binding but not the default. The facts only record a binding's last
write (`endsHolding`), which is the right claim for an export list and
the wrong one for a default whose name is written again afterwards. So
the emitter states a default through its declaration only when the name
is written once, and says nothing about a reassigned one, keeping quiet
over guessing a value that depends on statement order.
