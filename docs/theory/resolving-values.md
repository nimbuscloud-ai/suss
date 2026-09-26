---
title: How suss follows a value
description: The graph query behind value resolution, the hops it walks, and what suss ask why prints when you want to see the working.
---

# How suss follows a value

Reading `router.post('/users', createUser)` leaves suss with a name and
no function. `createUser` might be a local `const`, an import, a
re-export through a barrel, a property on an object, the result of a
factory call, or several of those one after another. Working out what
the name comes down to is most of what an extraction run does, and
`suss ask why` prints the working.

The machinery is a graph query. The nodes are values written in the
source, the edges are single hops from one value to another, and a
question is a walk over those edges with a rule about where to stop.
No pass ever stores an edge. Nothing in the database says "this
parameter comes from that argument" until a rule joins three facts and
derives it, and the rule only fires where some question needed the
answer.

Three layers do the work.

<svg class="suss-diagram" viewBox="0 0 660 520" role="img" aria-labelledby="layers-title layers-desc">
  <title id="layers-title">The three layers of value resolution</title>
  <desc id="layers-desc">Source files go through an adapter that writes them down as facts. One shared rule set joins those facts into single hops between values and takes the transitive closure of them. Each question is that same closure with its own condition for where the walk stops.</desc>

  <defs>
    <marker id="layers-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box-data" x="180" y="8" width="300" height="30" rx="5" />
  <text class="label" x="330" y="28" text-anchor="middle">One project's source files</text>

  <line class="arrow" x1="330" y1="38" x2="330" y2="60" marker-end="url(#layers-arrow)" />

  <rect class="box" x="60" y="66" width="540" height="68" rx="6" />
  <text class="label" x="330" y="88" text-anchor="middle">1. The adapter reads each file into facts</text>
  <text class="note" x="330" y="106" text-anchor="middle">relations such as binds, call, callArg, paramOf, imports and exportsAs</text>
  <text class="note" x="330" y="124" text-anchor="middle">nothing is resolved at this layer, only written down</text>

  <line class="arrow" x1="330" y1="134" x2="330" y2="156" marker-end="url(#layers-arrow)" />

  <rect class="box-data" x="150" y="162" width="360" height="30" rx="5" />
  <text class="label-mono" x="330" y="182" text-anchor="middle">binds  call  callArg  paramOf  imports</text>

  <line class="arrow" x1="330" y1="192" x2="330" y2="214" marker-end="url(#layers-arrow)" />

  <rect class="box" x="60" y="220" width="540" height="86" rx="6" />
  <text class="label" x="330" y="242" text-anchor="middle">2. One rule set joins the facts into a value graph</text>
  <text class="note" x="330" y="260" text-anchor="middle">195 rules. 15 of them derive stepsTo(x, y, kind): one hop from a value to a value.</text>
  <text class="note" x="330" y="277" text-anchor="middle">reaches is the transitive closure of those hops, and it records</text>
  <text class="note" x="330" y="294" text-anchor="middle">the strongest kind of step the walk took.</text>

  <line class="arrow" x1="330" y1="306" x2="330" y2="328" marker-end="url(#layers-arrow)" />

  <rect class="box-data" x="150" y="334" width="360" height="30" rx="5" />
  <text class="label-mono" x="330" y="354" text-anchor="middle">stepsTo(x, y, kind)   reaches(x, z, kind)</text>

  <path class="arrow" d="M330,364 L125,404" marker-end="url(#layers-arrow)" />
  <line class="arrow" x1="330" y1="364" x2="330" y2="404" marker-end="url(#layers-arrow)" />
  <path class="arrow" d="M330,364 L535,404" marker-end="url(#layers-arrow)" />

  <rect class="box" x="30" y="410" width="190" height="64" rx="6" />
  <text class="label" x="125" y="432" text-anchor="middle">comesTo</text>
  <text class="note" x="125" y="450" text-anchor="middle">stops at a function</text>
  <text class="note" x="125" y="466" text-anchor="middle">or an object literal</text>

  <rect class="box" x="235" y="410" width="190" height="64" rx="6" />
  <text class="label" x="330" y="432" text-anchor="middle">isWrittenAs</text>
  <text class="note" x="330" y="450" text-anchor="middle">stops at anything</text>
  <text class="note" x="330" y="466" text-anchor="middle">written out in source</text>

  <rect class="box" x="440" y="410" width="190" height="64" rx="6" />
  <text class="label" x="535" y="432" text-anchor="middle">givesBack</text>
  <text class="note" x="535" y="450" text-anchor="middle">the same stop, for a</text>
  <text class="note" x="535" y="466" text-anchor="middle">walk that ran a call</text>

  <text class="note" x="330" y="498" text-anchor="middle">and comesFrom, objectOf, resolves: 59 question rules feeding 42 answer relations</text>
