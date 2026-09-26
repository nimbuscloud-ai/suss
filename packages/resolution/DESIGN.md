# How resolution follows a value

An adapter supplies facts about the source it read. The rules in `@suss/resolution` build one relation of steps over those facts, and callers read their answers out of it. The [README](./README.md) explains what the package is for.

## The facts an adapter supplies

Every relation an adapter adds to the store has a line below, and so
does every relation a rule reads that no rule derives. Before adding a
fact, look here for one that already says what you need. After adding
one, give it a line in its group. `npm run check:fact-vocabulary` fails
when a relation is missing, and when a line is left for a relation that
nothing emits or reads any more.

Every adapter keys an expression on its node: the file path and the
node's start and end offsets. The TypeScript adapter keys a name that
way too, and links each reference to its declaration with `binds`. The
Python and Ruby adapters key a name on the scope that declares it plus
the name, so every read of one name is the same key and needs no
`binds` row. `refersToParam` accepts both spellings of a parameter
read. A position or a count is written as a decimal string.

A line that ends by naming adapters is a fact only those adapters
emit. The rest come from all three.

Values and objects:

```
func(f)                     f is a function
objectValue(o)              o is an object written out: a literal, or a
                            class, whose properties are its methods
writtenValue(x)             x is an expression written out in source
                            rather than a name for one
placeholderValue(x)         x is a written value a later write is
                            expected to replace, such as None or nil.
                            singleAnswers reads it, and no rule does
                            (Python, Ruby)
holdsProperty(o, n, x)      object o has x under the name n
holdsDefault(cls, n, x)     cls's body gives its field n the value x,
                            which a constructor may replace (Python)
readsProperty(x, o, n)      x is the expression o.n, or o[n] with the
                            key written out
readsKeyed(site, o, x)      site reads the entry of o at the value of
                            x, where the source does not write the key
                            out
environmentObject(w)        w is written as the process environment
```

Names:

```
binds(x, y)                 the name x is declared as y, or x is a
                            reference to the declaration y
endsHolding(x, y)           the name x is written more than once and
                            is left with y once the writes have run.
                            valueLeftByWrites picks y
mayHold(x, y)               one write to x wrote y, and nothing says
                            which write ran last (Python, Ruby)
writesAllStated(x)          every write to x states a value, so the
                            mayHold rows for x are all of them
                            (Python, Ruby)
writesUnstated(x)           a write to x states no value at all. The
                            value readers in this package read it, and
                            no rule does (Python, Ruby)
fallbackBranch(x, b)        x is a fallback expression, a || b or
                            a ?? b, or a or b in Python and Ruby, and b
                            is one of its branches
instanceOf(x, cls)          x is one of cls, and nothing says which: a
                            method's receiver, or a name Python
                            annotates with a type. cls can be a name
                            that leads to the class
```

Functions and parameters:

```
paramOf(f, k, p)            p is f's parameter at position k. A class
                            lists its constructor's parameters here
paramNamed(f, n, p)         p is f's parameter called n
paramDefault(p, d)          p takes the value d when a caller passes no
                            argument at all (TypeScript)
returnsValue(f, v)          f returns v
returnsClass(f, c)          f is annotated as returning c, and its body
                            states no value of its own
                            (TypeScript, Python)
returnsNamed(f, n)          f's return annotation is written n, stated
                            when returnsClass is. Nothing reads it yet
                            (TypeScript, Python)
containsFn(f, g)            g is declared inside f
initializes(cls, f)         f runs when one of cls is made
storesProperty(f, n, x)     f's body writes x to the receiver's n
```

Calls:

```
call(r, c)                  r is a call whose callee is c, keyed as the
                            value the callee is written as
callArg(r, k, a)            r passes a at position k
callKeywordArg(r, n, a)     r passes a under the keyword n
                            (Python, Ruby)
callArgCount(r, k)          r is written with k arguments, keyword ones
                            and a splat included (Python)
callOutsideMethod(r)        the call r is outside every method body
bodyCalls(f, c)             f's body calls the callee c, keyed the way
                            call keys that call's callee
makesCall(f, r)             the call r is written in f's own body. The
                            TypeScript adapter states it only for a
                            callee written as a name or a property read
entersAs(y, r)              y is the name a block opens over the call
                            r, so entering r is what wrote y (Python)
```

Classes:

```
extends(c, b)               class c is written as extending b. Ruby
                            records a module c includes the same way
prepends(c, m)              the Ruby class c prepends the module m, whose
                            methods Ruby looks up before c's own (Ruby)
extendsNamed(c, n)          class c's base is written n, which is how a
                            pack matches a library base that no node in
                            the run declares. Only a base written as a
                            name or a dotted name has one
declaresName(c, n)          c declares a method n under a name the
                            source computes rather than writes out
                            (Ruby)
declaresAssociation(c, n, t)  class c declares an association n, and t
                            refers to the class it targets (Ruby)
fieldCall(c, n, callee, t)  c's field n is given a call of callee, and
                            t refers to the class n is about (Python)
classCallback(c, event, n)  c's body registers its own method n to run
                            on event (Ruby)
```

Modules:

