# @suss/resolution

The rules for following a value to the function it comes down to.

## What this package is

A list of Datalog rules and nothing else. No parser, no language, no
files. An adapter reads source into facts, concatenates its own rules
onto these, and evaluates on `@suss/datalog`.

The rules are about programming languages rather than about any one of
them. A name binds to a value. A call puts an argument in a parameter. A
module exports a name and another module can forward it. A function that
returns a function calling its parameter hands back the argument it was
given, which is a decorator in Python, a closure in Go, and a handler
factory in TypeScript.

## The facts an adapter supplies

```
func(f)                     f is a function
objectValue(o)              o is an object written out literally
writtenValue(x)             x is an expression written out in source
                            rather than a name for one
holdsProperty(o, n, x)      object o holds x under the name n
readsProperty(x, o, n)      x is the expression o.n
binds(x, y)                 the name x is declared as y
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
`wrapperModule(name, module)`, checked against `calleeName` and
`calleeOrigin` so a local function spelled like the library's does not
match.

Node identity is the adapter's business. The rules only join on it.

## What comes out

```
comesTo(x, z)               following x arrives at the value z
resolves(x, z)              comesTo narrowed to functions
isWrittenAs(x, z)           x is written as the expression z
```

`resolves` is the question most callers ask. `comesTo` is the one
underneath it, and it can answer with an object, since a chain has to
pass through objects for `routes.list` to reach what `list` holds.

`isWrittenAs` follows the same names to the expression a value is
written as, whatever kind of expression that turns out to be. A GraphQL
document is neither a function nor an object, so `comesTo` never
reaches one.

One relation comes out for the rules' own use rather than for callers:

```
objectOf(x, obj)            x stands for the object literal obj
```

An object arrives two ways, through a name or as what a factory call
returns, and `objectOf` names that step so the rule for `routes.list`
and the rule for `make(body).handle` are the same rule. A factory call
gets an `objectOf` answer without getting a `comesTo` answer, since a
factory call usually is the wrapper and answering with the function it
returns would fight the unwrapping answer.

## Why rules and not a walker

Each rule describes one hop. The chains people write are longer than
that, and nobody writes a rule for them: a factory handing off to
another factory, a closure three levels down calling the argument, a
barrel re-exporting a wrapper. The engine composes what it has, so those
work without being named.

The corollary is where to look when something comes back empty. Suspect
the facts before the rules. A production service once declared 91
handlers and resolved 11; the fix was one condition in fact extraction,
and the rules found the other 79 unchanged.

## What is not modelled

**A handler passed as one property of a config.** `make({ body:
handler })`, where the factory reads `opts.body`, does not resolve. A
rule for it was tried and taken out: production wrappers read several
callbacks off the same config (a log extractor, an error builder, the
handler), the rule made each one a candidate for the whole call, and
ambiguity nulled out sixty handlers that used to resolve. Saying which
property is the handler takes something structure does not carry,
either "the only property called" (which needs negation) or a pack
naming the property. Until one of those exists, this shape stays
unresolved on purpose.

**An element of an array.** `all[0]` has no fact for what an array
holds.

**Reassignment.** A name assigned twice resolves to the first
assignment rather than to both or to neither.

**Ambiguity is the caller's problem.** When the rules reach two
different functions the store returns nothing, since picking one would
make the answer depend on the order facts arrived in.

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).