</svg>

## Layer 1: the adapter writes down what a file says

`packages/adapter/typescript/src/facts/extract.ts` walks one file and
records what it contains. No resolution happens here. A node is
identified by `absolutePath:start-end`, and the extractor keeps a side
table from that id back to the ts-morph node so an answer can come back
as something the rest of the adapter can use.

Here is the whole of one file from the
[node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app),
`src/prisma/prisma-client.ts`:

```ts
import { PrismaClient } from '@prisma/client';

// ...

declare const global: CustomNodeJsGlobal;

const prisma = global.prisma || new PrismaClient();

if (process.env.NODE_ENV === 'development') {
  global.prisma = prisma;
}

export default prisma;
```

and here is every fact the adapter emits for it, with each node id
printed as the source text it points at and its line number:

```
binds("global"@17, "global: CustomNodeJsGlobal"@15)
binds("PrismaClient"@17, "PrismaClient"@1)
binds("prisma = global.prisma || new PrismaClie"@17, "global.prisma || new PrismaClient()"@17)
call("new PrismaClient()"@17, "PrismaClient"@17)
exportsAs(src/prisma/prisma-client.ts, default, "prisma = global.prisma || new PrismaClie"@17)
fallbackBranch("global.prisma || new PrismaClient()"@17, "global.prisma"@17)
fallbackBranch("global.prisma || new PrismaClient()"@17, "new PrismaClient()"@17)
imports("PrismaClient"@1, node_modules/@prisma/client/index.d.ts, PrismaClient)
imports("PrismaClient"@1, @prisma/client, PrismaClient)
imports("PrismaClient"@1, .prisma, PrismaClient)
readsProperty("global.prisma"@17, "global"@17, prisma)
writtenValue("new PrismaClient()"@17)
```

Every one of those is a restatement of syntax. `binds` says a name is
declared as something. `fallbackBranch` says `a || b` is one of its two
branches, without saying which. `readsProperty` says an expression is
`o.n`. None of them says what anything resolves to.

A signature can supply one too. `returnsClass` says a function is
annotated as giving back a class, and an adapter emits it only when the
function's body states no value of its own, so a body that says what it
returns is never contradicted by its annotation.

The rules read relations that no rule derives, so something has to
supply them. Each adapter reads them out of source. All three adapters
write `extends` and `extendsNamed`, the Ruby adapter writes `prepends`,
and `callKeywordArg` comes from the Python and Ruby adapters.
`unwrapsByName` and the `givesBackOne` family
come from a pack's declarations, so no source file contains them at
all. An adapter declares some of those words itself, for its language.
In TypeScript, `Object.assign` hands back its first argument and `.bind`
hands back the function it was called on. In Ruby, `freeze` and `dup`
hand back their receiver. Those last three are `returnsReceiver` words.

Some of them take both. Python's `with httpx.Client() as client` gives
`entersAs(client, the call)` from the adapter, which says only that the
block opened over that call. What `__enter__` returns depends on the
library, so the pack declares `entersAsSelf(httpx, Client)`. A
rule joins the two and `client` resolves to the client.