```
imports(x, m, n)            x is the name n imported from module m. n
                            is * for the whole module and default for
                            its default export. A global that only
                            library declarations declare is imported
                            from GLOBAL_MODULE under its dotted name
                            (TypeScript, Python)
exportsAs(m, n, v)          the file m exports v under the name n
reExports(m, n, m2, n2)     m's n is m2's n2 (TypeScript)
reExportsAll(m, m2)         m forwards everything m2 exports
                            (TypeScript)
importsModule(f, m)         the file f imports the module m, as written.
                            A pack reader asks whether a file imports
                            its library with it, and no rule reads it
                            (Python)
importsFile(f, g)           the file f depends on the file g in the run:
                            an import that resolved to g in Python, and
                            in Ruby a require_relative of g or a
                            constant g defines. No rule reads it, and
                            the run lists each file's dependencies from
                            it with importedFilesByFile (Python, Ruby)
```

A pack states what it knows about its own library as words. Each
adapter converts its own pack type to `PackWords`, and `addPackWords`
adds these facts:

```
givesBackOne(base, m)       m on a class whose ancestry reaches the base
                            written base gives back one of that class
                            (Python, Ruby)
givesBackOneOfArgument(base, m, k)  the same, with the class passed at
                            position k (Python)
givesBackOneOfImport(mod, n, k)  the same, for the function n that
                            module mod exports, called on its own
                            (Python)
entersAsSelf(mod, n)        entering one of module mod's n gives back
                            that same object (Python)
unwrapsByName(mod, n, k)    calling the n that module mod exports gives
                            back its argument at k. The TypeScript store
                            adds Object.assign under GLOBAL_MODULE on
                            every run
associationConstructor(mod, n)  a field given a call of the n that
                            module mod exports declares an association
                            (Python)
returnsReceiver(m)          calling a method named m hands back the
                            object it was called on. Each adapter adds
                            its language's own: bind in TypeScript,
                            freeze and dup in Ruby (TypeScript, Ruby)
```

A caller asks a question by adding a row to one of the relations in
`ASKING_RELATIONS`, such as `wanted(x)`. No rule derives those, and
the questions in `RESOLUTION_QUESTIONS` are the rules that read them.

Some relations are one adapter's own. The adapter adds them to the
same store and reads them itself, or through a rule of its own, and no
shared rule reads them:

```
rbConstantName(c, q)        the constant defined at c is called q in
                            full, with every namespace around it (Ruby)
definesMethodFrom(c, x)     c's body calls define_method, and x is the
                            argument that gives the method its name. The
                            adapter settles x and states declaresName
                            (Ruby)
nameTurnsOn(x, element, index, over)  the name x is written in a loop
                            block that binds element, and index when it
                            has one, to each item of over (Ruby)
entry(u)                    discovery found the unit u. The reach
                            closure keeps its own copy, and nothing
                            reads this one (Python, Ruby)
```

`declaresName` is the only fact an adapter records after asking these
rules a question first. Ruby's `define_method(key)` puts a method on a
class under a name the source never writes out. Python's
`setattr(cls, name, fn)` and a computed class member in TypeScript do
the same, and neither of those adapters records one yet. The Ruby
adapter records where the name comes from and settles it through the
value evaluator, which reads these same facts. Then it records the name
it got. `wantedDeclaredName` returns that name next to the names written
out, so a caller asking which methods a class declares does not need to
know which kind each one is.

Another fact comes from a pack, for a wrapper whose body is not in the
source suss reads: `unwrapsByName(module, name, k)`. The rule matches a
call whose callee `comesFrom` that module and name, the same way every
other pack word keys on an import. So a namespace import matches
whatever the project calls it, and a local function with the same name
as the library's does not match. `comesFrom` reads a member of a
default import the way it reads a member of a namespace import, since a
CommonJS module hands its exports over as the default: after
`import React from "react"`, `React.memo` is react's `memo`, whether or
not React's types are installed.

The callee reaches the import through `comesFrom`, which follows the
`imports` facts, so those have to name the package however the import
reached it. The TypeScript adapter writes an import once under each
spelling: the resolved file, the specifier as written, its package part
(`pkg/esm` is `pkg`), and every package the imported declaration lives
in, which is what a project barrel hides. A declaration a library's own
`.d.ts` file makes at the top of a module or namespace is recorded as
that library's name too. That covers a member of a namespace a barrel
re-exports, a member of a default import of a module written with
`export =`, and a global a package declares. The Python adapter writes
every import under the module as written, and under the file as well
when the import resolves to one.

A global the language declares has no module at all, so the adapter
records a callee that only library declaration files declare under
`GLOBAL_MODULE` and its dotted name: `Object.assign` comes from
`global`'s `Object.assign`. The TypeScript store declares
`Object.assign` as handing back argument 0 on every run, as behavior of
the language rather than of a pack.

`Object.assign({}, a, b)` copies onto the empty object and hands that
back, and the empty literal describes none of what the call returns. So
the rule takes the step only when the argument describes a value: a
function, a written value, an object with something in it, an import, or
a name that steps somewhere. A negated `objectValue` would say it more
directly, but the demand rewrite refuses any negation, so
`describesValue` lists the kinds that do. An object written with
properties stays in, since a pack's wrapper can hand one back as it is:
`createRoute({ method, path })` in `@hono/zod-openapi` is the route.

Every fact a pack declares goes in through `addPackWords`, which takes
the declarations in one format for every language. Each adapter
converts its own pack type to that format. A new pack word is then
written once, in this package, and every language gets it.

