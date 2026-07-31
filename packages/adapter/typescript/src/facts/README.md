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

## Cost

Facts arrive in waves. A query extracts the file its value lives in and
asks; only if the answer is missing does it widen to the files that file
imports, up to six hops. A value that resolves without leaving its own
file costs one file of extraction. The gate question does not go through
the rules at all: it is a walk over module specifiers, memoized per gate
set, because deriving every file's reachable-module set to answer one
boolean is far more work than the question is worth.

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
