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
The part that trips people up is that nobody stores the edges. Nothing
writes down "this parameter comes from that argument". A rule joins
three facts and the edge appears, and it appears only if some question
needed it.

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
  <text class="note" x="330" y="106" text-anchor="middle">23 relations for TypeScript: binds, call, callArg, paramOf, imports, exportsAs and the rest</text>
  <text class="note" x="330" y="124" text-anchor="middle">nothing is resolved at this layer, only written down</text>

  <line class="arrow" x1="330" y1="134" x2="330" y2="156" marker-end="url(#layers-arrow)" />

  <rect class="box-data" x="150" y="162" width="360" height="30" rx="5" />
  <text class="label-mono" x="330" y="182" text-anchor="middle">binds  call  callArg  paramOf  imports</text>

  <line class="arrow" x1="330" y1="192" x2="330" y2="214" marker-end="url(#layers-arrow)" />

  <rect class="box" x="60" y="220" width="540" height="86" rx="6" />
  <text class="label" x="330" y="242" text-anchor="middle">2. One rule set joins the facts into a value graph</text>
  <text class="note" x="330" y="260" text-anchor="middle">51 rules. Ten of them derive stepsTo(x, y, kind): one hop from a value to a value.</text>
  <text class="note" x="330" y="277" text-anchor="middle">reaches is the transitive closure of those hops, and it records</text>
  <text class="note" x="330" y="294" text-anchor="middle">whether the walk ran a call along the way.</text>

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

  <text class="note" x="330" y="498" text-anchor="middle">and comesFrom, objectOf, paramAt, resolves: eight question rules feeding seven answer relations</text>
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
calleeName("new PrismaClient()"@17, PrismaClient)
calleeOrigin("new PrismaClient()"@17, @prisma/client)
calleeOrigin("new PrismaClient()"@17, .prisma)
exportsAs(src/prisma/prisma-client.ts, default, "prisma = global.prisma || new PrismaClie"@17)
fallbackBranch("global.prisma || new PrismaClient()"@17, "global.prisma"@17)
fallbackBranch("global.prisma || new PrismaClient()"@17, "new PrismaClient()"@17)
imports("PrismaClient"@1, node_modules/@prisma/client/index.d.ts, PrismaClient)
importsModule(src/prisma/prisma-client.ts, node_modules/@prisma/client/index.d.ts)
readsProperty("global.prisma"@17, "global"@17, prisma)
writtenValue("new PrismaClient()"@17)
```

Every one of those is a restatement of syntax. `binds` says a name is
declared as something. `fallbackBranch` says `a || b` is one of its two
branches, without saying which. `readsProperty` says an expression is
`o.n`. None of them says what anything resolves to.

The rules read 25 relations that no rule derives, so something has to
supply them. The TypeScript adapter supplies 21 of the 25 by reading
source, and emits two more of its own on top: `bindCall`, for the
JavaScript `.bind` rule, and `importsModule`, for walking module edges.
That leaves four it never emits. `extends` and `callKeywordArg` come
from the Python and Ruby adapters. `unwrapsByName` and `wrapperModule`
come from a pack's wrapper declarations, so no source file contains
them at all.

`packages/resolution/README.md` lists the vocabulary with a line of
explanation each.

## Layer 2: one rule set makes a graph

`packages/resolution/src/index.ts` contains 51 rules and no code. Ten
of them derive `stepsTo(x, y, kind)`, which says the value `x` leads to
the value `y` in one hop. The TypeScript adapter adds an eleventh for
`.bind`.

```ts
rule(
  "stepsTo",
  [v("x"), v("y"), VALUE_STEP],
  [lit("binds", v("x"), v("y"))],
  "alias",
),
```

Read that as `stepsTo(x, y, value) :- binds(x, y)`. The fourth
argument is what a proof calls the rule.

The `kind` column separates two sorts of hop. A value step goes to what
`x` is written as. A result step runs the call `x` is and goes to what
that call handed back. Four rules take the transitive closure into
`reaches(x, z, kind)`, and a walk counts as a result walk as soon as it
has run a call anywhere along it.

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
| `isWrittenAs(x, z)` | at anything written out in source rather than named |
| `objectOf(o, obj)` | at the object an expression refers to |
| `paramAt(r, p, z)` | at what one call site put in parameter `p` |
| `comesFrom(x, m, n)` | at an import, giving the module and the name |
| `callsInto(f, m, n)` | at a library name that calling `f` ends up calling |
| `resolves(x, z)` | `comesTo` narrowed to functions |

`resolves` is the one `suss ask why` proves.

Eight further rules at the bottom of the same file, `RESOLUTION_QUESTIONS`,
turn each of those into an answer relation keyed by the value somebody
asked about. They are written as rules rather than as loops in the caller
because `deriveOnDemand` reads them to work out how far to follow each
chain.

## A worked value graph: the Prisma singleton

`const prisma = global.prisma || new PrismaClient()` is the smallest
case that shows the shape. The facts above give three edges over four
nodes.

<svg class="suss-diagram" viewBox="0 0 660 336" role="img" aria-labelledby="prisma-title prisma-desc">
  <title id="prisma-title">The value graph for a Prisma singleton</title>
  <desc id="prisma-desc">The declaration steps to the fallback expression by the alias rule. The fallback has two branches, so it steps twice. The left branch reads a property off a name that is declared but never written out as an object, so it settles on nothing. The right branch is a construction, which is written out in source, so isWrittenAs stops there and the value has one answer.</desc>

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
  <text class="note" x="342" y="92" text-anchor="start">one stepsTo, by the alias rule</text>

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

`new PrismaClient()` is a construction. It is not a function and it is
not an object literal, so a question that stops only at those two walks
past it and off the end. A question that stops at anything written out
in source lands on it. Both questions walked the same edges to the
same place. Only one of them had a reason to stop there.

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
produces a `stepsTo` hop. Nothing in the extractor knew that
`bcrypt.hash`'s first parameter would ever contain `password`. The join
found it.

That is also where multiple answers come from. bcryptjs declares `hash`
twice, so the join fires against both declarations and `password`
reaches two different parameter nodes. A caller that needs the call
sites told apart asks `paramAt`, which keeps the call in the tuple.

## The graph forms around the question

Deriving every conclusion the facts support is fine on a fixture. On a
project it is not. Profiling these rules turned up one rule attempting
a hundred and fifty joins to produce fourteen tuples, and for every
tuple a question went on to read, roughly ten more were derived that
nobody looked at.

So `deriveOnDemand` in `packages/datalog/src/onDemand.ts` rewrites the
program before it ever runs. This is the magic sets transform. Each
derived relation gains a companion relation saying which of its rows
somebody is waiting on, every rule gets that companion as its first
literal, and demand propagates down each rule body the way the join
binds variables. A rule that needs `comesTo(y, z)` in order to answer
`comesTo(x, z)` says so, and the engine derives the inner pair because
the outer one was asked for. A relation nothing asks for is not derived
at all.

The 59 rules that `RESOLUTION_RULES` and `RESOLUTION_QUESTIONS` contain
become 125 rewritten rules over 44 demand-restricted relations. Demand
is an ordinary fact, `wanted(x)`. Asking something new adds one more
fact to the set, so the engine continues from where it was instead of
starting the fixpoint over, and a caller that has read its answer can
retract the question again.

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

## Every derived fact keeps a witness

Evaluate under the `witnesses` algebra in
`packages/datalog/src/witness.ts` and every derived fact stores the rule
that fired and one entry per body literal. The merge keeps whatever is
already there, so a fact derived nine ways keeps its first derivation
and the fixpoint behaves exactly as it does untagged. `proofOf` walks
those stored entries backward into a tree when somebody asks, and never
re-runs a rule.

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
hop, and each reason is the `stepsTo` rule that fired there: `alias`,
then `import`, then `alias`. `--json` adds the rule behind each hop,
the assumptions a pack-declared wrapper contributed, and what the
re-evaluation cost.

Underneath, the proof is the whole derivation, fifteen nodes of it.

<svg class="suss-diagram" viewBox="0 0 660 532" role="img" aria-labelledby="proof-title proof-desc">
  <title id="proof-title">The proof tree behind one ask why answer</title>
  <desc id="proof-desc">An indented tree of fifteen nodes. The root is the resolves fact, and each node says which rule derived it. Leaves marked fact are base facts the adapter emitted. The three stepsTo nodes, labelled alias, import and alias, are the three reasons the command prints.</desc>

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
  <text class="note" x="636" y="116" text-anchor="end">reaches :- stepsTo, reaches</text>

  <rect class="box-data" x="88" y="130" width="556" height="24" rx="4" />
  <text class="label-mono" x="96" y="146" text-anchor="start">stepsTo(name@16, import@3, value)</text>
  <text class="note" x="636" y="146" text-anchor="end">alias</text>

  <rect class="box" x="112" y="160" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="176" text-anchor="start">binds(name@16, import@3)</text>
  <text class="note" x="636" y="176" text-anchor="end">fact</text>

  <rect class="box" x="88" y="190" width="556" height="24" rx="4" />
  <text class="label-mono" x="96" y="206" text-anchor="start">reaches(import@3, fn@38, value)</text>
  <text class="note" x="636" y="206" text-anchor="end">reaches :- stepsTo, reaches</text>

  <rect class="box-data" x="112" y="220" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="236" text-anchor="start">stepsTo(import@3, decl@38, value)</text>
  <text class="note" x="636" y="236" text-anchor="end">import</text>

  <rect class="box" x="136" y="250" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="266" text-anchor="start">imports(import@3, auth.service.ts, createUser)</text>
  <text class="note" x="636" y="266" text-anchor="end">fact</text>

  <rect class="box" x="136" y="280" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="296" text-anchor="start">moduleExport(auth.service.ts, createUser, decl@38)</text>
  <text class="note" x="636" y="296" text-anchor="end">export</text>

  <rect class="box" x="160" y="310" width="484" height="24" rx="4" />
  <text class="label-mono" x="168" y="326" text-anchor="start">exportsAs(auth.service.ts, createUser, decl@38)</text>
  <text class="note" x="636" y="326" text-anchor="end">fact</text>

  <rect class="box" x="112" y="340" width="532" height="24" rx="4" />
  <text class="label-mono" x="120" y="356" text-anchor="start">reaches(decl@38, fn@38, value)</text>
  <text class="note" x="636" y="356" text-anchor="end">reaches :- stepsTo</text>

  <rect class="box-data" x="136" y="370" width="508" height="24" rx="4" />
  <text class="label-mono" x="144" y="386" text-anchor="start">stepsTo(decl@38, fn@38, value)</text>
  <text class="note" x="636" y="386" text-anchor="end">alias</text>

  <rect class="box" x="160" y="400" width="484" height="24" rx="4" />
  <text class="label-mono" x="168" y="416" text-anchor="start">binds(decl@38, fn@38)</text>
  <text class="note" x="636" y="416" text-anchor="end">fact</text>

  <rect class="box" x="64" y="430" width="580" height="24" rx="4" />
  <text class="label-mono" x="72" y="446" text-anchor="start">func(fn@38)</text>
  <text class="note" x="636" y="446" text-anchor="end">fact</text>

  <rect class="box" x="40" y="460" width="604" height="24" rx="4" />
  <text class="label-mono" x="48" y="476" text-anchor="start">func(fn@38)</text>
  <text class="note" x="636" y="476" text-anchor="end">fact</text>

  <path class="arrow" d="M28,64 L28,82 L40,82" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M28,64 L28,472 L40,472" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M52,94 L52,112 L64,112" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M52,94 L52,442 L64,442" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M76,124 L76,142 L88,142" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M76,124 L76,202 L88,202" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,154 L100,172 L112,172" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,214 L100,232 L112,232" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M100,214 L100,352 L112,352" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,244 L124,262 L136,262" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,244 L124,292 L136,292" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M148,304 L148,322 L160,322" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M124,364 L124,382 L136,382" marker-end="url(#proof-arrow)" />
  <path class="arrow" d="M148,394 L148,412 L160,412" marker-end="url(#proof-arrow)" />

  <text class="note" x="16" y="502" text-anchor="start">name@16 is the identifier in the controller, import@3 its import specifier,</text>
  <text class="note" x="16" y="518" text-anchor="start">decl@38 the declaration in auth.service.ts, fn@38 the arrow function itself</text>
</svg>

The three highlighted rows are the `stepsTo` nodes, and they are the
three lines the command printed. The other twelve are the joins that
produced those hops and the facts they rest on.

A proof node marked `fact` is a leaf: nobody derived it, the adapter
emitted it. That is the property that makes an answer checkable. Follow
the tree down and you arrive at lines of source, and if the answer is
wrong the tree says which fact to doubt.

## Where to look next

- `packages/resolution/README.md` for the fact vocabulary, one line
  each, and the cases the rules leave unresolved on purpose.
- `packages/datalog/README.md` for the evaluator: semi-naive fixpoint,
  stratified negation, rules as plain data.
- [`internal/facts-and-rules.md`](internal/facts-and-rules.md) for the
  other rule sets over the same engine, the ones that answer
  whole-program questions about reachability and effects.
- [`reference/cli.md`](reference/cli.md#suss-ask) for the other six
  questions `suss ask` takes.