A third pack fact exists for the same reason. `givesBackOne(base, m)`
means that calling `m` on a class whose ancestry reaches the base
written as `base` returns one of that class. A Rails finder needs it:
the library declares `find`, and the project's model never mentions it.
`libraryBase` walks `extends` up to the name that no node in the run
defines, so a model two or ten classes below `ActiveRecord::Base`
matches the same way. The step ends on the class again, so steps chain:
`Account.where(x)` is one Account, and `first` read off that is one
Account too.

Matching on the base keeps out a project class on an unrelated
hierarchy that writes its own `find`. The declared wrapper matches on
the module its callee comes from for the same reason. A class that
overrides a declared method gets two steps: the declared one, and the
one through the method it wrote. When the method it wrote returns one
of the class, the two steps agree and the caller sees one answer. When
it returns something else, the caller sees two answers, and its
single-answer policy refuses the pair. Letting the written method win
would need a negated literal on `contains`. Since `contains` is derived
from `comesTo`, the rule set would stop being stratifiable. The
on-demand rewrite refuses any negation anyway, before the engine gets as
far as stratifying.

SQLAlchemy and SQLModel take the class as an argument instead of as the
receiver: `session.get(User, id)`, `session.query(User)`,
`select(User)`. Two more pack facts cover that.
`givesBackOneOfArgument(base, m, k)` means that calling `m` with a
class that reaches the base at position `k` returns one of that class.
`givesBackOneOfImport(module, n, k)` means the same for a function
called by itself, such as `select(User)`. The first matches on the base
the argument reaches, which keeps a call of `dict.get` out. The second
matches on the module the function was imported from, as the declared
wrapper does, because a project can write a `select` of its own.

Once the class is settled, the rest of the chain works like a Rails
finder, and `givesBackOne` covers it. `where`, `filter` and `order_by`
return one of the class, and so do `first`, `one` and `all`.

`libraryBase` finds the name in three ways: a base the source writes as
a name (`extendsNamed`), a base that some project class in between
extends, and a base a library returns from a call. The last is
SQLAlchemy's `Base = declarative_base()`, where the walk stops at the
call and the imported function is the name to match on.

Every language with models has associations: a field on one class whose
value is one or many instances of another. Rails declares one as
`has_many :statuses`, and SQLModel as
`items: list[Item] = Relationship(...)`. In both, reading that name off
an instance returns the other model. An adapter can record an
association in one of two ways, and both end up in `contains`.

An adapter that reads the declaration itself records
`declaresAssociation(cls, n, t)`. Here `t` is a reference that the
run's own bindings settle on the target class. In some languages the
declaration is an ordinary assignment. An adapter for one of those
records `fieldCall(cls, n, callee, t)` for every class-body field whose
value is a call, and a pack declares which callable makes that field an
association with `associationConstructor(module, name)`. The rule joins
the callee through `comesFrom`, as the declared import finder does, so
a project function named `relationship` matches nothing. The adapter
records the field in either case and a rule decides whether it is an
association, so the adapter does no matching of its own.

Both kinds feed `contains` instead of a step of their own, because
`contains` already walks the ancestry. A model that gets its
associations from a concern or a base class declares them too, and a
property read already steps to whatever `contains` returns. The target
is the class itself, so a finder chains on from there:
`@account.statuses.find(id)` is one Status.

They feed `contains` directly, with no relation in between that defines
an association. `declaresAssociation`, `fieldCall` and
`associationConstructor` stay as facts that an adapter records and the
rules only read, like `holdsProperty`. If one of an adapter's relations
also had a rule deriving it, the demand rewrite would empty it between
questions, and the adapter's facts would go with it. The rewrite is
allowed to do that to any relation derived on demand.

No fact records whether an association is a collection. A relation and
a single record settle on the same class today, in the same way that
`Account.where(x)` and `Account.find(x)` both do, so no rule needs the
difference.

`holdsProperty` is a fact that an adapter records and the rules only
read. What a value contains, including what its base classes contain,
is derived as `contains`, so a method a base declares is found on a
subclass that never overrode it. Deriving those rows into
`holdsProperty` would turn it into a derived relation, and the on-demand
rewrite would then fill it only in answer to a demand that nothing
generates.

A method that a subclass overrides is contained twice, once from the
subclass and once from its base. Preferring the subclass's own would
need a negated `contains`, which the demand rewrite refuses. So the rules
record the override beside `contains`, and the caller picking one answer
applies it:

```
overrides(m, n, h)          a class declares m under the name n itself,
                            and one of its bases contains h under n
readsOverridden(x, obj, h)  the read x finds h on obj, and obj contains
                            a member that overrides h
readsFrom(x, obj, n)        the read x reads n off obj
readsMemberOn(x, obj, h)    the read x finds h on obj, listed for a read
                            that readsOverridden has a row for
```

`withoutOverridden` sets h aside when every object the read finds it on
also contains an override, and only when another answer is left. The
objects come from `readsFrom` before `contains` is asked, so it is asked
with the object and the name bound, as the property read step asks it.
Asked with h bound first, it listed every subclass and allocation site
that contains h, and the full mastodon run ran out of memory. The
object matters. A parameter that one caller passes an `Accounts` and
another a plain `Repository` finds `Repository.save` on the plain one
with nothing overriding it, so the read keeps both methods and a caller
that needs one refuses it. `answersFor`, the callee outcomes, each
adapter's reads of `wantedResolves`, and the proof pass behind
`suss ask why` all apply it, so they give the same answer.

