# facts

Discovery has to find the function behind an export, and an export is
often not a function. It can be a call to a wrapper factory, an alias of
an alias, a name re-exported through a barrel, or a `.bind`. Two
functions follow those chains:

- `resolveCallable(value)` returns the function a value ends up being.
- `filesImportingTransitively(files, packages)` returns the subset of
  those files that reach any of those packages, following re-exports
  through project files.

## How it works

`extract.ts` walks one source file and writes down what it contains, as
flat tuples: which nodes are functions, what each variable is declared
as, what the file imports and exports, which call passes which argument.
Nothing is resolved at this step. A node's identity is its file path
plus its start and end offsets. A side table maps that identity back to
the ts-morph node, so each answer comes back as something the rest of
the adapter can use.

`store.ts` contains the rules and runs them on `@suss/datalog`. Rules
compose. A handler wrapped twice and then re-exported through a barrel
resolves even though nobody wrote a rule for that combination, and a
walker written per pattern would need its own case for it. So we write
rules.

## Wrapper transparency

`unwraps(f, k)` is the rule that catches the most cases in production
code. If `f` returns a function whose body calls `f`'s parameter `k`,
then calling `f` gives you back argument `k`. That covers factories
written in the project without anyone configuring anything. It also
covers a factory that hands its argument to another factory, and a call
made inside a closure nested in the returned function.

A library wrapper's body is not in the project, so the pack declares the
wrapper instead:

```ts
transparentWrappers: [{ callee: "Sentry.wrapHandler", argument: 0 }]
```

## What a decorator means

`unwraps` tells you what a factory hands back. The other question about
a wrapper is what it is. A class decorated with `@MetadataResolver()` is
a resolver, even though nothing about the class says `Resolver`.

`importedNamesOf(value, modules)` returns the library names behind a
value, and it follows both ways a value can refer to one. In the first,
the value is that name under whatever local spelling it has, as in
`import { Controller as Resource }`. In the second, calling the value
calls that name. A project decorator written as
`(path) => Controller(path)` works that way, and so does one written as
`applyDecorators(Controller(path))`. The pack then checks whether the
framework's own decorator is among the names that come back.

Getting several names back is normal. A wrapper that combines two
library decorators applies both of them, so a caller looks for the one
it cares about instead of expecting a single answer.

The result is memoized against the declaration. One wrapper is applied
across hundreds of files, and the question is about the wrapper itself,
whichever use of it prompted the question.

## A module a generator wrote into the project

A pack's import gate asks whether a file reaches the pack's package.
`filesImportingTransitively` works that out by following the project's
own imports. A file that gets the library through a barrel, or through a
module that built the library's client and exported it, is selected the
same as one that imports the package directly.

A code generator breaks that, because there is no package to import.
Prisma's generator takes an `output` directory, and a project that
points it inside its own tree then writes `import { PrismaClient } from
"../generated/client"`. No specifier anywhere says `@prisma/client`, so
the gate rules every file out and the pack never runs.

`generatedModules.ts` handles that case. A pack declares
`generatedModuleMarkers`, the files its generator leaves beside the
module it wrote. A relative import into a directory containing one of
those files counts as an import of the package. Prisma declares
`schema.prisma`, which its generator copies into the output directory
both at the default location under `node_modules/.prisma/client` and in
a project's own tree. The check costs one `existsSync` per directory a
relative import points at, memoised for the run, and it runs only for
packs that declare a marker.

The pack uses the same marker to decide whether a receiver's type came
from Prisma. The type's declaration file is in the directory the
generator wrote, so a `schema.prisma` in that directory makes the type
Prisma's.

## Cost

A query extracts the file its value lives in, evaluates the rules, and
reads which files the rules are still waiting on. The rules under
`deriveOnDemand` record that as demand facts. The demands on
`moduleExport` and `moduleForwards` with the module column bound point
at files the query has not read yet. The store extracts those files,
evaluates again, and repeats until the rules ask for nothing new. Then
it reads the answer.

So the question decides which files it reads: the value's own file,
plus every module the chain from that value imports through, to any
depth, and nothing else. A value that resolves without leaving its own
file costs one file of extraction. An import of a package resolves to
the package's declaration file, which is read like any other module.
That file's own imports are followed only where a name the chain
reaches is re-exported from them.

Because a query reads only what its question demands, its answer does
not depend on what was asked before it. The store keeps every file it
has extracted in one database, so an earlier query's facts are there
when a later one runs. The wave walk this replaced widened one import
hop at a time and stopped at the first hop that produced a candidate.
Its answer depended on which of two branches an earlier query happened
to have read. Now the demanded closure is read in full before the
answer is taken, so extra facts from earlier queries change nothing the
question reads.

