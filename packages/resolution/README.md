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
fallbackBranch(x, b)        x is a fallback expression and b is one
                            of its branches
paramOf(f, k, p)            p is f's parameter at position k
paramNamed(f, n, p)         p is f's parameter called n
extends(c, b)               class c is written as extending b
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

`holdsProperty` is something an adapter states and the rules only read.
What a value contains, a base class included, comes out as `contains`,
so a method a base declares is found on a subclass that never overrode
it. Deriving that into `holdsProperty` instead turns it from a fact into
a derived relation, and the on-demand rewrite then gates it behind a
demand nothing generates.

Node identity is the adapter's business. The rules only join on it.

## One relation of steps

Every construct states its hops once, in one relation:

```
stepsTo(x, y, kind)         following x leads to y in one hop
reaches(x, z, kind)         the closure of those hops
```

A value step goes to the value x is written as: a name to its
declaration, an import to what the module exports, a parameter to what a
call passes it, a property read to what the object contains under that
name, a construction to the class, a transparent wrapper to the argument
it wraps. A result step goes the other way, from a call to what the
function it invokes returns. A walk counts as a result walk once it has
run a call anywhere along it, which is what keeps a factory call out of
the answers that stop at a value.

A language with a hop of its own states it as a step too. JavaScript's
`.bind` and Ruby's `Const.new` are each one rule, and every question
below picks them up without being told.