Ruby looks a method up in the modules a class prepends before the class
itself. So a prepended module is recorded as `prepends` rather than as
`extends`, which would make the class's own method override it. The
module's members reach the class through a `contains` rule of their own,
the ancestry chain follows the prepend, and a prepended module's member
overrides both the class's own member and whatever the class inherits.

Two cases keep both methods. A class with two bases that each write the
method, where Python's method order would pick the first, and a Ruby
class whose included modules both write it.

## What an instance reads

A class body can assign two kinds of value, and they reach an instance
differently:

```python
class Account(SQLModel):
    TABLE = "accounts"            # shared by every instance
    is_admin: bool = False        # where each construction starts

def admin(account: Account):
    if not account.is_admin:
        ...
```

`TABLE` is one value, and every instance reads it however the instance
was built, so the adapter records it as `holdsProperty` and it is part
of `contains`. `is_admin` is a field default. The library generates a
constructor that fills it from an argument, and that constructor is not
in the run, so the run cannot tell what `account.is_admin` is. The
adapter records it as `holdsDefault`, which `contains` does not read.

`fieldDefault` walks the ancestry of `holdsDefault` the way `contains`
walks `holdsProperty`. A construction contains its class's field
defaults only when `callArgCount` says the call passes no arguments.
Any argument could fill a field, a splat included, and telling which
field an argument fills would need the constructor. A finder's result
is not a construction of this kind, since the library built it
somewhere else. `objectOf` goes from a call to such a construction when
the call hands one back, as `get_settings()` hands back `Settings()`,
because the class it finds for the call doesn't contain the field
defaults.
It starts from `callArgCount`, so a project whose adapter records no
count pays one lookup per returned value and nothing more.

`callArgCount` states how many arguments a call writes. A rule can only
match on a fact that is present, so "passes nothing" needs a fact of its
own, and the count is the plainest one that says it. `callArg` and
`callKeywordArg` list what a call passes and never what it leaves out.

Only the Python adapter records either fact. A TypeScript field
initializer is already a store on the class's constructor, which every
instance reads. A Ruby class body's constants and instance variables
belong to the class and never to one of its instances.

The adapter assigns node ids, and the rules only join on them.

## One relation of steps

Every construct's hops go into one relation:

```
nameHop(x, y)               the name x has the value y without running
                            anything: its declaration, its last write,
                            one of several writes, or a fallback branch
hop(x, y, kind)             following x leads to y in one hop
stepsTo(x, y, kind)         every hop, stated again, plus the two a
                            receiver context replaces
reaches(x, z, kind)         the closure of those steps
reachesUnder(x, c, z, c2, kind)   the same closure under one site
```

Each hop is written twice, once as a `hop` and once as a `stepsTo`,
instead of one being derived from the other. A demand for `stepsTo` is
one of the largest relations a run derives, and deriving all of it
through `hop` would copy every row. The name steps are the exception.
Every chain that follows a name reads `nameHop`, and so do the `hop`
and `stepsTo` rules for a value step. Rows read went down on all four
projects measured when the name steps moved to `nameHop`, because the
chains stopped listing the hops one by one.

A value step goes to the value x is written as: a name to its
declaration, an import to what the module exports, a parameter to what a
call passes it, a property read to what the object contains under that
name, a construction to the class, a transparent wrapper to the argument
it wraps. A result step goes the other way, from a call to what the
function it invokes returns. A walk counts as a result walk once it has
run a call anywhere along it, which keeps a factory call out of the
results that stop at a value.

A hop that only one language has is written as a step too. JavaScript's
`.bind` and Ruby's `Const.new` are one rule each, and every question
below uses them with no change.

