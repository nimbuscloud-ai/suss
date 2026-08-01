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

**A value reached through a property.** There is no fact for what an
object literal holds, so all of these come back empty:

```ts
const routes = { list: handler };  export const h = routes.list;
make({ body: handler });           // factory reads opts.body
make(handler).handle;              // factory returns an object
```

Adding it needs a fact for what an object holds and a chain that can
pass through a value that is not a function. The chain rules bottom out
at `func`, so they answer only about functions today. Splitting that
into "what this name comes down to" plus "and it is a function" is what
lets a property access join in the middle, and it makes the rule set
smaller rather than larger.

**Reassignment.** A name assigned twice resolves to the first
assignment rather than to both or to neither.

**Ambiguity is the caller's problem.** When the rules reach two
different functions the store returns nothing, since picking one would
make the answer depend on the order facts arrived in.

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).