A fallback expression (`a || b`, `a ?? b`, Python's `a or b`) says its
value is one of its branches, so each branch is a value step. That is
the whole rule. When one branch is something no static reader can
settle, a global cache or a parameter, that branch derives nothing, and
the branch that does resolve is the only claim the source makes. The
idiomatic client singleton, `global.prisma || new PrismaClient()`, is
exactly this: the global read makes no claim, so the construction is
the answer. When both branches resolve to different things, both
derive, and the caller's single-answer policy refuses the pair. That is
the same refusal every other two-candidate chain gets, because a value
that is one of two different things is not one thing.

Each question is that one closure with its own stopping condition. So
adding a construct is one step and every question gets it, and adding a
question is a stopping condition and no steps at all.

The closure is written with the walk so far first and the next hop after
it: `reaches(x, z) <- reaches(x, y), stepsTo(y, z)`. The order matters
under demand. Every question here asks about one value, and with the
walk first, the demand stays on that value and each round extends the
walks it already has by one hop. Written hop first, `reaches(x, z) <-
stepsTo(x, y), reaches(y, z)`, a question about `x` becomes a question
about every `y` a hop leads to, so the closure is derived from every
value the walk passes through, and each new walk is joined back against
every hop that lands on its start. Extracting the TypeScript adapter's
own sources, the hop first order spent two seconds in the closure, and
the walk first order spends forty milliseconds.

## What comes out

```
comesTo(x, z)               following x arrives at the value z
resolves(x, z)              comesTo narrowed to functions
givesBack(x, z)             following x arrives at a call that returns z
isWrittenAs(x, z)           x is written as the expression z
comesFrom(x, m, n)          following x arrives at m's export n
callsInto(f, m, n)          calling f ends up calling m's n
paramAt(r, p, z)            the call r puts z in the parameter p
```

`resolves` is the question most callers ask. `comesTo` is the one
underneath it, and it can come back with an object, because a chain has
to pass through objects for `routes.list` to reach whatever `list`
contains.

`givesBack` is the other direction of function application. `comesTo`
says what a value comes down to, and it stops at a call on purpose: a
factory call is usually the wrapper itself, so resolving it to the
function it returned would fight the unwrapping answer. That leaves
nobody able to ask what a call returned, which is the whole question
when a factory builds a dependency. `givesBack` asks it, over the same
steps and with the same stopping condition, of the walks that ran a
call.

Both directions run at once without interfering, because they answer
different questions about the same call. `const dao = makeDao()` comes
to nothing and gives back the class `makeDao` constructed, so
`dao.findByCustomer` finds the method that class declares while
`withAuth(handler)` still comes to `handler`.

`isWrittenAs` follows the same names to the expression a value is
written as, whatever kind of expression that turns out to be. A GraphQL
document is neither a function nor an object, so `comesTo` never
reaches one.

`comesFrom` covers the direction `comesTo` cannot. Every `comesTo` chain
ends at something written out in the source suss is reading, so a name
for a library's own function ends nowhere, because the library's body is
not here. `comesFrom` walks the same steps and stops at the import
instead, so it comes back with the module plus the name that module
exports.

`paramAt` is the one question that keeps the call it went through.
`comesTo` merges call sites, so a function called from two places leaves
its parameter with two values and a caller wanting one gets nothing.
`paramAt` says which call put which value there.

`callsInto` puts that together with the calls a function makes. A
project writes its own decorator that calls `Resolver()` and applies
that one to its classes, and the class is a resolver even though nothing
about it says `Resolver`. Getting several answers for one function is
normal rather than ambiguous, because a wrapper that combines two
library decorators applies both of them, so a caller asks whether the
one it cares about is among them.

Two relations exist for the rules' own use rather than for callers:

```
objectOf(x, obj)            x stands for the object literal obj
invokes(r, f)               the call r runs the function f
```

An object arrives two ways, through a name or as what a factory call
gives back. `objectOf` gives that step a name, so the rule for
`routes.list` and the rule for `make(body).handle` are the same rule.
This is where the two directions meet: a factory call gets an
`objectOf` answer without getting a `comesTo` answer.

`invokes` is the callee half of `givesBack`, kept apart so the case
where the callee is itself a call, `daoBuilder()()`, is one rule rather
than a copy of every other. It differs from `callsFunction`, which
starts from the function because a caller asking for call sites has the
function in hand.

## The anchor behind a receiver

A pack sometimes wants a call handed back, not a yes or no. Mongoose is
the picture: `model("User", schema)` is the anchor, and the pack reads
the model name and the collection off that call's own arguments. The
receiver in front of a matched method can be the model, a construction
of it (`new User({...})`), or a document a query returned
(`await User.findById(id)`), and each is a different number of hops
from the anchor.

`anchorChain` is the reachability that covers all three. From an asked
value (`wantedAnchor`) it follows names (`binds`, `endsHolding`,
`fallbackBranch`), imports through the export table, a call to its
callee, and a method's callee to its receiver. Every call the chain
passes lands in `wantedAnchorCall`, keyed by the asked value.

Candidates, not one answer: the chain has no way to rank a nearer call
above a farther one, and ranking inside the rules would be a depth
bound in a new spelling. The asking side filters the candidates against
its own origin (which module, which callee name) and applies the
single-answer policy: exactly one distinct match is the anchor, none or
several is a refusal.

The demand cone stays on the base facts named above. Nothing here pulls
`reaches` or `callsInto`, so asking about a receiver does not price in
call-graph closure.

## The subject behind a registration

Discovery keeps asking one question: is this receiver the app, the
router, the thing built by calling what a library exports? Which
`.get(...)` calls are routes and which `.use(...)` calls are mounts
both hang on the answer, and every language feature that moves a value
is a place the receiver can be written: a class field, a destructured
name, a property on an object another file built. Enumerating those
spellings in a walker loses to the language, so the question is asked
of the rules instead.

The answer comes back in two relations, both seeded by
`wantedSubject`.
`wantedSubjectWritten` is the written-value walk from the asked
receiver, so the asking side can apply the single-answer policy over
everything the receiver could be. `wantedSubjectConstruction` keeps
only the answers that are a call or a `new`, and pairs each with where
its callee was imported from, through however many aliases the callee
went. The asking side checks that pair against the (module, name) a
pack declares: exactly one distinct construction with a matching
origin is the subject, none or several is a refusal.

The construction end needs no fact of its own. Every call is already a
`call` fact, a `new` expression included, and the join against
`comesFrom` is what makes one of them a subject seed.

## Explaining an answer

Evaluate the same rules under `@suss/datalog`'s `witnesses` algebra and
every derived fact keeps the rule that fired and the facts it consumed,
so `proofOf` can rebuild the derivation tree of any answer on demand.
`explainResolutionProof` flattens that tree into the chain a person
reads: the step rules are the hops, `reaches` is the glue between them,
and the base cases ("x is already a function") end a chain without
adding to it. Each hop comes back with one sentence saying why it is
true, written from the rule's own name: `alias`, `import`, `argument`,
`factory unwrap`, and so on.

Two kinds of detail ride under a hop rather than beside it. A barrel
chain under an `import` hop lists which files forwarded the name. A
`declared wrapper` hop rests on a pack's word rather than on source, so
it surfaces as an assumption: "a pack declares that withSentry from
@sentry/serverless passes argument 0 through to its result". A proof
cut short by the depth cap says so instead of trailing off.

Atoms in a proof are whatever node ids the adapter interned, so both
functions take a `describe` callback that says an atom in source terms.
`renderExplanation` turns the flattened chain into printable lines;
`suss ask 'why does … reach …'` is this pipeline end to end.

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

## Changing a rule

Every rule here composes with every other one, so a change meant for one
construct lands on chains nobody had in mind. `@suss/resolution-fuzz`
generates four thousand fact bases, runs these rules over each, and
compares what came out against a committed baseline, which is what turns
a change into a diff a reviewer reads. Run `npm run resolution:baseline`
to accept one, and commit the rewritten file with the rule.

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