`exportsOf` is the one answer whose order is visible, since discovery
walks the table and emits summaries as it goes. The rounds derive the
table in the order the files arrived. So once the closure is loaded, the
store drops that table and derives it once more from the demand alone.
The order then follows the file's own statements, whatever was read
before.

`SUSS_RESOLUTION_ON_DEMAND=0` runs the rules without the rewrite. With
no demand facts to read, the store follows every import of every file
it extracts. That reads the whole import closure of the value's file,
which is more than the question needs and slow on a large project, but
the answers are the same.

Nearly every file in the project gets asked the gate question, so suss
works it out for all of them at once. `moduleGraph.ts` resolves each
module specifier once, keeps the edge, and derives `reachesPackage` over
those edges with the same engine everything else here runs on. Asking
file by file used to walk the same subtree once for every file that
reached it. On a NestJS monorepo of 6,400 files that came to three
million specifier resolutions for 35,000 distinct edges.

## Reading a caller's file

A query follows the imports of the file it starts in, which is where a
value's definition is. What a caller passed runs the other direction.
The call is in a file that imports this one, and no rule demands a file
by who imports it, so the query never gets there.

`ResolutionStore.extractFiles` reads a set of files before any question
is asked, so their facts are already in the store. Route discovery uses
it for the file set the active packs apply to. That is how an app built
in one file and registered on in another gets joined up. A run whose
packs register nothing reads nothing extra.

`argumentsPassedTo(parameter)` needs this most. It returns every call of
the function the parameter belongs to, with the argument that call wrote
at it, exactly as the caller wrote it and before any settling. `paramAt`
settles the value through `comesTo`, which stops at a function or an
object, so a parameter given a GraphQL document has no `paramAt` answer
at all. The caller reads the argument itself, since it knows what kind
of value it is looking for. With this, one project hook in front of
`useQuery` turns into one operation per component.

`callsPassing(parameter)` asks the reverse, and it uses facts already in
the store, with no need to read the caller's file first. It returns
every call in the parameter's own function, or in a closure inside it,
that hands the parameter to something else. Take a helper that reads an
environment variable through a parameter its own caller only forwards,
`wrap(name) { return read(name); }`. You find it by asking what `wrap`'s
parameter is passed to, then asking the same of `read`'s.

`envNamers(project)` asks the same question from the other end, for a
reader standing at a call: which parameters does an environment read
take its variable's name from? The store reads the files that write the
environment object and finds the helpers whose parameter becomes a
variable's name. Then it reads every file that reaches one of those
helpers' files, since a helper that only forwards its parameter has to
import the one it forwards to. Reach is transitive, so a forwarder of a
forwarder is in that set too, and one round is enough. The result is
worked out once per run and does not depend on which call asked first.
The reader asks at every call to a project function. Reading the
callee's file at each of those calls would read thousands of files on a
large service to find one helper.

`isEnvironmentValue(value)` asks whether a value is the environment
object. A reader holding the argument of a schema parse uses it. A
parameter is the environment when some caller hands it the object. The
same run works out which parameters those are by going forward from the
files that write the environment. Each call that hands the object on
has its callee read, one hop a round, until no new call turns up.
Asking from the parameter instead would read every file that reaches
the parameter's own file. For a service most of the project imports,
that is most of the project.

The REST client wrappers use the same question. A generated HTTP client
builds its request out of a parameter, so the path and the verb at the
library call are holes. The store returns the calls that filled that
parameter, and the evaluator runs again with the parameter bound to what
each caller wrote. The round repeats outward while a hole is left. A
client nobody calls directly comes out as one request per service
method.

`returnsCall(func, call)` is the other half of that reading. It asks
whether running the function hands that call back, so a wrapper that
forwards the library's result can be told apart from one that returns
something of its own. It is `isWrittenAs` asked of what the function
returns. A result written into a name first gives the same answer, and a
result handed to a function the rules cannot follow does not.

The callers are in files that import the parameter's own file, so those
get read first. `ModuleGraph.filesReachingFile` returns the files in a
candidate set that reach a given file, directly or through a barrel. It
uses the same rule as package reachability, with a file in place of the
package. The candidates are the files `notePossibleCallers` was given,
and the adapter fills that with the files its packs apply to. Without
it, the store falls back to every file the project has loaded outside
`node_modules`.

On the caller's side, the facts come from the call itself: `call` and
`callArg`. Extraction otherwise follows a file's exports, and
`registerRoutes(app)` is written as a statement, so those calls are
recorded separately. Only calls spelled `name(args)` are recorded. A
method call is left out, because method calls are most of the calls in a
body, and writing down every argument of every one of them slows a run
measurably.

## How a value reaches the place it is used