`packages/resolution/DESIGN.md`, under "The facts an adapter supplies",
lists the whole vocabulary with a line of explanation each and the
adapters that emit each fact. `npm run check:fact-vocabulary` fails when
an adapter emits a relation, or a rule reads one, that the list leaves
out.

## Layer 2: one rule set makes a graph

`RESOLUTION_RULES` in `packages/resolution/src/index.ts` is 195 rules.
15 of them derive `stepsTo(x, y, kind)`, which says the value `x` leads
to the value `y` in one hop. Two of them, for an argument and a
property read, are written as `stepsTo` directly. The other thirteen
are written as `hop`, and each gets a `stepsTo` twin, since a walk
under a receiver context reads `hop`. An adapter can add hops of its
own, each with its twin, and those are not among the 195. The Ruby
adapter adds one, for `Const.new`.

```ts
rule("nameHop", [v("x"), v("y")], [lit("binds", v("x"), v("y"))], "alias"),
```

Read that as `nameHop(x, y) :- binds(x, y)`. The fourth
argument is the rule's name. Nothing in the evaluation uses that name.
It is there so that when suss explains an answer it can say which rule
took each hop, and this one prints as `alias`.

A name hop goes from a name to a value it has without running anything:
what it is declared as, what its last write leaves, each of several
writes, or each branch of a fallback. One `hop` rule takes every name
hop as a value step. Every other rule that follows a name, to a
parameter, an object, an import, a class or a call, takes `nameHop`
too, so a new kind of name hop reaches all of them at once.

The `kind` column separates three sorts of hop. A value step goes to what
`x` is written as. An instance step goes from an instance to the class it
is one of, so `new App()` steps to `App`; `isWrittenAs` does not follow
that hop, because `app` was written as the construction and not as the
class. A result step runs the call `x` is and goes to what that call
handed back. Eight more rules turn those single hops into
`reaches(x, z, kind)`, which is true when you can get from `x` to `z` by
taking one hop after another, however many that takes. A walk records
the strongest kind of hop it took. Value is the weakest and result the
strongest.

A construction is an object in its own right, called an allocation site.
It contains whatever the class's constructor and its other methods put
on the receiver, and the facts say which function did the storing
(`storesProperty`) rather than putting a value on the class under a
field name. The class contains the same things, so a class nothing in
the run makes one of still resolves a read through the receiver. A
write through a name for the construction, `client.timeout = 5`, goes
on the construction alone, and the class and its other constructions
never see it.

A field default is different. In Python, `is_admin: bool = False` on a
dataclass or a pydantic model is only the value an instance starts with
when its constructor is not given one, and the library that generates
the constructor is not in the run. The adapter records it as
`holdsDefault` rather than `holdsProperty`, so it is not something every
instance contains. A construction written with no arguments contains it.
A receiver or a parameter, whose construction the run cannot see, finds
the class's methods and plain attributes and none of its field defaults.
A plain class is different again. When a class is written with no
decorator and no base except `object` or another plain class, nothing
generates its constructor, so every instance shares the annotated
value and the rules read it as they read `holdsProperty`.

### Asking under one allocation site

Two constructions of one class share their class's facts, so a field
read off either of them comes down to the same expression. Which
argument built it is a different question, and the answer differs per
construction:

```ts
class Api {
  client: AxiosInstance;
  constructor(base: string) { this.client = axios.create({ baseURL: base }); }
  items() { return this.client.get("/items"); }
}
const v1 = new Api("https://a.example.com/v1");
const v2 = new Api("https://b.example.com/v2");
```

Asked what `base` is written as, the rules give both literals. Asked
under `v1`'s construction they give `https://a.example.com/v1`, and
under `v2`'s they give `https://b.example.com/v2`.

`reachesUnder(x, c, z, c2, kind)` is the closure again, with the site
the walk started under and the site it arrived under. The receiver read
under a site is that site, so `this.client` inside `items` is the client
that construction built. A property read goes on under the site the
object was made at, whichever site the question named. A parameter goes
on at the arguments of the calls that run its function under that site:
a construction runs its constructor under the site it makes, a method
call runs under the site its receiver is, and a call written as a plain
name runs under the site the body around it has.

