# facts

Discovery has to find the function behind an export, and an export is
often not a function. It is a call to a wrapper factory, an alias of an
alias, a name re-exported through a barrel, or a `.bind`. This directory
answers two questions about those chains:

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
compose, which is the point: a handler wrapped twice and then re-exported
through a barrel resolves even though nobody wrote a rule for that
combination.

## Wrapper transparency

The rule that earns the most is `unwraps(f, k)`: if `f` returns a
function whose body calls `f`'s parameter `k`, then calling `f` gives
you back argument `k`. That covers factories written in the project
without anyone configuring anything, including a factory that hands its
argument to another factory, and a call made inside a closure nested in
the returned function.

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

A factory that calls its parameter and also returns some other function
still resolves to the argument. Reassignment, conditional exports, and
scope-sensitive dataflow are not modelled. Discovery's own filters keep
the precision downstream.