Discovery asks the fact layer what a value at a given position is,
instead of reading whatever syntax happens to be there.
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
positions. An object literal emits the same fact, so the property rule
covers both without knowing anything about arrays.

Three do not:

- **A call's return.** `const pick = () => handler; router.get("/p",
  pick())`. A rule saying a call comes to what the callee returns would
  give a wrapper factory a second answer alongside the one `unwraps`
  gives, and two answers resolve to nothing. Telling the two apart needs
  the rule to ask whether the callee unwraps. That is negation over a
  relation derived from the rule itself, and it does not stratify.
- **A factory's object argument.** `const built = build({ handle:
  handler })`, where `build` returns `options.handle`. This is the rule
  that was tried and taken out, described above.
- **A parameter, unless the caller's file has been read.** `const
  register = (handle) => router.get("/p", handle)`. Whoever calls
  `register` supplies the function. That call is in a file that imports
  this one, and a query following imports never reaches it. A caller
  that already knows the file set can read it first; see "Reading a
  caller's file" above.

## What it over-approximates

`unwraps` asks whether the returned function calls a parameter. It does
not ask whether the wrapper behaves like that parameter. So a guard
factory, `requireRole(check)`, resolves to the predicate instead of to
the route it guards, and `instrument(onDone)` resolves to the callback.

Most of that looseness comes from the nested-closure hop. Most of the
recall comes from it too: dropping it on a production serverless
monorepo took summaries from 304 to 139, so it stays.

When two arguments both qualify, suss treats it as a failure and does
not guess. `resolveCallable` returns null when the rules reach two
different functions, since picking one would make the answer depend on
the order the facts arrived in.

Nothing here models conditional exports or scope-sensitive dataflow.
Discovery filters what comes back, and the precision is recovered there.

Reassignment is modelled where control flow cannot change the answer. A
name written straight through a module's statement list ends up with its
last write. An importer sees that value, so that is the fact the
extractor writes down. A write under a branch, in a loop, or in a
function body could run any number of times. For those the extractor
writes nothing down, and the name resolves to nothing instead of to
whichever write came first.

## Why a written value has to be an expression

`resolveWrittenValue` returns the expression a value was written as,
and it returns null when there are two of them. One chain produces two
candidates that are one value:

```ts
const command = new GetObjectCommand({ Bucket: "uploads", Key: key });
```

`command` is written as the construction. The rules also read a
construction as arriving at an instance, so the chain runs one more step
to the class `GetObjectCommand`. A class is an object value, which is a
stopping point for this question too. Both candidates describe the same
value: one is the expression that made it, the other is the class it is
an instance of.

The second candidate exists only once the file declaring the class has
been extracted, and facts stay in the store after the query that pulled
them in. So the same question gave different results when asked on its
own and when asked after an unrelated query. It returned the
construction the first time and null the second, with nothing about the
code changed in between. Requiring the answer to be an expression drops
the class, because a class declaration is not an expression, and the
question is what the source wrote the value as. A caller that wants the
class asks `resolveObject`.

One answer can still depend on what was read before it: a parameter's
value. The argument step runs from a call to the parameter it fills, and
the call is in a file that imports this one, which no demand asks for.
So a parameter resolves to whatever the files read so far pass it. A
caller who knows the file set uses `extractFiles` to make that the same
every time; see "Reading a caller's file" above.

## When something does not resolve

Suspect the facts before the rules.

Every rule here describes one hop. A factory chain three deep, a closure
two levels down, a barrel re-exporting a wrapper: nobody wrote a rule
for any of those, and all of them work, because the engine composes
what it has. So when something comes back null, the usual cause is a
fact the extractor never wrote down. A missing rule is less likely.

A production service showed this. Against it, suss resolved 11 of the
handlers the deployment template declared and missed the rest. Those
went through a factory in another package that reached its argument
from inside a closure written as an arrow without braces, and the
extractor skipped the body of any arrow written that way. Fixing one
condition in extraction let the existing rules find every handler that
had a body to find.

The same reasoning applies in reverse. If smaller rules can build up a
pattern between them, try deleting the rule that spells that pattern
out. A pattern with its own rule is one the inference never had to get
right. The shorthand-arrow body used to be described twice, once in the
walk and once next to it, and the copy next to it is what hid the
closure above. Deleting it meant making the walk cover the one node it
could not see, which is less code to keep correct.

## Why a reassigned default export says nothing

`export { x }` exports the live binding, so an importer reads whatever
the last write left in `x`. `export default x` runs once and takes the
value `x` has at that moment. A write after the statement changes the
binding but not the default. The facts record only a binding's last
write (`endsHolding`). That is correct for an export list and wrong for
a default whose name is written again afterwards. So the emitter states
a default through its declaration only when the name is written once.
For a reassigned one it states nothing, since the value would depend on
statement order and it would have to guess.