The last rule is how a site survives a call to a plain function. In
`this.client = axios.create(url(base))` the call to `url` is written in
the constructor, so `url` runs under the site being made and its
parameter comes back to that construction's argument alone. A plain
function calling another passes the site along the same way, however
many of them there are. The site is lost only where a call is made
outside every method body, and then the walk takes every caller.

The rules track only one level of receiver. They do not read a
condition either:
`env === "prod" ? a : b` gives both branches under a site, because the
rules record the branches and do not evaluate the comparison.

`askResolutionUnder` asks the question, and `isWrittenAsUnder`,
`comesToUnder` and `objectOfUnder` read the results. A question asked
without a site gets the same result as before, because the two
closures share their hops and `reaches` is untouched. The three questions run on a program of their own, so a run
that never mentions a context is rewritten without the second closure
and pays nothing for it.

Applying the rules over and over until nothing new appears is the whole
of what the engine does. It matches every rule against everything known
so far, adds whatever comes out, and goes again. Eventually a pass adds
nothing, because each rule can only produce facts from facts and there
are finitely many values in the file. That point is the fixpoint, and
the answer is whatever is in the database when the engine arrives at
it.

Every construct states its hops once. Adding a language construct means
writing one `stepsTo` rule, and every question picks it up. Adding a
question means writing a stopping condition and no hop rules at all.

## Layer 3: a question is a stopping condition

The closure by itself has no answer in it. A question is `reaches` plus
a condition on where the walk ended.

| Question | Where the walk stops |
|---|---|
| `comesTo(x, z)` | at a function or an object literal, having run no call |
| `givesBack(x, z)` | the same, for a walk that did run a call |
| `givesBackUnwrapped(x, z)` | at what a call the result walk reached unwraps, which a caller asks before `givesBack` |
| `isWrittenAs(x, z)` | at anything spelled out in source |
| `objectOf(o, obj)` | at the object an expression refers to |
| `comesFrom(x, m, n)` | at an import, giving the module and the name, including a member read off a module imported whole |
| `callsInto(f, m, n)` | at a library name that calling `f` ends up calling |
| `resolves(x, z)` | `comesTo` narrowed to functions |

`resolves` is the one `suss ask why` proves.

At the bottom of the same file, `RESOLUTION_QUESTIONS` turns each of
those into an answer keyed by the value somebody asked about. It is 59
question rules feeding 42 answer relations. They are written as rules
rather than as loops in the caller
because `deriveOnDemand` reads them to work out how far to follow each
chain.

## A worked value graph: the Prisma singleton

`const prisma = global.prisma || new PrismaClient()` is the smallest
case that shows how this works. The facts above give three edges over four
nodes.

