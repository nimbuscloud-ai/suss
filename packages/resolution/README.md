# @suss/resolution

The rules for following a value to the function it ends up being.

## What this package is

A list of Datalog rules, and nothing else. It has no parser, no
language, and no files of its own. An adapter reads source into facts,
adds its own rules onto these, and evaluates the whole set on
`@suss/datalog`.

The rules are about programming languages in general rather than about
any one of them. A name binds to a value. A call puts an argument in a
parameter. A module exports a name, and another module can forward it.
A function that returns a function calling its parameter hands back the
argument it was given, which is a decorator in Python, a closure in Go,
and a handler factory in TypeScript.

## The facts an adapter supplies

```
func(f)                     f is a function
objectValue(o)              o is an object written out literally
writtenValue(x)             x is an expression written out in source
                            rather than a name for one
holdsProperty(o, n, x)      object o holds x under the name n
readsProperty(x, o, n)      x is the expression o.n
binds(x, y)                 the name x is declared as y
endsHolding(x, y)           the name x is written more than once and
                            holds y once the writes have run
paramOf(f, k, p)            p is f's parameter at position k
returnsValue(f, v)          f returns v
bodyCalls(f, c)             f's body calls c
containsFn(f, g)            g is declared inside f
call(r, c)                  r is a call whose callee is c
callArg(r, k, a)            r passes a at position k
imports(x, m, n)            x is the name n imported from module m
exportsAs(m, n, v)          module m exports v under the name n
reExports(m, n, m2, n2)     m's n is m2's n2
reExportsAll(m, m2)         m forwards everything m2 exports
```

Two more come from a pack rather than from source, for a wrapper whose
body nobody can read: `unwrapsByName(name, k)` and
`wrapperModule(name, module)`. Both are checked against `calleeName` and
`calleeOrigin`, so a local function that happens to be spelled the same
as the library's does not match.

Node identity is the adapter's business. The rules only join on it.

## What comes out

```
comesTo(x, z)               following x arrives at the value z
resolves(x, z)              comesTo narrowed to functions
isWrittenAs(x, z)           x is written as the expression z
comesFrom(x, m, n)          following x arrives at m's export n
callsInto(f, m, n)          calling f ends up calling m's n
```

`resolves` is the question most callers ask. `comesTo` is the one
underneath it, and it can come back with an object, because a chain has
to pass through objects for `routes.list` to reach whatever `list`
contains.

`isWrittenAs` follows the same names to the expression a value is
written as, whatever kind of expression that turns out to be. A GraphQL
document is neither a function nor an object, so `comesTo` never
reaches one.

`comesFrom` covers the direction `comesTo` cannot. Every `comesTo` chain
ends at something written out in the source suss is reading, so a name
for a library's own function ends nowhere, because the library's body is
not here. `comesFrom` follows the same aliases, imports and barrels, and
comes back with the module plus the name that module exports.

`callsInto` puts that together with the calls a function makes. A
project writes its own decorator that calls `Resolver()` and applies
that one to its classes, and the class is a resolver even though nothing
about it says `Resolver`. Getting several answers for one function is
normal rather than ambiguous, because a wrapper that combines two
library decorators applies both of them, so a caller asks whether the
one it cares about is among them.

One relation exists for the rules' own use rather than for callers:

```
objectOf(x, obj)            x stands for the object literal obj
```

An object arrives two ways, through a name or as what a factory call
returns. `objectOf` gives that step a name, so the rule for
`routes.list` and the rule for `make(body).handle` are the same rule. A
factory call gets an `objectOf` answer without getting a `comesTo`
answer, because a factory call is usually the wrapper itself, and
answering with the function it returns would fight the unwrapping
answer.

## Why rules and not a walker

Each rule describes one hop. The chains people write are longer than
that, and nobody writes a rule for them: a factory handing off to
another factory, a closure three levels down calling the argument, a
barrel re-exporting a wrapper. The engine composes what it has, so all
of those work without anyone writing a rule for them.

That tells you where to look when something comes back empty. Suspect
the facts before the rules. Against one production service, suss
resolved 11 handlers and missed most of what the template declared. The
fix was one condition in fact extraction, and the existing rules found
the rest without any change.

## What is not modelled

**A handler passed as one property of a config.** `make({ body:
handler })`, where the factory reads `opts.body`, does not resolve. We
tried a rule for it and took it back out. A wrapper often reads several
callbacks off the same config object, the rule made each one a
candidate for the whole call, and the ambiguity that produced nulled out
handlers that used to resolve. Working out which property is the handler
needs something the structure does not tell you: either "the only
property that gets called" (which needs negation) or a pack that says
which property it is. Until one of those exists, this pattern stays
unresolved on purpose.

**An element of an array.** `all[0]` has no fact for what an array
contains.

**Which write a read sees, once control flow decides it.** A name
written twice in a module's own statement list does resolve. Those
statements run once each, top to bottom, so the last write is what
anything importing the name gets, and the adapter says so with
`endsHolding`. A write inside a branch, a loop, or a function body is a
different claim, and the adapter says nothing about it. The name then
resolves to nothing, and it stays that way until we have control-flow
facts to reason over.

Answering that in general is reaching definitions, per use rather than
per name. That needs facts saying which statement follows which and
which branch each one is in, and no adapter emits any of those today.

We have the adapter pick the write rather than a rule, and that is a
cost decision. Ordering writes inside the rules means asking which
writes have no later write. Negation says that in one line, but this
evaluator has to throw its last fixpoint away and start over whenever a
rule set uses negation. The store evaluates after every wave of facts,
so one negated rule turned a 66 second run on the Saleor dashboard into
one that had not finished in ten minutes. Source order is something
every adapter already knows.

**Ambiguity is the caller's problem.** When the rules reach two
different functions, the store returns nothing, because picking one
would make the answer depend on the order the facts arrived in.

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).