The value of a fallback expression (`a || b`, `a ?? b`, Python's and
Ruby's `a or b`) is one of its branches, so each branch is a value step.
No other rule is involved. An adapter records a fallback by its branches
alone. Recorded as a written value as well, the fallback would be one
more answer to `isWrittenAs` beside its branches. Ruby's `x ||= y` needs
no fallback of its own, because the adapter already records it as a
write of `y` to `x`. A Ruby side that calls `raise` or `fail` hands back
no value, so `find(id) || raise(NotFound)` has one branch. When a branch is something no static reader can
settle, such as a global cache or a parameter, that branch derives
nothing. The branch that does resolve is then the only claim the source
makes. The usual client singleton, `global.prisma || new PrismaClient()`,
works this way: the global read makes no claim, so the construction is
the answer. When both branches resolve to different things, both
derive, and the caller's single-answer policy refuses the pair. Every
other chain with two candidates gets the same refusal, since the value
could be either one.

A value is read the same way. `os.environ.get("API_PREFIX") or "/api"`
is written as two expressions, the call and the literal, and a reader
that wants one expression gets none. `fallbackBehind(x, f)` lists the
fallbacks a value passes on the way, including through a call to a
function that returns one. When every expression a value is written as
came through one fallback, `writtenValueOf` returns the fallback, and
the value evaluator reads it with its own `or`. A branch the evaluator
cannot read makes no claim, so the example reads as `/api`, and two
branches it can read are joined. A caller that wants each expression
asks `writtenValuesOf`, which still lists both branches.
`writtenValueUnder` reads a value under one allocation site the same
way, through `fallbackBehindUnder`, so `self.base = base or "/api"`
means the same thing whether the read has a site or not.

Every question is this one closure with its own stopping condition.
Adding a construct means adding one step, and every question picks it
up. Adding a question means writing a stopping condition, with no new
steps.

### Under one allocation site

`reachesUnder` has two more columns: the site the walk started under,
and the site that whatever it arrived at is read under. A context is an
allocation site or the constant `none`. Three hops differ from the
context-free ones:

- The receiver under a site is that site, so a field read inside a
  method is the field of the construction the question named.
- A property read goes on under the site the object was made at. That
  is the object's own site, which can differ from the one the question
  named.
- A parameter goes on at the arguments of the calls that run its
  function under that site. `entersUnder` lists those calls. A
  construction runs its constructor under the site it makes. A method
  call runs under the site its receiver is. A call written as a plain
  name runs under the site the body around it has. Every other call
  runs with no site, which takes every caller the way `argument` does.

`callsNamed` is the half of `callsFunction` that finds a callee through
a name it binds to. The other half finds it through a property read off
a receiver. Both halves produce `callsFunction` rows, so nothing
context-free changes, and `entersUnder` reads the name-bound half by
itself. A call written as a name runs with whatever receiver the body
around it has, so a walk can follow it without leaving the site.

`callUnder` gives the site a call is made under. For a call in a method
or constructor, that is the class the method belongs to. For a call in
a plain function, it is the site that function was entered under, so a
chain of plain functions called from one method keeps the site.
`callUnder` is recursive through `entersUnder` and positive, which the
demand rewrite allows. `makesCall` says which body a call is written
in. Joining `bodyCalls` against `call` would give the same answer in
TypeScript, which keys each callee on its own node, but Python and
Ruby key a callee written as a bare name on that name. Every call of
`url(...)` in a file would then count as made in every body that calls
`url`, and a literal one function passes would show up under a site
that never made the call. `callOutsideMethod` is the fact an adapter
records for a call written at module level, in a plain function, in a
class body, or in a static method. It is a fact instead of a negation
because the rewrite refuses negation.

The context covers one level of receiver and no more. Where a call is
made outside every method body the site is lost, and the walk takes
every caller. Conditions are not evaluated either, so
`env === "prod" ? a : b` gives both branches.

`askResolutionUnder` asks the question, and `isWrittenAsUnder`,
`comesToUnder` and `objectOfUnder` read the answers. `objectOfUnder`
returns a site, because a context is a site, and `objectOf` does not.

The three questions run on their own program, `resolutionUnderProgram`.
Because the ordinary program does not have to answer them, the rewrite
drops every rule behind them there, and a run that never mentions a
context derives none of the second closure. This matters because the
engine reads every rule once a round. The thousand rules the rewrite
makes of `reachesUnder` took two and a half times the wall time of a
whole extraction when they were measured.

The closure is written with the walk so far first and the next hop after
it: `reaches(x, z) <- reaches(x, y), stepsTo(y, z)`. The order matters
under demand. Every question here asks about one value. With the walk
first, the demand stays on that value, and each round extends the walks
it already has by one hop. Written hop first,
`reaches(x, z) <- stepsTo(x, y), reaches(y, z)`, a question about `x`
becomes a question about every `y` a hop leads to. The closure is then
derived from every value the walk passes through, and each new walk is
joined back against every hop that lands on its start. On the
TypeScript adapter's own sources, the closure took two seconds with the
hop first and takes forty milliseconds with the walk first.

## What comes out

```
comesTo(x, z)               following x arrives at the value z
resolves(x, z)              comesTo narrowed to functions
givesBack(x, z)             following x arrives at a call that returns z
givesBackUnwrapped(x, z)    givesBack, where the call returned unwraps z
isWrittenAs(x, z)           x is written as the expression z
fallbackBehind(x, f)        following x to what it is written as passes
                            the fallback f
comesFrom(x, m, n)          following x arrives at m's export n
callsInto(f, m, n)          calling f ends up calling m's n
paramAt(r, p, z)            the call r puts z in the parameter p
passesArgument(r, p, a)     the call r writes a at the parameter p
returnsCall(f, c)           running f hands back the expression c
```

`resolves` is the question most callers ask. `comesTo` is the one
underneath it, and it can return an object, because a chain has to pass
through objects for `routes.list` to reach whatever `list` contains.

`givesBack` follows function application in the other direction.
`comesTo` finds what a value comes down to, and it stops at a call on
purpose. A factory call is usually the wrapper itself, so resolving it
to the function it returned would contradict the unwrapping answer. On
its own, though, `comesTo` gives no way to ask what a call returned, and
when a factory builds a dependency, that is the question that matters.
`givesBack` answers it over the same steps and with the same stopping
condition, for the walks that ran a call.

The two directions run together without interfering, because they are
different questions about the same call. `const dao = makeDao()` comes
to nothing and gives back the class `makeDao` constructed. So
`dao.findByCustomer` finds the method that class declares, while
`withAuth(handler)` still comes to `handler`.

The two directions do meet one hop further out. `const useOrders = (c)
=> asyncHandler(async (req) => ...)` returns a call to a wrapper, and
once a walk has run `useOrders("orders")`, the step into
`asyncHandler(...)` and the unwrapping step to the async arrow both
count as result walks. So `givesBack` comes back with two functions:
the closure `asyncHandler` builds around its argument, and the argument
itself. `givesBackUnwrapped` is the second one alone. It asks `comesTo`
of each call the result walk arrives at, which stops at the unwrapped
argument and never runs the wrapper. A caller asks it after `comesTo`
and before `givesBack`.

Stating the preference as a negation, a call result that fires only
when the callee does not unwrap, would put `unwraps` under a negation
inside the recursion that derives it, which the demand rewrite refuses.
Writing the same rule with `comesTo` as its head, so the preference
`comesTo` already has over `givesBack` would cover it, breaks a
factory that hands off to another factory. `createEvent(config, body)`
returns `makeBatch(config, parse, body)`, and `makeBatch` unwraps both
`parse` and `body`. `comesTo` of the outer call already settles on
`body` through `flowsToParam`. Crossing the result step as well adds
the `parse` callback, and the value then comes to two functions and
resolves to nothing. Kept as its own relation, the new answer is asked
only once `comesTo` has declined.

`isWrittenAs` follows the same names to the expression a value is
written as, whatever kind of expression that is. A GraphQL document is
neither a function nor an object, so `comesTo` never reaches one.

`comesFrom` handles the case `comesTo` cannot. Every `comesTo` chain
ends at something written out in the source suss is reading. A name for
a library's own function has nowhere to end, because the library's body
is not in that source. `comesFrom` walks the same steps but stops at the
import, and returns the module and the name that module exports.

`paramAt` is the only question that keeps track of the call it went
through. `comesTo` merges call sites: a function called from two places
has two values for its parameter, and a caller that wants one value
gets nothing. `paramAt` returns which call put which value there.

`passesArgument` is the hop underneath `paramAt`, and a caller can ask
for it directly. `paramAt` settles the value through `comesTo`, so a
parameter given a GraphQL document gets no answer at all.
`passesArgument` returns the argument as the calling code wrote it, and
leaves reading it to the code asking, which knows what kind of value to
expect.

Both go through `callsFunction`, which starts from the function and
finds the calls that reach it. A function written as
`const f = (x) => ...` comes in two pieces: the name is the
declaration, and the parameters belong to the arrow function the
declaration is bound to. `callsFunction` therefore follows one `binds`
hop out of whatever a call arrives at, so a function reached through its
name is the same function as one reached directly.

A callee that a factory returned needs one more rule.
`const requireEnv = makeReader(env)` binds the name to a call, with no
function at all, so one rule joins the two:
`callsFunction(r, f) :- returnsValue(g, f), callsFunction(r0, g), callsNamed(r, r0)`.
The rule starts from the factory's own call, which `callsFunction` has
already settled, so nothing new starts from the call made through the
name.

`returnsCall` asks `isWrittenAs` about what a function returns. A caller
uses it to tell a wrapper that returns the library's call directly from
one that returns something of its own. A result assigned to a name
first and then returned gives the same answer. A call whose own callee
the rules cannot follow does not count.

`callsInto` combines that with the calls a function makes. A project
can write its own decorator that calls `Resolver()` and apply that
decorator to its classes. Each of those classes is a resolver, even
though `Resolver` appears nowhere on it. Several answers for one
function are expected, because a wrapper that combines two library
decorators applies both, so a caller checks whether the one it cares
about is among them.

Two relations are for the rules' own use, and callers do not read them:

```
objectOf(x, obj)            x is the object literal obj
invokes(r, f)               the call r runs the function f
```

A walk reaches an object in two ways: through a name, or as what a
factory call returns. `objectOf` covers both, so `routes.list` and
`make(body).handle` go through the same rule. The two directions meet
here, because a factory call gets an `objectOf` answer without getting a
`comesTo` answer.

`invokes` is the callee half of `givesBack`. It is a separate relation
so that a callee that is itself a call, as in `daoBuilder()()`, needs
one rule instead of a copy of every other rule. It differs from
`callsFunction`, which starts from the function, because a caller
asking for call sites already has the function.

## A read of the environment

A service that reads its configuration through one helper writes no
variable name at the read:

```ts
function makeReader(env: NodeJS.ProcessEnv) {
  return (name: string) => env[name];
}
const requireEnv = makeReader(process.env);
const table = requireEnv("TABLE_NAME");
```

When an adapter emits facts, it cannot tell that `env[name]` reads the
environment. It records the two things it can see: `readsKeyed` for a
read off any container, and `environmentObject` for the expression that
spells `process.env`. `environmentValue(w, o)` walks outward from the
object, through the names declared as it and the parameters that
callers pass it to, however many calls deep. A parameter whose default
is the environment counts too, because a caller that passes nothing
leaves the default in place. The adapter records that default as
`paramDefault(p, d)`. `environmentRead` joins the walk to a keyed read,
`readsEnvNamed` is the same relation without the object column, and
`paramNamesEnv` lists the parameters that end up as a variable's name.

`wantedEnvObject` seeds the question from the environment object. A
project writes that object in a handful of places, while the read a
helper makes can be anywhere, somewhere no scan of the source would
look. Starting from the object, every join runs in the direction it was
built for: `refersToObject` from the object, `passesArgument` from the
argument through `callArg`, and `paramNamesEnv` from the site to its
callers.

A caller that already has one expression asks in the other direction.
`wantedEnvironmentValue(o, w)` binds the expression and leaves the
object free, so a pack looking at `cleanEnv(source, schema)` can ask
about `source` alone. For that adornment the demand rewrite reverses
every join. The walk runs from the argument to the parameter it refers
to, out to that parameter's callers, and on until it reaches an
`environmentObject` or runs out of callers. The store exposes this
question as `isEnvironmentValue`.

## A type the callers declare

A helper often takes a session, a client or a connection without
saying what it is, because the code that calls it already did:

```python
def read_order(session: SessionDep, order_id: int):
    return get(session=session, order_id=order_id)

def get(*, session, order_id):
    return session.query(Order).filter(Order.id == order_id).first()
```

A recognizer that reads the annotation at the call site finds nothing
on `get`. The adapter records `instanceOf(x, t)` for every annotated
parameter and every annotated assignment. `x` is the key of the name,
and `t` is the key of the name or expression the annotation is written
as. An unannotated helper reaches that class through the argument step,
the same way it reaches any other value its callers pass, so a method
called on its parameter resolves to the one the class declares. "What
an instance reads" says why a field default does not come with it.

`typedAs` gives a value the class its own declaration states, and the
class of anything the value reaches by value steps. The argument step
is one of those, so a chain of unannotated helpers gets the type the
outermost caller declared. A name declared as a typed one, a fallback
with a typed branch, and a reassigned name that ends holding a typed
value get it the same way. `typedAs` has no walk of its own. It is a
stopping condition on `reaches`, like `comesTo` and `isWrittenAs`. It
stops at the declaration rather than at every class an instance step
reaches, because a caller that constructs its argument reaches the
class by an instance step too, and that class has no import to compare
against a declared one.

`wantedType` seeds the question, and the answers come back in four
relations: the types (`wantedTypedAs`), every argument passed directly
to the parameter (`wantedTypePassed`), the ones among those that have a
type (`wantedPassedTypedAs`), and the ones that are a parameter of the
caller (`wantedPassedParam`). `declaredTypesOf` reads all four.

When a direct caller passes a value it built or read, with no type, the
parameter could be anything that caller had, so the answer is none. A
caller that passes on its own parameter is treated differently. That
parameter's callers either declare a type, which arrives through
`typedAs`, or make no claim, in the same way that a fallback branch
which settles on nothing makes none. The common case is a helper that
nothing in the run calls, and refusing there would refuse every helper
it calls. Applying the same check to a caller further out would need
`not typedAs`, which the rewrite refuses, so only the direct callers
are checked.

Two callers can declare different types, and two type keys can be the
same class written two ways: `Session` in one file and an alias of it
in another. Only the adapter can tell whether they are the same, by
asking where each key comes from. So `declaredTypesOf` returns every
key it found, and the adapter applies the single-answer policy to what
those keys refer to.

## The anchor behind a receiver

Sometimes a pack needs the call itself back, and a yes or no is not
enough. Mongoose is an example: `model("User", schema)` is the anchor,
and the pack reads the model name and the collection off that call's
own arguments. The receiver in front of a matched method can be the
model, a construction of it (`new User({...})`), or a document a query
returned (`await User.findById(id)`). Each is a different number of
hops from the anchor.

`anchorChain` is the reachability relation that covers all three.
Starting from the value asked about (`wantedAnchor`), it follows the
name hops (`nameHop`), imports through the export table, a call to its
callee, and a method's callee to its receiver.
Every call the chain passes goes into `wantedAnchorCall`, keyed by the
value asked about.

The chain returns candidates instead of one answer. It has no way to
rank a nearer call above a farther one, and ranking inside the rules
would amount to a depth bound written another way. The asking side
filters the candidates against its own origin (which module, which
callee name) and applies the single-answer policy: exactly one distinct
match is the anchor, and none or several is a refusal.

The demand stays on the base facts listed above. Nothing here pulls in
`reaches` or `callsInto`, so asking about a receiver does not pay for
the call-graph closure.

## The subject behind a registration

Discovery asks one question over and over: is this receiver the app,
the router, the thing built by calling what a library exports? The
answer decides which `.get(...)` calls are routes and which `.use(...)`
calls are mounts. Any language feature that moves a value is a place
the receiver can be written: a class field, a destructured name, a
property on an object another file built. A walker that lists those
spellings one by one falls behind the language, so discovery asks the
rules instead.

The answer comes back in two relations, both seeded by
`wantedSubject`. `wantedSubjectWritten` is the written-value walk from
the receiver asked about, so the asking side can apply the
single-answer policy over everything the receiver could be.
`wantedSubjectConstruction` keeps only the answers that are a call or a
`new`, and pairs each with where its callee was imported from, through
however many aliases the callee went. The asking side checks that pair
against the (module, name) a pack declares: exactly one distinct
construction with a matching origin is the subject, and none or several
is a refusal.

The construction end needs no fact of its own. Every call, `new`
expressions included, is already a `call` fact, and the join against
`comesFrom` picks out the ones that seed a subject.

Every call is written as itself. This is the same base case that makes a
class its own ancestor at the top of the chain. So when an adapter asks
`wantedSubjectWritten` about a call directly, the answers include the
call itself as well as whatever the walk reaches. A call with one other
answer would then count as two and be refused as ambiguous.
`singleAnswers` drops the row whose answer is its own key before
counting, and every adapter reads the relation through it.

A name that is set to a placeholder until a guard fills it in also has
two answers, for example `_client = None` at module level and
`_client = make_client()` inside a getter. An adapter marks the
placeholder write with `placeholderValue(x)` and passes those keys to
`singleAnswers`, which sets them aside whenever the key has another
answer. A name written only as a placeholder keeps that answer.
`valueLeftByWrites` sets `null` and `undefined` aside in the same way
when it compares the writes to a name.

A name bound to a call is a separate case. Its only answer is the call.
The rule that treats a call as written as what its callee returns fires
only for the call itself, and never for a name that reaches the call. An
adapter that needs the deeper answer asks `wantedSubject` a second time
with the call as the subject, and uses that answer. The TypeScript store
does this in `resolveWrittenValue` and in `subjectConstructionOf`
whenever a name resolves to a call.

## Explaining an answer

When the same rules are evaluated under `@suss/datalog`'s `witnesses`
algebra, every derived fact keeps the rule that fired and the facts it
used, so `proofOf` can rebuild the derivation tree of any answer on
demand. `explainResolutionProof` flattens that tree into a chain a
person can read. The step rules become the hops, `reaches` connects
them, and the base cases ("x is already a function") end a chain without
adding a hop. Each hop comes with one sentence explaining why it is
true, generated from the rule's own name: `alias`, `import`,
`argument`, `factory unwrap`, and so on.

Two kinds of detail are nested under a hop instead of appearing as hops
of their own. An `import` hop lists the barrel files that forwarded the
name. A `declared wrapper` hop depends on a pack declaration and not on
source, so the explanation shows it as an assumption: "a pack declares
that withSentry from @sentry/serverless passes argument 0 through to its
result". A proof cut short by the depth cap says that it was cut short.

The atoms in a proof are the node ids the adapter interned, so both
functions take a `describe` callback that turns an atom into source
terms. `renderExplanation` turns the flattened chain into printable
lines. `suss ask 'why does … reach …'` runs this whole pipeline.

## Why rules and not a walker

Each rule describes one hop. The chains people write are longer: a
factory handing off to another factory, a closure three levels down
calling the argument, a barrel re-exporting a wrapper. The engine
composes the one-hop rules into those chains, so each of them resolves
without a rule of its own.

So when something comes back empty, suspect the facts before the rules.
On one production service, suss resolved 11 handlers and missed most of
what the template declared. The fix was one condition in fact
extraction, and the existing rules found the rest with no change.

## Changing a rule

Every rule composes with every other rule, so a change meant for one
construct also affects chains nobody had in mind.
`@suss/resolution-fuzz` generates four thousand fact bases, runs these
rules over each one, and compares the output against a committed
baseline. A rule change then shows up as a diff for a reviewer to read.
Run `npm run resolution:baseline` to accept the diff, and commit the
rewritten baseline with the rule.

## What is not modelled

**A handler passed as one property of a config.**
`make({ body: handler })`, where the factory reads `opts.body`, does not
resolve. A rule for it was tried and taken back out. A wrapper often
reads several callbacks off the same config object. The rule made each
of them a candidate for the whole call, and the ambiguity that produced
nulled out handlers that used to resolve. Deciding which property is the
handler needs information the structure does not give: either "the only
property that gets called", which needs negation, or a pack that
declares which property it is. Until one of those exists, this pattern
stays unresolved on purpose.

**An element of an array.** No fact records what an array contains, so
`all[0]` has nothing to step to.

**Which write a read sees, once control flow decides it.** A name
written twice in a module's own statement list does resolve. Those
statements run once each, top to bottom, so anything importing the name
gets the last write, and the adapter records that with `endsHolding`. A
write inside a branch, a loop or a function body is different. For those
the adapter records `mayHold` once per write, and the rules step the
name to every one of them. A caller that can use several values gets
them all, and a caller that needs one value gets none. Which write a
particular read sees is still unanswered.

Answering that in general is reaching definitions, computed per use
instead of per name. It needs facts about which statement follows which
and which branch each statement is in, and no adapter emits any of those
today.

The adapter picks the write, instead of a rule, because of cost.
Ordering writes inside the rules means asking which writes have no later
write. Negation can say that in one line, but this evaluator throws away
its last fixpoint and starts over whenever a rule set uses negation. The
store evaluates after every wave of facts, so one negated rule turned a
66 second run on the Saleor dashboard into one that had not finished
after ten minutes. The on-demand rewrite refuses negation before it gets
that far, because a relation derived only where somebody asked is
smaller than the relation `not p(x)` was written against. Every adapter
already knows source order.

`writesAllStated` makes stepping to each write safe, and it comes from
the same trade. Some writes leave the adapter with no value to record: a
loop target, an `except ... as`, and a parameter, whose value comes from
the caller and may or may not have been replaced by a later write when a
read runs. The recorded writes are then not the whole set, and stepping
to them would say a name is one of two things when it could be a third.
A rule would need `not writesUnstated(x)` to express that, so the
adapter records the positive side instead, and the rule joins on it.

The adapter supplies what it read: the values in source order, and a
description of its grammar. `writesRunInOrder` walks the scope with that
description and returns whether the writes run once each in the order
they are written. `valueLeftByWrites` picks the value the name comes
down to. Both decisions are written once, in this package, for every
language.

A description lists four things: how a bare name is spelled, which node
types open a body that runs later than the statements around it, how to
enumerate a node's children, and which spellings of a name are reads
and not writes or declarations. The walk itself never touches a parser,
so a Python `def` and a Ruby block are the same case to it.

**Ambiguity is the caller's problem.** When the rules reach two
different functions, the store returns nothing, because picking one
would make the answer depend on the order the facts arrived in.