<svg class="suss-diagram" viewBox="0 0 660 336" role="img" aria-labelledby="prisma-title prisma-desc">
  <title id="prisma-title">The value graph for a Prisma singleton</title>
  <desc id="prisma-desc">The declaration steps to the fallback expression by the alias name hop. The fallback has two branches, so it steps twice. The left branch reads a property off a name that is declared but never written out as an object, so it settles on nothing. The right branch is a construction, which is written out in source, so isWrittenAs stops there and the value has one answer.</desc>

  <defs>
    <marker id="prisma-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="label-mono" x="330" y="20" text-anchor="middle">const prisma = global.prisma || new PrismaClient();</text>

  <rect class="box-data" x="200" y="38" width="260" height="34" rx="5" />
  <text class="label" x="330" y="53" text-anchor="middle">prisma</text>
  <text class="note" x="330" y="67" text-anchor="middle">the declaration, line 17</text>

  <line class="arrow" x1="330" y1="72" x2="330" y2="104" marker-end="url(#prisma-arrow)" />
  <text class="note" x="342" y="92" text-anchor="start">one stepsTo, by the alias name hop</text>

  <rect class="box" x="170" y="110" width="320" height="34" rx="6" />
  <text class="label-mono" x="330" y="131" text-anchor="middle">global.prisma || new PrismaClient()</text>

  <text class="note" x="330" y="166" text-anchor="middle">two fallbackBranch facts, so two more steps</text>

  <path class="arrow" d="M250,144 L150,186" marker-end="url(#prisma-arrow)" />
  <path class="arrow" d="M410,144 L510,186" marker-end="url(#prisma-arrow)" />

  <rect class="box" x="30" y="186" width="270" height="84" rx="6" />
  <text class="label-mono" x="165" y="208" text-anchor="middle">global.prisma</text>
  <text class="note" x="165" y="226" text-anchor="middle">readsProperty(it, global, prisma)</text>
  <text class="note" x="165" y="244" text-anchor="middle">global is declared but never written</text>
  <text class="note" x="165" y="260" text-anchor="middle">out, so this branch settles on nothing</text>

  <rect class="box-data" x="360" y="186" width="270" height="84" rx="6" />
  <text class="label-mono" x="495" y="208" text-anchor="middle">new PrismaClient()</text>
  <text class="note" x="495" y="226" text-anchor="middle">writtenValue, so the walk stops</text>
  <text class="note" x="495" y="244" text-anchor="middle">here and this is the only thing</text>
  <text class="note" x="495" y="260" text-anchor="middle">the value can be</text>

  <text class="label-mono" x="330" y="298" text-anchor="middle">isWrittenAs(prisma, new PrismaClient())</text>
  <text class="note" x="330" y="318" text-anchor="middle">comesTo derives nothing here: a construction is neither a function nor an object literal</text>
</svg>

Evaluating the rules over those facts and asking about the declaration
gives one answer:

```
wantedIsWrittenAs("prisma = global.prisma || new PrismaClie"@17, "new PrismaClient()"@17)
```

Two branches, and one answer came out without anything having to rank
them. The left branch makes no claim because `global` is declared and
never written out as an object literal, so `objectOf` finds nothing to
look inside and `contains` never fires. Two branches that both settled,
on different things, would give two answers, and a caller wanting one
function back treats that the same as none.

The same walk under `comesTo` derives nothing at all, which is why

```
$ suss ask 'why does prisma at src/app/routes/auth/auth.service.ts:10 resolve to PrismaClient' --dir .
suss cannot follow prisma at src/app/routes/auth/auth.service.ts:10 down to one function.

The chain either leaves the source suss can read, or more than one value can end it.
```

`new PrismaClient()` is a construction, neither a function nor an
object literal, so a question that stops only at those two walks past
it and off the end. A question that stops at anything written out in
source lands on it. Both questions walk the same edges to the same
place, and they differ only in where they are allowed to stop.

## Most edges come out of a join

The alias and fallback edges above each came from a single fact. Most
do not. Take the edge from a parameter to what a caller passed it:

```ts
rule(
  "stepsTo",
  [v("p"), v("a"), VALUE_STEP],
  [lit("passesArgument", v("r"), v("p"), v("a"))],
  "argument",
),
```

`passesArgument` is itself derived, from three facts:

```
passesArgument(r, p, a) :- paramOf(f, k, p), callsFunction(r, f), callArg(r, k, a).
```

and `callsFunction` is derived too. Here is one instance from the same
project, `bcrypt.hash(password, 10)` on line 58 of `auth.service.ts`,
printed as the stored derivation tree:

```
passesArgument(bcrypt.hash(password, 10)@58, s: string@50, password@58)   [passesArgument :- paramOf, callsFunction, callArg]
  paramOf(export declare function hash(s: st@50, 0, s: string@50)   <fact>
  callsFunction(bcrypt.hash(password, 10)@58, export declare function hash(s: st@50)   [callsFunction :- binds, call]
    binds(bcrypt.hash@58, export declare function hash(s: st@50)   <fact>
    call(bcrypt.hash(password, 10)@58, bcrypt.hash@58)   <fact>
  callArg(bcrypt.hash(password, 10)@58, 0, password@58)   <fact>
```

