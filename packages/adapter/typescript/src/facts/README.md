# facts

Discovery has to find the function behind an export, and an export is
often not a function. It is a call to a wrapper factory, an alias of an
alias, a name re-exported through a barrel, or a `.bind`. Two functions
follow those chains:

- `resolveCallable(value)` gives the function a value ends up being.
- `importsTransitively(file, packages)` says whether a file reaches any
  of those packages, following re-exports through project files.

## How it works

`extract.ts` walks one source file and writes down what it contains, as
flat tuples: which nodes are functions, what each variable is declared
as, what the file imports and exports, which call passes which argument.
Nothing is resolved here. A node's identity is its file path plus its
start and end offsets, and a side table maps that identity back to the
ts-morph node, so an answer comes back as something the rest of the
adapter can use.

`store.ts` holds the rules and runs them on `@suss/datalog`. Rules
compose, so a handler wrapped twice and then re-exported through a
barrel resolves even though nobody wrote a rule for that combination.
That is the reason to write rules rather than one walker per pattern.

## Wrapper transparency

`unwraps(f, k)` is the rule that finds the most in production code. If
`f` returns a function whose body calls `f`'s parameter `k`, then
calling `f` gives you back argument `k`. That covers factories written
in the project without anyone configuring anything, including a factory
that hands its argument to another factory, and a call made inside a
closure nested in the returned function.

A library wrapper's body is not in the project, so a pack states the
judgment instead:

```ts
transparentWrappers: [{ callee: "Sentry.wrapHandler", argument: 0 }]
```

## What a wrapper stands for

`unwraps` answers what a factory hands back. The other question a
wrapper raises is what it is: a project decorator that calls
`@Resolver()` marks a resolver, whatever it is called.

`importedCallsOf(value, modules)` answers that. It follows the value to
the function behind it, then reports the names that function ends up
calling from those modules, through the closures it declares and through
another wrapper it delegates to. The pack asks whether the framework's
own decorator is among them.

The answer is memoized against the declaration, since one wrapper is
applied across hundreds of files and the question is about the wrapper
rather than about any use of it. The caller also has to be sure the
value is worth asking about: a query that finds nothing still walks the
import closure, which pulls files into the program and changes what the
type checker reports for shapes read later. Decorator discovery asks
only about a decorator the project itself declares, which is the only
kind that can have a readable body.

## Cost

Facts arrive in waves. A query extracts the file its value lives in and
asks; only if the answer is missing does it widen to the files that file
imports, up to six hops. A value that resolves without leaving its own
file costs one file of extraction. The gate question does not go through
the rules at all: it is a walk over module specifiers, memoized per gate
set, because deriving every file's reachable-module set to answer one
boolean is far more work than the question is worth.

## How a value reaches the place it is used

Discovery asks the fact layer what a value at a given position is,
rather than reading the syntax sitting there. `router.get("/users",
listUsers)` is the ordinary spelling in an Express codebase, and the
syntax at the argument is an identifier.

Eleven ways a handler can reach its registration turned up in
generation. These resolve:

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

An index resolves because an array holds its elements under their
positions, which is the same fact an object literal emits, so the
property rule answers both without knowing about arrays.

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
- **A parameter.** `const register = (handle) => router.get("/p",
  handle)`. Whoever calls `register` supplies the function, and this
  file cannot see where it came from.

## What it over-approximates

`unwraps` asks whether the returned function calls a parameter, not
whether the wrapper's behavior is that parameter's behavior. So a guard
factory, `requireRole(check)`, resolves to the predicate rather than to
the route it guards, and `instrument(onDone)` resolves to the callback.

The nested-closure hop is where most of that looseness comes from, and
it is also where most of the recall does. Dropping it on a production
serverless monorepo took summaries from 304 to 139, so it stays.

Two arguments both qualifying is the one case treated as a failure
rather than a guess. `resolveCallable` returns null when the rules reach
two different functions, since picking one would make the answer depend
on the order facts arrived in.

Reassignment, conditional exports, and scope-sensitive dataflow are not
modelled at all. Discovery filters what comes back, which is where the
precision is recovered.

## When something does not resolve

Suspect the facts before the rules.

Every rule here describes one hop. A factory chain three deep, a
closure two levels down, a barrel re-exporting a wrapper: none of those
is written down, and all of them work, because the engine composes what
it has. So a shape that comes back null usually means the extractor
never wrote down something the rules needed, not that a rule is
missing.

A production service made the point. Against it, suss resolved 11 of
the handlers the deployment template declared and missed the rest.
Those went through a factory in another package that reached its
argument from inside a closure written as an arrow without braces, and
the extractor skipped the body of any arrow written that way. One
condition in extraction, and the existing rules found every handler
that had a body to find.

The same reasoning runs the other way. A rule that names a shape which
smaller rules could compose is worth trying to delete, because a shape
handled by its own rule is a shape the inference never had to get
right. The shorthand-arrow body used to be described twice, once in the
walk and once beside it, and the copy beside it is what hid the closure
above. Deleting it meant making the walk cover the one node it could
not see, which is a smaller thing to keep correct.