Four base facts, from two different files, produce one edge that then
produces a `stepsTo` hop. The join is what connects `password` to
`bcrypt.hash`'s first parameter. The extractor emitted the four facts
without working that out.

`callsFunction` also covers a callee a factory returned. With
`const requireEnv = makeReader(prefix)`, a call on `requireEnv` runs
what `makeReader` returns, so one more rule joins the call on the name
to the call that filled it:

```
callsFunction(r, f) :- returnsValue(g, f), callsFunction(r0, g), callsNamed(r, r0).
```

That is also where multiple answers come from. bcryptjs declares `hash`
twice, so the join fires against both declarations and `password`
reaches two different parameter nodes. A caller that needs the call
sites told apart asks `passesArgument`, which keeps the call in the
tuple.

## Deriving only what a question needs

Deriving every conclusion the facts support is affordable on a fixture
and not on a project. Profiling these rules turned up one rule
attempting a hundred and fifty joins to produce fourteen tuples, and
for every tuple a question went on to read, roughly ten more were
derived that no question ever touched.

So `deriveOnDemand` in `packages/datalog/src/onDemand.ts` rewrites the
program before it ever runs. This is the magic sets transform. Each
derived relation gets a companion relation listing the rows somebody is
waiting on, and every rule gets that companion as its first literal.
Demand then propagates down each rule body the way the join binds
variables. A rule that needs `comesTo(y, z)` to derive `comesTo(x, z)`
puts in a demand for it, and the engine derives the inner pair because
the outer one was asked for. A relation nothing asks for is not derived
at all.

The rewrite turns every rule `RESOLUTION_RULES` and `RESOLUTION_QUESTIONS`
contain into several rules of its own, one for each way a demand fact
can reach it. Demand is an ordinary fact, `wanted(x)`. Asking something
new adds one more fact to the set, so the engine continues from where
it was instead of starting the fixpoint over, and a caller that has
read its answer can retract the question again.

What that saves, measured on the `createUser` question in the next
section, over the same base facts and with the same one answer coming
out of both:

| | facts |
|---|---|
| base facts the walk extracted | 418 |
| derived by the rules as written | 535 |
| derived by the rewritten rules | 45 |

Setting `SUSS_RESOLUTION_ON_DEMAND=0` runs the rules unrewritten, which
is how that comparison was taken. Both settings give the same answer to
every question. They differ in how much never gets computed.

## Witnesses, and the proof behind an answer

A Datalog engine normally hands back a set of facts and nothing else.
`resolves(createUser@16, createUser@38)` is either in the database or
it is not. Once the fixpoint has been reached the engine cannot say
which rule put it there or which facts that rule matched, because it
never wrote any of that down.

A witness is that missing record. Give a derived fact a witness and the
fact stores the rule that produced it and the facts that rule matched.
Each of those is a derived fact with a witness of its own, so following
them down arrives at the facts the adapter emitted from source. The
database then contains the derivation of every fact in it alongside
the fact itself.

What to record is a choice, so the engine takes it as a parameter. A
tag algebra is three things: what tag a base fact starts with, how to
combine the tags of a rule's body into a tag for its head, and what to
do when two derivations produce the same fact.
`packages/datalog/src/witness.ts` supplies one where the tag is the
derivation itself. `confidence.ts` supplies another where the tag is
how far to trust the fact, combining as the weakest link along a rule
body and the strongest across competing derivations. The evaluator
cannot tell the two apart.

Under the witness algebra the merge keeps whichever derivation arrived
first, so a fact derived nine ways records one of those nine,
and the engine reaches the same set of facts it reaches untagged.
`proofOf` walks the stored records backward into a tree when somebody
asks for one, without re-running a rule.

`suss ask why` is that walk. It re-reads the relevant files, evaluates
the rules under the witness algebra, and rebuilds the proof of the one
answer. None of it happens during a normal extraction run.

```
$ suss ask 'why does createUser at src/app/routes/auth/auth.controller.ts:16 resolve to createUser' --dir .
createUser at src/app/routes/auth/auth.controller.ts:16 resolves to createUser (src/app/routes/auth/auth.service.ts:38):
  createUser (src/app/routes/auth/auth.controller.ts:16) -> createUser (src/app/routes/auth/auth.controller.ts:3) -> createUser (src/app/routes/auth/auth.service.ts:38) -> createUser (src/app/routes/auth/auth.service.ts:38)
  createUser (src/app/routes/auth/auth.controller.ts:16) is declared as createUser (src/app/routes/auth/auth.controller.ts:3)
  createUser (src/app/routes/auth/auth.controller.ts:3) is imported from src/app/routes/auth/auth.service.ts under the name createUser
  createUser (src/app/routes/auth/auth.service.ts:38) is declared as createUser (src/app/routes/auth/auth.service.ts:38)
```

The first line is the chain. The three lines under it are one reason per
hop, and each reason is the rule that took that hop: `alias`, then
`import`, then `alias`. `--json` adds the rule behind each hop, the
assumptions a pack-declared wrapper contributed, and what the
re-evaluation cost.

Underneath, the proof is the whole derivation, seventeen nodes of it.

<svg class="suss-diagram" viewBox="0 0 660 592" role="img" aria-labelledby="proof-title proof-desc">
  <title id="proof-title">The proof tree behind one ask why answer</title>
  <desc id="proof-desc">An indented tree of seventeen nodes. The root is the resolves fact, and each node says which rule derived it. Leaves marked fact are base facts the adapter emitted. The three highlighted nodes, labelled alias, import and alias, are the three reasons the command prints. Each alias node is a nameHop under a stepsTo node labelled name hop.</desc>

  <defs>
    <marker id="proof-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path class="arrow-head" d="M0,1 L6,3.5 L0,6 Z" />
    </marker>
  </defs>

  <text class="axis" x="16" y="22" text-anchor="start">what a why question rebuilds</text>

  <rect class="box-data" x="16" y="40" width="628" height="24" rx="4" />
  <text class="label-mono" x="24" y="56" text-anchor="start">resolves(name@16, fn@38)</text>
  <text class="note" x="636" y="56" text-anchor="end">resolves :- comesTo, func</text>

  <rect class="box" x="40" y="70" width="604" height="24" rx="4" />
  <text class="label-mono" x="48" y="86" text-anchor="start">comesTo(name@16, fn@38)</text>
  <text class="note" x="636" y="86" text-anchor="end">comesTo :- reaches, func</text>

  <rect class="box" x="64" y="100" width="580" height="24" rx="4" />
  <text class="label-mono" x="72" y="116" text-anchor="start">reaches(name@16, fn@38, value)</text>
  <text class="note" x="636" y="116" text-anchor="end">reaches :- reaches, stepsTo</text>

  <rect class="box" x="88" y="130" width="556" height="24" rx="4" />
  <text class="label-mono" x="96" y="146" text-anchor="start">reaches(name@16, decl@38, value)</text>
  <text class="note" x="636" y="146" text-anchor="end">reaches :- reaches, stepsTo</text>

  <rect class="box" x="112" y="160" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="176" text-anchor="start">reaches(name@16, import@3, value)</text>
  <text class="note" x="636" y="176" text-anchor="end">reaches :- stepsTo</text>

  <rect class="box" x="136" y="190" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="206" text-anchor="start">stepsTo(name@16, import@3, value)</text>
  <text class="note" x="636" y="206" text-anchor="end">name hop</text>

  <rect class="box-data" x="160" y="220" width="484" height="24" rx="4" />
  <text class="label-mono" x="168" y="236" text-anchor="start">nameHop(name@16, import@3)</text>
  <text class="note" x="636" y="236" text-anchor="end">alias</text>

  <rect class="box" x="184" y="250" width="460" height="24" rx="4" />
  <text class="label-mono" x="192" y="266" text-anchor="start">binds(name@16, import@3)</text>
  <text class="note" x="636" y="266" text-anchor="end">fact</text>

  <rect class="box-data" x="112" y="280" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="296" text-anchor="start">stepsTo(import@3, decl@38, value)</text>
  <text class="note" x="636" y="296" text-anchor="end">import</text>

  <rect class="box" x="136" y="310" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="326" text-anchor="start">imports(import@3, auth.service.ts, createUser)</text>
  <text class="note" x="636" y="326" text-anchor="end">fact</text>

  <rect class="box" x="136" y="340" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="356" text-anchor="start">moduleExport(auth.service.ts, createUser, decl@38)</text>
  <text class="note" x="636" y="356" text-anchor="end">export</text>

  <rect class="box" x="160" y="370" width="484" height="24" rx="4" />
  <text class="label-mono" x="168" y="386" text-anchor="start">exportsAs(auth.service.ts, createUser, decl@38)</text>
  <text class="note" x="636" y="386" text-anchor="end">fact</text>

  <rect class="box" x="88" y="400" width="556" height="24" rx="4" />
  <text class="label-mono" x="96" y="416" text-anchor="start">stepsTo(decl@38, fn@38, value)</text>
  <text class="note" x="636" y="416" text-anchor="end">name hop</text>

  <rect class="box-data" x="112" y="430" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="446" text-anchor="start">nameHop(decl@38, fn@38)</text>
  <text class="note" x="636" y="446" text-anchor="end">alias</text>

  <rect class="box" x="136" y="460" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="476" text-anchor="start">binds(decl@38, fn@38)</text>
  <text class="note" x="636" y="476" text-anchor="end">fact</text>

  <rect class="box" x="64" y="490" width="580" height="24" rx="4" />
  <text class="label-mono" x="72" y="506" text-anchor="start">func(fn@38)</text>
  <text class="note" x="636" y="506" text-anchor="end">fact</text>

  <rect class="box" x="40" y="520" width="604" height="24" rx="4" />
  <text class="label-mono" x="48" y="536" text-anchor="start">func(fn@38)</text>
  <text class="note" x="636" y="536" text-anchor="end">fact</text>

  <path class="arrow" d="M28,64 L28,82 L40,82" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M28,64 L28,532 L40,532" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M52,94 L52,112 L64,112" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M52,94 L52,502 L64,502" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M76,124 L76,142 L88,142" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M76,124 L76,412 L88,412" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,154 L100,172 L112,172" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,154 L100,292 L112,292" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,184 L124,202 L136,202" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M148,214 L148,232 L160,232" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M172,244 L172,262 L184,262" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,304 L124,322 L136,322" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,304 L124,352 L136,352" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M148,364 L148,382 L160,382" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,424 L100,442 L112,442" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,454 L124,472 L136,472" marker-end="url(#proof-arrow)" />

  <text class="note" x="16" y="562" text-anchor="start">name@16 is the identifier in the controller, import@3 its import specifier,</text>
  <text class="note" x="16" y="578" text-anchor="start">decl@38 the declaration in auth.service.ts, fn@38 the arrow function itself</text>
</svg>

The three highlighted rows are the three lines the command printed. A
step through a name prints the reason of the `nameHop` row under it,
since the `stepsTo` rule above says only that a name hop was taken. The
other fourteen rows are the joins that produced those hops and the
facts they rest on.

A proof node marked `fact` is a leaf. No rule derived it, because the
adapter emitted it from source. That makes an answer checkable: follow
the tree down and you arrive at lines of source, and where the answer
is wrong the tree says which fact to doubt.

## Where to look next

- `packages/resolution/DESIGN.md` for the fact vocabulary, one line
  each, and the cases the rules leave unresolved on purpose.
- `packages/datalog/README.md` for the evaluator: semi-naive fixpoint,
  stratified negation, rules as plain data.
- [Facts and rules](/theory/facts-and-rules) for the
  other rule sets over the same engine, the ones that answer
  whole-program questions about reachability and effects.
- [`suss ask`](/reference/cli/ask) for all ten questions `suss ask`
  takes.
