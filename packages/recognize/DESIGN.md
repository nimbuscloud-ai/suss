# How a pack declaration is compiled

The [README](./README.md) says what `@suss/recognize` is for.

## The four jobs a pack does

A pack does four jobs: it discovers units, it recognizes calls inside
them, it declares terminals, and it claims sub-units. The design writes
all four as the same chain of links, differing only in what the last
link yields. Today only recognition is written that way.

```
where the match starts -> which method -> read the arguments -> yield
                                                                effects
                                                                a unit
                                                                a terminal
                                                                a sub-unit
```

Six endings are built, and all six are recognition endings that
yield effects: `storageAccess` asks the call what it reached,
`sqlAccess` reads the statement the call was given, `messageSend`
and `unitInvoke` read the object the call sends, `schedule` reads
the callback the call hands over, and `streamWrite` reads what the
call writes to a stream. A schedule chain can also say what a
callback written in place becomes, which is how a pack claims a
sub-unit as data. Discovery and terminals still come from the pack's
discovery patterns. Each would become a new member of `Ending`, with
its own entry in the `YIELD` table in `compile.ts`.

### Where a match starts

Where a match starts is a separate choice from the rest of the chain,
and a receiver is one of the options. Across the 29 shipped packs a
match starts from at least thirteen places, and most of them are not
receivers: an exported name, a file path, a decorator, a parameter's
type, a template file beside the module, a function's return type.
`MatchStart` is the union those would go into. Today it has one member,
`FromReceiver`, because only recognition is written as a chain.

The starts that begin at a receiver form their own union,
`ReceiverOrigin`:

| origin | what it matches | built |
|---|---|---|
| `declaredBy` | a receiver whose method one of these modules declared | yes |
| `constructed` | a client made from one of these modules' exports | yes |
| `anyOf` | a receiver any one of several origins accepts | yes |
| `returnedBy` | what a library method returned, called on a receiver from another origin: `hook.get_client()` | yes |
| `typed` | a receiver the program declares as one of a module's named types, `to: CommandDispatcher`, or as any type the module declares when no name is given | yes |
| `inherits` | a receiver of a class whose ancestry reaches a library base: `class PrismaService extends PrismaClient` | yes |
| `handedBy` | the parameter a library method hands the callback it was called with: `tx` in `db.$transaction(async (tx) => ...)` | yes |
| `imported` | a value the file imports under one of these names, or the module itself as `*` | yes |
| `factoryMade` | `app = express()` | no |
| `anchored` | a chain read from its anchor call | no |
| `global` | a receiver, or a call with no receiver, spelled as one of these paths: `console`, `process.stdout`, `print` | yes |

A pack uses `declaredBy` when the source never writes out which client
it is using. In `const redis = await this.getClient()` nothing mentions
ioredis, but the declaration behind `redis.get` comes from ioredis.
`constructed` looks at where the receiver itself was made, so it still
works where the method has no type. Its `named` lists exports, and a
constructor imported under another name is read as the export it is, so
`new BullQueue()` after `import { Queue as BullQueue }` matches `named:
["Queue"]`. In Ruby, `X.new` is made from the class `X`, so `named`
lists `Connection` for `PG::Connection.new`, and any other method
called on a constant is a factory named after the method, as `connect`
is in `PG.connect`.

Nothing in a program says what a library method returns, so the pack
does. `returnedBy("get_client", declaredBy(HOOK))` takes the receiver
of `hook.get_client().query(sql)`, and `anyOf` lets a chain take that
client and one the program made itself.

A project's own dispatcher is usually handed around as a parameter, so
nothing in sight made it. `typed({ from, named })` takes a receiver the
program declares as one of those types, as one of those modules exports
it. TypeScript asks the checker, Python reads the annotation or the
call that built the value, and Ruby, which declares no types, takes a
receiver made from one of the classes, as `constructed` would. With
`named` left out, any type the module declares counts: an ORM types its
client, the client a transaction hands over and each delegate
differently, and a project reaches them through a module of its own,
so the calling file need not import the library. TypeScript reads the
file that declares the type, which is under the package in
`node_modules` or in a copy of the module its generator wrote.

A NestJS service extends the client and the container hands it to
whoever asks, so neither its type nor where it was made says which
library it is. `inherits({ from, named })` takes a receiver of a class
whose ancestry reaches one of `named` as one of `from` exports it,
through any of the project's own classes between. TypeScript asks the
checker for the receiver's classes and their written bases, and the
store where each base was imported from, which works before the library
is installed. Python and Ruby read the class the facts say the receiver
is one of, or the class it was made from, and walk `extends` up to a
base `importedAs` says the module exports. The discovery pattern for a
subclass reads the same `Inherits` spec through the same walk.

`handedBy(method, on, { parameter })` takes the client a library method
hands its callback: `db.$transaction(async (tx) => tx.user.update(...))`
gives the callback a client for the transaction as its first
parameter. The callback is the call's first argument, a function
written there or passed by a name bound to it, or a Ruby call's block,
and the call has to go to `method` on a receiver `on` accepts.

`imported({ from, named })` takes a value the file brought in: a
function it calls bare, or a module or a class it calls a method on.
`named` lists the names as the module exports them, so an alias
matches, and `*` is the module itself, as `import * as ledger` or
Python's `import ledger` brings it in. Ruby has no imports, so its
facts state a constant whose root no file in the run defines as
imported from `GLOBAL_MODULE` under its path, and `Ledger.publish` is
then a method on the `*` of `Ledger`.

`global(...paths)` takes what the runtime provides and nothing declares,
so how the source spells it is all there is to match. Each adapter says
what spelled means. TypeScript reads the dotted path as written, so a
local that shadows `console` still matches; checking for one is a
change of its own. Python asks that `sys` is the module the file
imported and that nothing in scope rebinds `print`. Ruby reads a `$`
variable by its name, and a constant such as `STDOUT` by the path no
file in the run defines. A receiver also matches when the rules
followed one of the paths into it, so `out.write(x)` in a helper a
caller passed `process.stdout` matches, and `receiverGlobal(paths)`
says which path that was. A chain that starts at a global also matches
a call of the global with no receiver, `print(x)` or `puts x`, looking
its callee up in the methods table.

A read has no receiver, so a read chain starts at the object its reads
are off, with an `off` link rather than a `start` one. The object is a
`RuntimeObject`: a `global`, spelled the way a receiver is, or a
`HandedIn`, the parameter a platform fills when it calls a unit it
discovered, as the `env` a Worker's `fetch(request, env, ctx)` is
handed. The pack that discovers the unit says which parameter. No
adapter states that yet, so a read is never off a `HandedIn` today.

A chain can also match a call made directly on the tracked value, with
no method, by adding `.calls(meaning)` next to its methods table. A
store hook is the usual case. `useAppStore((s) => s.bears)` calls no
method, so the table has no method name to list. The call matches when
its callee is a bound name whose written value came from the chain's
origin. A call with no receiver, bare or a construction such as `new
GetCommand(...)`, is read as the export its callee was imported as when
the table does not list the name it is written with, so `useOrders`
imported as `useQuery` records `useQuery` as its operation. Only a name
an import binds is read this way. A callback parameter keeps the name it
is written with, since what it was imported as depends on each caller. With
`imported` the callee is the import itself, so
`publishEntry(queue, body)` matches when the file imported
`publishEntry`. Such a call usually reads its fields inside a selector lambda,
and `fields: { selectorParam: 0 }` reads them off the lambda's
parameter, one field per distinct first segment.

## The gradient

A pack can write any single link as code instead of data, and pack
health reports every link that does. There are three levels:

1. A chain of data links. It can be serialized and inspected, and it
   runs wherever the ops do.
2. A link written as a function. That one link is code while the rest
   stay data, and pack health reports which links are opaque.
3. `astLink` from `@suss/recognize/ast`, which passes the function the
   adapter's own node. It has its own import, so using it shows up in
   the diff, and pack health reports it the way it reports a pack that
   declares no version.

`packGradients` in `@suss/extractor` reads the counts from a run's
extraction report. Three health checks fire on those counts: a link written as a
function, a link that reads the syntax tree, and a declaration with no
example.

## The executor ops

`CallOps` is the full set of questions a chain can ask about one call
site. An adapter implements it once. Today the only implementation is
`callOpsFor` in `@suss/adapter-typescript`, which puts the result on the
recognizer context under `ops`.

| op | what it gives back |
|---|---|
| `method()` | which method the call reaches for, as the source spells it |
| `receiverIsFrom(origin)` | whether the receiver came from where the origin says |
| `isFrom(origin)` | whether the call itself came from where the origin says |
| `argumentCount()` | how many arguments the call passes |
| `nameAt(index, unsettled)` | the name that argument gives, with the hole policy applied |
| `calleeText()` | the callee, as the source writes it |
| `receiver()` | the call the receiver is, as ops of its own |
| `chainedOn()` | the call made on what this call returns, `.set(v)` for `db.update(t)` in `db.update(t).set(v)`, or null when the result is stored, returned or passed instead (optional) |
| `member()` | the member read the call is made on, `db.user` in `db.user.findMany()`, as ops whose method is the member's name (optional) |
| `file()` | the path of the file the call is in (optional) |
| `argument(index)` | the call that argument is, as ops of its own |
| `callee()` | the call the callee itself was written as |
| `namedCallee()` | whether the call goes to a name the program bound (optional) |
| `parameterReadsAt(index)` | the fields a selector lambda in that position reads off its parameter (optional) |
| `propertyAt(index, property, unsettled)` | what a named property of that argument says |
| `valueAt(index)` | the value that argument states, as `ValueOps` |

`receiver()`, `argument(index)` and `callee()` each move to a call next
to the current one and return another `CallOps` for it, so every
question above can be asked one step away. Use `callee()` for a class
that a factory made. The source writes `new User({ name })`, and what
`User` is comes from the `model("User", schema)` call that declared it.

The last two return a value instead of a call. `propertyAt` reads one
name out of an options object, for a pack that needs a bucket or a
table. `valueAt` returns the whole value, for a pack whose rule has to
walk it:

| op | what it gives back |
|---|---|
| `text()` | the string the source wrote, or null for anything else |
| `flag()` | the yes or no the source wrote, taking a number the way it takes a boolean |
| `entries(unsettled)` | what an object states, as key and value per entry |
| `items()` | what a list states, item by item |
| `property(name)` | what one named property states, as a value of its own |
| `parts()` | the pieces of text the source wrote, with the holes left out |
| `holes()` | what the source interpolated between those pieces, each as the call it was written as |
| `form()` | how the source wrote the value at this spot: `function`, `name`, `object` or `other`, without following anything |
| `ownProperty(name)` | what an object written at this spot states under one of its own keys, with spreads left out |
| `encoded()` | the value a call of one of the language's encoders was handed, and the encoding: `x` under `json` for `JSON.stringify(x)`, `json.dumps(x)`, `JSON.generate(x)` or `x.to_json`. Null for any other value |
| `shape()` | the shape the source writes the value in at this spot, without following a name |
| `readsOff(object)` | the properties the value reads off `object`, through the calls, comparisons, entries and template holes it is written from, each once in source order. A function written in the value, or a helper that built it, is not entered |

A message send records its body, and a unit invoke its payload, as the
value that went into the encoder when there is one, since the consumer
reads the fields back after decoding. Each adapter keeps its encoders
in one table beside its other language words, and matches a call the
way its other readers of a serialized value do: TypeScript by the
callee's spelling, Python by an attribute of the module the file
imported, and Ruby by the constant's text or the method on the
receiver.

A computed key such as `{ [this.tableName]: [...] }` is read like any
other name. When the source settles its value, the entry's key comes
back settled.

On an adapter with no ops, a chain matches nothing and does not throw.
A pack loaded into the wrong adapter is a configuration mistake, and it
should not crash the run.

## The ops over the facts

`@suss/recognize/ops` works out what each op returns from the facts the
resolution rules read, so an adapter that states those facts runs every
declared pack without writing `CallOps` itself. The adapter hands over a
`FactSource`: its database, and the reads only it can make. The
TypeScript, Python and Ruby adapters hand every declared pack these ops.
No shipped pack lists Python or Ruby among its languages yet.

| op | read from |
|---|---|
| `method()`, `calleeText()` | `call(r, c)`, then `readsProperty(c, o, n)` for the method, with the adapter's `memberName` turning a class's own spelling back into the plain name, or the source text of `c` |
| `argumentCount()`, `argument(k)`, `nameAt(k)`, `valueAt(k)` | `callArg(r, k, a)`, and `callArgCount` where an adapter states it |
| `receiver()`, `callee()`, `argument(k)` | a name or field followed to what it was written as, through the adapter's `writtenAs` |
| `propertyAt`, `property`, `entries`, `items` | `holdsProperty`, `writtenEntryAt` and `holdsUnderKey`, with a computed key read off `computedKeyAt` at the entry's position through `nameOf`. A call into a project function is read as the one value it returns, through `writtenAs` on the call, and a library call or a construction stays as written. An object's spread is read in its place, its name or project call followed the same way, or failing that through `comesTo`, and a key written twice keeps its first place and takes the later value. A list built by mapping is one item, read off `eachElement`: what the function a call hands over returns, from its one `returnsValue` row, or the element a comprehension writes. A list's spread is left out |
| `object()` | the value itself when it is an object written out, or else the one object among the adapter's `comesTo` answers, any function among them left out. `comesTo(x, z)` follows names and calls that return their argument, and never a factory call |
| `function()` | `func(x)` on the value itself, or else the one function among the `comesTo` answers, or else the adapter's `givesBack`: what `givesBackUnwrapped`, then `givesBack`, says a factory call returns |
| `parts()`, `holes()`, `interpolated()` | `partAt` and `holeAt` |
| `text()`, `flag()`, `name()`, `names()`, `asArg()` | the adapter's own reading of the value, `literalOf`, `nameOf`, `namesOf` and `argOf` |
| `evaluated()`, `source()`, `importedFrom()` | the adapter's evaluator through `evaluatedOf`, the text at the key through `textOf`, and the module specifier an import statement spells through `importSpecifierOf`. Ruby imports no names, so it gives no specifier |
| `form()` | the adapter's `formOf`, and `other` where it has none |
| `ownProperty(name)` | `holdsProperty` and `writtenEntryAt` on the value's own key, its spreads left out, when `shapeOf` says it is an object |
| `encoded()` | the adapter's `encodedOf`, asked of the value a name was written as, the way `asArg()` is, so an encoding kept in a name is still read. Python and Ruby find the encoded value through `call`, `readsProperty` and `callArg` |
| `shape()` | the adapter's `typeShapeOf` on the value's own key, with no name followed |
| `receiverIsFrom`, `receiverGlobal` with `global` | the adapter's `spellsGlobal` on the receiver, or else `globalsReaching`: the paths `wantedStreamValue` says reach the receiver, from every `streamObject` |
| `isFrom` with `global` | the adapter's `callsGlobal` on the call, for a call with no receiver |
| `block()` | `callBlock(r, b)`, which only Ruby states |
| `isFrom`, `receiverIsFrom` with `constructed` | the construction a receiver was written as, checked through `importedFrom` |
| `isFrom`, `receiverIsFrom` with `declaredBy` | the adapter's `declares`, since only a type checker can say who declared a method |
| `isFrom`, `receiverIsFrom` with `typed` | the adapter's `typedAs`, or the construction a receiver was written as where the adapter has none |
| `isFrom`, `receiverIsFrom` with `inherits` | the adapter's `typedInherits` where it reads declared types. Elsewhere the classes `instanceOf` says the receiver is one of, and the class each construction it was written as makes, each followed through `comesTo` and walked up `extends` to a base the adapter's `importedAs` says the module exports as a name the spec lists |
| `isFrom`, `receiverIsFrom` with `handedBy` | the receiver, or the declaration it `binds` to, as a `paramOf(f, k, p)` at the asked position, or as the block variable the adapter's `parameterOf` places, since Ruby states no `paramOf` for a block. Then the call that passes `f` as `callArg(r, 0, f)`, directly or through a name `binds` to it, or that is written with it as `callBlock(r, f)`, asked whether its method is the one asked and its receiver is from `on` |
| `member()` | the object of the callee's `readsProperty`, as ops over that member read when it is one itself, or as the call it is when that call passes no arguments |
| `chainedOn()` | the `readsProperty(c, r, m)` whose object is the call, then the `call(r2, c)` whose callee is that read: one hop of the `chainedCall` rule. A result kept in a name has none |
| `readsOff(object)` | a closure from the value's own key, with no name followed: each `readsProperty(x, o, n)` gives `n` when `o` is a name the adapter's `writtenAs` settles to what `object` settles to, or when neither settles and the adapter's `textOf` spells both the same, and goes on into `o`; `call`, `callArg`, `callKeywordArg`, `callBlock`, `compares`, `holeAt`, `conditionalBranch`, `fallbackBranch` and `writtenEntryAt` go on into what they state. A function's body has no row the closure follows, so it is not entered |
| `file()` | the file in the call's key, which every adapter writes first |
| `isFrom`, `receiverIsFrom` with `imported` | the adapter's `importedAs` on the callee or the receiver: `comesFrom(x, m, n)` over `imports`, `exportsAs` and `reExports`, so an alias and a project barrel read as the export. A value that only calls into an import does not count |
| `namedCallee` | the callee is a name: stated as none of a call, a read, an object or a written value |
| `calleeImportedAs` | the adapter's `importedAs` on the callee, kept when it gives one export other than the whole module. It is asked only when `imports` is stated for the callee or for what it `binds` to, so a parameter is never followed through its callers |
| `named` on `constructed` | the name the constructor is written with, or the export the adapter's `importedAs` says it was imported as, asked only when an import binds the constructor the way `calleeImportedAs` checks |
| `anchorCall` | the adapter's `anchorCalls`, with the single-answer policy |
| `member(name, singleton)` | `holdsProperty` on the value, or on what it `comesTo`, the last statement winning; a class's own member is spelled as `classMemberName` spells it |
| `returns()`, `marked(word)` | `returnsValue(f, v)` and `marks(f, word)` on the function `function()` settles to |
| `tag()` | `jsxElement(v, t)` on the value as written |
| `asClass()` | the value, or what it `comesTo`, stated as `objectValue` and neither written out as an object nor a function. Its `inherits(spec)` walks `extends` through `comesTo`, the way `libraryBase` does, until a base the adapter's `importedAs` says came from one of the spec's modules under one of its names; its `members(kind)` are the functions among its `holdsProperty` rows |

A read chain asks its questions of `ReadOps`, which `factReadOps` reads
the same way:

| op | read from |
|---|---|
| `entry()` | `readsProperty(x, o, n)` or `readsEntry(x, o, n)` gives `n`, and `readsKeyed(x, o, k)` gives null. At a site the facts state none of the three at, it is undefined and a chain doesn't match |
| `isOff(global)`, `objectPath(paths)` | the adapter's `spellsGlobal` on the object the site reads off, or else `globalsReaching` on it. TypeScript follows the environment objects there through `wantedEnvValue`, so `env.PORT` is off `process.env` when `env` is a parameter that defaults to it or a caller hands it. The adapter's `objectOf` gives the object without stating the site, and the rows above give it otherwise |
| `isOff(handedIn)` | `handedIn(p, n)` on the object the site reads off, which is how Python and Ruby key a parameter's reads, or on what a `binds` row takes that object to, which is how TypeScript does. Otherwise the adapter's `handedReaching`, the names the rules followed into the object through `runtimeValue`: a helper's parameter the unit passes the object to, or a local set to it. A run that states no `handedIn` row under the name stops at the first lookup |
| `readsOff()` | the adapter's `readsOff`: in TypeScript, the element read `o[k]` or the binding elements of `const { A } = o` when the site is `o`, stated as they are asked. Python and Ruby visit those sites themselves and leave it unset |
| `defaulted()`, `fallback()` | the adapter's `defaultedAt` and `fallbackOf`, each its own walk over the syntax. What counts as coping with a missing value is the language's |
| `assigned()` | `assigns(x, v)`: the site is the left side of a plain `=` and `v` the value written on the right |
| `keysSuppliedTo(object)` | the adapter's `keysSupplied` where it has one, as TypeScript does. Otherwise, for each parameter of the function `call(r, c)` comes to, the sites the adapter's `sitesNaming` says take their key from it, kept when they are off the object |

`keysSuppliedTo` is on the read ops rather than on the call's. A read
chain asks it at every call the access walk visits, and in TypeScript
building a call's ops states the call's facts, which for a call at
module scope the invocation walk never does. Asked this way, a call that
supplies no key is read off its nodes and nothing is stated.

`classAt`, `parameterReadsAt`, `statesSlots` and the two batching
hints are left out. Each comes in with the pack that reads it.
Until then an adapter adds them through `FactSource.extend`, which every
call the ops reach goes through, and TypeScript takes them from
`callOpsFor` at the same node.

The pack harness runs every recognizer that reads the ops a second time
over `callOpsFor`, and fails the test on any difference that
`tools/pack-harness/src/knownDifferences.ts` does not list with a reason.

### A unit a pattern finds

These discovery patterns are read here for every adapter, through
`discoverDeclared` over the module ops: a function a deploy manifest
says the platform calls (`manifest`), exports by name or by a pattern,
with an object's members (`namedExport`), the methods of a class that
reaches a library base (`subclassOf`), the functions a directive marks
(`marked`), and a function a call hands over (`registeredFunction`).
They are not chain endings, since a unit found by an export, a file or
a manifest is not reached from a call. `factModuleOps` answers the
module ops from these facts:

| op | read from |
|---|---|
| `exports()` | `exportsAs(file, n, v)`, or the adapter's own export table where it follows a re-export, as TypeScript's does |
| `export(path, member)` | the first name through `exports()`, then `member` for each name after it, then the member asked for. Ruby writes a nested constant in one piece too, `class Reports::Nightly`, so its module ops also try the leading names joined with `::`, and a class written both ways is two values, the first that has the member winning |
| `marked(word)` | `marks(file, word)`, once the adapter's `mentions(word)` says the file's text has the word |
| `markedFunctions(word)` | `marks(f, word)` on each function the adapter lists in the file, since TypeScript states a function's facts only when something reads it. It asks `mentions(word)` first, since stating every function of every file to find a word most files never write costs more than the rest of a run |
| `calls()` | the calls the adapter lists outside every function body, each as the fact ops for it |
| `mentions(word)` | the adapter's own `mentions`, which in TypeScript looks for the word in the file's text. Python and Ruby leave it unset, and the module ops then say yes |

`registeredFunction` with a global start and no method asks
`mentions` for each of the start's paths before it lists the calls. A
call to a global is written with the global's own name, so a file
whose text has none of them makes no such call, and listing the module
body's calls states facts for every one of them. A method on a global
can be called through a variable imported from another file, so that
form is always read.

A unit spec's `handedIn` lists the parameters the platform fills when
it calls the unit, by position and the name a read chain asks for each
under. When an adapter claims a unit, before it reads the body, it
states `handedIn(p, name)` on the parameter at each position, with
`stateHandedIn` in `@suss/resolution`. A read chain off
`handedIn(name)` then finds the reads in the body.

Each reader ends at `function()` and hands the adapter back its own
node. The TypeScript adapter runs a pattern like any other in its
discovery dispatch, and Python and Ruby run the patterns a pack lists
in `declaredDiscovery` beside their own route patterns.

### The value policy

A pack that reads a payload asks the same few questions of every value:
which object it is, which list, and what each key is called. The ops
answer them the same way in TypeScript, Python and Ruby.

```ts
records.put(rows.map(toRow));           // one item, what toRow returns
records.put(toRow(meter));              // the object toRow returns
records.put({ ...defaults(), d: 4 });   // defaults()'s entries, then d
records.put({ [key]: 1, ...config.base }); // the key's value, then base's entries
```

- A name is followed to the one value it was written as. A name written
  twice, or a parameter, has no one value, and reads as nothing.
- A call into a project function is read as the one value the function
  returns, when the pack reads an object or a list off it. A library
  call, a construction and a function with two returns stay as written,
  so a command is still read off the object it was made with. A text or
  a name keeps the call, since the adapter settles one there with the
  call's arguments in place, and reading the returned expression alone
  would lose them.
- An object's spread is read in its place, in source order, and a key
  written twice keeps its first place and takes the later value. A
  list's spread is left out of `items()`.
- A list built by mapping is one item, the value every element is built
  as: what the callback returns, when it has one return, or the element
  a comprehension writes. `forEach` and `each` build nothing, and
  Python's `list(map(f, xs))` reads nothing, since `list` is a library
  call the ops do not look through.
- A computed key is read through the expression that computes it, which
  the adapter states by the entry's position. Python and Ruby key a
  name by its scope, so in `{key: x, "e": x}` both values are the same
  key, and only the position tells the two entries apart.
- A name read through an entry with its key written out,
  `config["base"]` in Python or `CONFIG[:base]` in Ruby, does not settle
  yet, so a spread of one adds nothing. TypeScript's `config.base`
  settles through the property read.
- Nothing limits how deep a value is read. The facts are a finite set of
  rows, and an object that spreads itself is read once.

`packages/cli/src/valuePolicyLanguages.test.ts` writes each of these
cases in all three languages, with the paths a pack has to find in each.

## Reaching a call next to this one

In two of the three storage call patterns, what a pack needs is on a
different call from the one the adapter is looking at.

```ts
s3.send(new GetObjectCommand({ Bucket: "photos", Key: "a.jpg" }));
storage.bucket("photos").file("a.jpg").download();
```

In the first, every call site in the codebase is a call to `send`, and
the operation, the bucket and the key are all inside the command. In
the second, the bucket is two receivers back and the object is one
receiver back. Neither needs a new op. Both use the ops above, asked of
a different call.

A pack chooses that call with `about`, and a pick chooses its call with
`of`. Both take steps, and each step is plain data:

| step | what it reaches |
|---|---|
| `{ to: "receiver" }` | the call the receiver is |
| `{ to: "receiver", method: "bucket" }` | the first call to `bucket` up the receivers |
| `{ to: "argument", at: 0 }` | the call the first argument is |
| `{ to: "argument", at: { from: 0 } }` | every argument that is a call, first one that matches wins |
| `{ to: "argument", at: { from: 0 }, origin }` | the same, keeping only the ones the origin pins down |
| `{ to: "receiver", origin }` | the call the receiver is, when the origin pins it down, and nothing otherwise |
| `{ to: "member" }` | the member read the call is made on, `db.user` in `db.user.findMany()`, or in Ruby the call with no arguments `db.users` is |
| `{ to: "member", named: "query" }` | the same, when the member is read under that name |
| `{ to: "chained", method: "where" }` | the nearest call to `where` made out along what the call returns, `.where(c)` from `db.update(t)` in `db.update(t).set(v).where(c)` |

```ts
storageCalls({ system: "s3", client: constructedFrom("@aws-sdk/client-s3") })
  .about({ to: "argument", at: { from: 0 } })
  .methods({ GetObjectCommand: { kind: "read", selector: KEY } })
  .container({ at: 0, property: ["Bucket"] });
```

Once `about` gives a chain a subject, every other link runs against the
call the steps reached. The operation is that call's own name, the
origin check looks at that call, and a pick with no `of` reads that
call's arguments. The effect still records the original call as its
callee, because that is where a reader would go to look.

A step follows a name to the expression the source assigned to it. For
`const side = await deck.side("a")` the step reaches `deck.side("a")`
and does not stop at the await.

A step with a `method` searches up the receivers for that method
instead of counting a fixed number of hops, because
`bucket(b).file(p).download()` and `bucket(b).getFiles()` have the
bucket at different distances. The search goes as far up as the
receivers go. A receiver chain can loop back to itself through a
variable: after `x = x.next()`, the receiver of `x.next()` is
`x.next()` again. So the walk keeps the `site()` of every call it has
passed and stops when one comes round a second time.

A `chained` step searches the other way, out along the calls made on
what the call returns, through `chainedOn()`. The ops take one hop and
the walk is here, as with `receiver()`, so both walks stop the same
way. A call the walk reached as another call's receiver knows that
other call is made on its result, even when the source kept the result
in a name first: `const query = db.select(); query.from(t)` reaches
`db.select()` through `query`, and a `chained` step from there comes
back out to `query.from(t)`.

A chain whose first step goes to the arguments reads them at every
call the walk visits, since its hook runs on each call. Before the
first read it calls `readingArguments` on the ops with the positions the
step covers. The TypeScript adapter asks one store question about those
arguments for the whole walk, where it would otherwise ask one per
argument per call. An adapter that leaves the member out reads each
argument as before.

A step to an argument can also require where that argument came from.
The step asks `isFrom` of each candidate in turn. `send(command)` takes
one argument and a presigner takes two. The argument that matters is
the command the SDK declares, so the step requires that origin instead
of reading whichever argument it reaches. The modules in that origin go
into the pack's import gate, the same way a start link's modules do.

A pick reads the argument itself, or a property of the object literal
the argument is. It tries the properties in order, so `property:
["Key", "Prefix"]` means "the key, or the prefix a listing asked for
instead". A pick unwraps a construction first, because a command takes
its inputs in its constructor.

In Python and Ruby a call can pass the argument under a keyword
instead, so `{ at: 0, keyword: "query" }` reads `query=` where the call
passes it and the first argument otherwise. `path` reads down through
keys before `property` is tried: `{ at: 0, keyword: "configuration",
path: ["query", "query"] }` reads the statement in
`insert_job(configuration={"query": {"query": sql}})`.

A container written the way a statement writes a table,
`get_table("analytics.events")`, takes `.container(pick, { qualified:
true })`. The part before the table is the scope, and a name that does
not settle leaves the call without an access, the same as a statement
whose table does not settle.

`container` also takes a list of picks, tried in order until one
reaches a name, the way a statement's picks are. BigQuery's Ruby gem
offers `load` on a dataset, where the first argument is the table, and
on a table, where it is the file:

```ts
.container([{ of: [{ to: "receiver", method: "table" }], at: 0 }, { at: 0 }], { qualified: true })
```

The table the chain picked comes first, so `table.load(file)` writes
the table and `dataset.load("accounts", file)` writes `accounts`. With
`qualified`, a pick whose name is not a table falls to the next pick,
and when none of the picks settles, the call does not record an access.

## A call on a model's delegate

An ORM reads a model off the client and calls the method on that:

```ts
storageCalls({ system, client: RECEIVER, clientAt: [{ to: "member" }] })
  .methods({ findMany: READ, create: WRITE })
  .container({ of: [{ to: "member" }], naming: "upperFirst" })
  .relations({ of: { at: 0 }, by: relatedAccesses });
```

The call's own receiver is `db.user`, which nothing made, so `clientAt`
gives the steps from the call to the one whose receiver is the client.
A call with no member before its method, `db.findMany()`, reaches no
call there and does not match. The member step is a step of its own,
so a chain that climbs receivers with `receiver()` never starts seeing
member reads.

The container is the name of the member those steps reach, spelled
through a naming. `upperFirst` turns Prisma's delegate `user` back into
the model `User`. The chain settles that container before it reads the
call's inputs, so a rule gets it as `container` in what it is handed,
along with the call itself as `call`. Prisma's selector rule reads the
compound keys of that model from the schema of the project the call's
`file()` belongs to. A container the selector decides is not known yet
when the rules run, and a rule gets null for it.

A call that reads or writes through the model's relations states each
access in its options. `relations` points a rule at them, and each
access it gives back becomes one more effect after the container's own,
on the same binding and callee, with its `relationPath`. Its operation
is the call's own unless the access says otherwise, as a nested
`connectOrCreate` does, and a write of the relation's own key says
`relationKey`, which only the contract can fill in. Slots are stated
for the container's own effect only.

A library whose projects each choose a database, as a Prisma schema's
datasource does, states the store per project:

```ts
system: { byFile: (file) => schemaStorageSystem(path.dirname(file)), otherwise: "postgresql" }
```

Both the storage and the SQL endings take it, and the SQL ending's
`dialect` takes it too. The chain asks `byFile` once per effect, with the
path `file()` gives, and takes `otherwise` when that says nothing or the
adapter gives no file. Pack health counts each one as a link written as
a function, since it reads a file that is not source, and the pack goes
by `otherwise` as its wire and its name in the report.

## A call that states one request object

An AWS SDK command puts everything the call does inside one object, and
four of the things a storage effect records come from that object. Each
of the four has its own link.

```ts
storageCalls({ system: "aws.dynamodb" })
  .about({ to: "argument", at: { from: 0 }, origin: constructedFrom(...MODULES) })
  .methods(COMMANDS)
  .input({ at: 0 })
  .container({ at: 0, property: ["TableName"] })
  .accessPath({ at: 0, property: ["IndexName"] })
  .containersIn({ at: 0, property: ["RequestItems"] });
```

`input` gives the position of the call's input object. A call without
one is not a call this chain is for, so the chain stops there. A rule
the pack wrote over the inputs receives the object itself and does not
have to go looking for it at a position.

`accessPath` records which index the call went through. It pairs
against a declared index instead of against the container.

`scope` is for a client that picks its namespace on each call instead
of on the connection. Most clients pick it on the connection, and a
pack for one of those states the scope once on `storageCalls`. A
BigQuery caller writes `bigquery.dataset(d).table(t)`, so `.scope({ of:
[DATASET_STEP], at: 0 })` records each access under the dataset it went
to, and two datasets do not end up under one name.

`containersIn` is for a call that reaches several containers at once.
A batch lists them as a map with one entry per container, and the chain
yields one effect per entry. The entry's key is the container's name,
and the entry's value describes what the call did there. A chain
without `containersIn` yields the single effect for the container its
`container` link reads.

A rule the pack writes for `selector` or `fields` receives the input,
the entry when there is one, and whether the call reads or writes:

```ts
fields: ({ input, entry, kind }) =>
  (entry ?? input).property("ProjectionExpression")?.text()?.split(",") ?? [],
```

A method table with a rule inside it is still a table. Pack health
counts the link as data and reports the rule on its own.

## A rule that says which value it reads

`input` works for a library that puts everything one call does in one
object. Mongoose spreads it over two arguments:

```ts
User.find({ email }, { name: 1, email: 1 });
//        ^ selector   ^ fields
```

Both have to be rules, because a pick returns names and neither
argument states one. So a rule can declare where it reads, the same way
a pick declares its call with `of`:

```ts
find: {
  kind: "read",
  selector: { of: { at: 0 }, by: filterKeys },
  fields: { of: { at: 1 }, by: projected },
}
```

`of` is the same `OneArgument` type a pick takes, steps included, so a
rule can also read a value on another call in the chain.

A rule pointed at an argument the call left out still runs, and the
value it receives states nothing. What a missing argument means depends
on the library, so the pack has to decide. A Mongoose read with no
projection reads every field there is, while a call with no request
object is not one of these calls at all. That second check stays on
`input`.

When a method's name alone settles the answer, the table gives it as a
plain list:

```ts
findById: { kind: "read", selector: ["_id"], fields: projection(1) },
deleteOne: { kind: "write", selector: filter(0), fields: ["*"] },
```

## A query builder's chain

A query builder states one access over several calls. The table is the
first call's argument, the fields are on `.set` or `.values`, and the
columns it picks rows by are compared in `.where`, however many calls
out each one is:

```ts
db.update(users).set({ name }).where(eq(users.id, id)).returning();
```

A `chained` step reaches each of those calls, and two picks read them
as data:

```ts
update: {
  kind: "write",
  fields: { keysOf: { of: [{ to: "chained", method: "set" }], at: 0 }, otherwise: ["*"] },
  selector: { fieldsRead: { of: [{ to: "chained", method: "where" }], at: 0 }, off: { at: 0 } },
},
```

`keysOf` gives the keys of the object the pick reaches, or of every
object in a list, each once in the order first written, with a spread
read in its place as the value policy says. `under` reads the objects
under those properties instead, as a relational query's `columns` and
`with` are read. `otherwise` is what a call that states no keys reads.

`fieldsRead` gives the properties the condition reads off the value
`off` points at, through `readsOff`. `eq(users.id, id)` reads `id` off
`users`, and so does `User.id == user_id` in Python. A condition a
helper built, or one kept in a name, reads nothing, and the access
keeps its place with no selector. The object matches when it is a name
that settles to what `off` settles to, so `const u = users;
...where(eq(u.id, id))` reads `id` off `users`. Where neither settles,
as with a parameter or `this.table`, the two match when they are
spelled the same.

Neither pick is a function, so pack health counts both as data, and
neither records what it read as a slot.

A select states its table on `.from`, which every select chain has
once, and the operation is the call `.from` is made on. The chain is
about that call, and is read only at `.from`:

```ts
storageCalls({ system, client: typed({ from: ["drizzle-orm"] }) })
  .about({ to: "receiver" }, { calledAs: ["from"] })
  .methods({ select: SELECT, selectDistinct: SELECT })
  .container({ of: [{ to: "chained", method: "from" }, TABLE_CALL], at: 0 });
```

`calledAs` turns down any other call made on a select before the walk
asks anything, so `db.select().toSQL()` is not read as a select with no
table, and a call that is not `.from` costs one lookup.

## An operation passed as an argument

A project that wraps a whole API behind one helper passes the operation
as an argument. `operation` gives that argument's position. A `kind`
written with no `otherwise` means that a value missing from the table
is not one of these calls at all:

```ts
{
  operation: { at: 2 },
  kind: { asks: { at: 2 }, means: { Query: "read", PutItem: "write" } },
}
```

When the helper comes from the project and not from a library, the
pack leaves `client` out of `storageCalls`, because the helper's name
is all the pack has to match on. It passes `requiresImport` to `pack()`
with the modules a file must import before the pack reads it.

## A method whose direction the caller chooses

Most methods read or write whatever the call site looks like. A few
take the direction from the caller. In the shipped packs that is a
signed URL: the same call returns a URL for reading or for writing,
depending on the action it was asked to sign for.

```ts
kind: {
  asks: { at: 0, property: ["action"] },
  means: { read: "read", write: "write" },
  otherwise: "read",
}
```

`otherwise` is the kind when the call passes no action. It is the
library's own default.

## A statement written as SQL

A raw query shows what it read and wrote in its SQL text, and its
arguments do not. The chain passes the text to `@suss/sql`, and the
parse gives the container, the kind, the fields and the selector for
every table the statement touches:

```ts
sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: declaredBy("@prisma/client", ".prisma/client"),
})
  .methods({ $queryRaw: { statement: { at: 0 } } })
  .example('prisma.$queryRawUnsafe("SELECT id, email FROM users")');
```

One call yields one effect per table, each with its own kind. A
statement that writes one table while reading another records both.
The storage ending cannot do that, because it sets one kind for the
whole call.

`dialect` is the SQL the statements are written in, and a pack must
always state it. When the store is the database itself, the dialect is
the store's name again, as the Prisma pack above writes it. A
Cloudflare D1 database is a separate store whose statements are SQLite,
so a pack for it writes `system: "d1", dialect: "sqlite"`. There is no
default. A reader that guessed Postgres for a MySQL project would
report the wrong tables instead of none, because backtick-quoted
identifiers parse as something else entirely.

A tagged template is a call the source wrote without parentheses. The
tag is the callee and the template is the one argument. All three of
these have their statement at position 0:

```ts
prisma.$queryRaw`SELECT id FROM users WHERE id = ${id}`;
prisma.$queryRawUnsafe("SELECT id FROM users");
db.execute(sql`SELECT id FROM users`);
```

The third passes a tagged template to an ordinary call. A pick at
position 0 still reads it, because reading a value's text looks through
the tag. A pack whose client accepts the statement either way needs one
method table, and not two declarations.

The invocation walk never visits a tagged template, so `pack` runs a
chain with this ending on the access walk. The access walk visits calls
too, so it also catches the unsafe form.

Some libraries accept the statement either as the argument or under a
key of an options object, and both forms are the same call. The method
lists both picks, and they are tried in order until one returns text:

```ts
.methods({ query: { statement: [{ at: 0 }, { at: 0, property: ["query"] }] } })
```

### The namespace a statement states

A BigQuery table is written `` `project.dataset.table` ``. `@suss/sql`
splits the name, so the container is the table a provider declares and
the dataset becomes the scope of the access. A statement that qualifies
nothing records the scope the call states, when the chain has a
`scope` link, and the scope the pack was built with otherwise. A Ruby
caller writes `bigquery.dataset("core").query(sql)`, so the pack's
`.scope({ of: [DATASET_STEP], at: 0 })` puts a bare `events` under
`core`, and a table the statement qualifies keeps its own dataset.

### A hole that is a table

`parts()` returns the text on either side of each hole. By default,
whatever the query interpolated goes into the statement as a parameter,
as it would at runtime. Drizzle does not
fit that: a Drizzle query passes the schema object to say which table
it reached.

```ts
db.execute(sql`UPDATE ${users} SET name = ${name} WHERE id = ${id}`);
```

Written as `UPDATE $1 SET name = $2 WHERE id = $3`, that does not
parse, and the query goes unread. Nothing in the SQL says the first
hole is a table and the other two are values, so the pack declares it:

```ts
sqlStatements({ system: "postgresql", dialect: "postgresql", client })
  .methods({ execute: { statement: { at: 0 } } })
  .interpolating({ from: constructedFrom("drizzle-orm"), named: { at: 0 } });
```

`holes()` returns each hole as the call the source wrote it as.
`${users}` comes back as the `pgTable("users", {...})` call in its
schema file, and `named` reads the name from it the way any pick reads
an argument. `from` stops the pack from reading a hole the library did
not make. A hole that is not a call, or that came from somewhere else,
stays a parameter.

### A hole the source itself settled

A project keeps a table name in a module constant and interpolates it:

```ts
const TABLE = "analytics-prod.core.dim_account";
bigquery.query(`SELECT id, name FROM \`${TABLE}\``);

const USERS = "users";
pool.query(`SELECT id FROM ${USERS} WHERE id = $1`, [id]);
```

No pack declares that hole as a table, and the hole is a name instead
of a call, so `interpolating` cannot reach it. The compiled chain asks
the evaluator what each hole comes to and passes the result to
`@suss/sql`. `@suss/sql` writes a settled hole into the statement only
where the statement expects a name. That is inside a quoted name,
which is how BigQuery addresses a table, and directly after `FROM`,
`JOIN`, `INTO`, `UPDATE` or `TABLE`, which is where Postgres code
nearly always puts one.

A hole anywhere else stays a parameter, because a constant written into
a value position would parse as a column and end up in the selector. A
hole in a name position that nothing settled also stays a parameter.
The access is then dropped, so it is never recorded against a table
called `$1`.

### The values a statement's placeholders take

A method can say where the call passes the values its placeholders
take, tried in order the way `statement` is:

```ts
.methods({
  query: {
    statement: [{ at: 0 }, { at: 0, property: ["text"] }],
    parameters: [{ at: 1 }, { at: 0, property: ["values"] }],
  },
})
```

`@suss/sql` says which placeholder gives each column its value, and
the compiled chain hands the value it finds for each one to the
adapter through `statesSlots`, so the summary can record where the
value came from. A template's holes are numbered in order, so there
the hole is the value, unless the template's text writes placeholders
of its own. A method without `parameters` still records the access.

## The value a call states for each column

An adapter that wants to know where each column's value came from
listens through `statesSlots` on the call's ops. A storage chain finds
the values without the pack saying anything more: the rule that
reports the columns reads them off the values the call states, and
the compiled chain notes every entry and property the rule reads.
Each column the rule reports is given the values it read under that
name. `where: { tenantId: req.auth.tenantId }` gives `tenantId` the
expression written there, and a column the rule reported from a fixed
list gets nothing.

What a rule reads is not always where the values are. Prisma's read
lists its columns under `select` as flags, so a rule that reads
`select: { id: true }` would give `id` the value `true` on every read.
A chain like that declares its slots instead, as paths under its input:

```ts
storageCalls({ system: "postgresql", client })
  .methods({ ... })
  .slots({
    selector: [["where"]],
    field: [["data"], ["create"], ["update"]],
    fieldsOn: ["write"],
  });
```

Each entry of the object at a selector path is the value for the
selector column with its key, and the same for a field path, in the
order the source writes them. `fieldsOn` says which kinds of access
state field slots; unset, every kind does. A chain whose calls state
no slots says `.slots("none")`. A chain with the link never records
what its rules read. `slotsDeclared` is the same reading, exported, so
a pack still written as code, as the Prisma pack is, states the same
slots from the same declaration.

The TypeScript adapter writes the slots it hears as provenance. The
Python and Ruby adapters run a declared hook without listening for its
slots, so a chain's slots reach their summaries only once they do.

## A send whose channel is on the client

The `messageSend` ending was written against the AWS SDK, where a
command states the queue beside the message. A job queue such as
BullMQ states it once, when the queue is built, and each add passes
only the job:

```ts
const emails = new Queue("emails");
await emails.add("welcome", { userId });
```

A channel part can be an argument pick instead of a property, so the
pack reads the queue off the construction the receiver was made by:

```ts
messageSends({
  wire: "bullmq",
  client: constructedFrom({ from: ["bullmq"], named: ["Queue"] }),
  messages: { each: "theInput" },
  channel: [{ argument: { of: [{ to: "receiver" }], at: 0 } }],
  body: { whole: "message" },
  routingKey: { at: 0 },
  unsettledName: "nothing",
}).methods({ add: { input: { at: 1 } } });
```

Three more things follow from the add taking its job as positional
arguments. `body: { whole: "message" }` records the message itself as
the body, since `data` is its own argument. `routingKey` takes an
argument pick as well as a property, so the job name is recorded as the
routing key and stays out of the channel. And `{ each: "inTheInput" }`
reads a call whose input is the list of messages itself, as
`addBulk([{ name, data }, ...])` is.

A receiver a project function made, such as a queue built inside
`createJobsQueue()` and kept in a module-level singleton, is the
construction that function returns. The TypeScript adapter works out
both the origin check and the `{ to: "receiver" }` step with the same
store question, so the call the chain checks is the call it then reads.

## A send whose arguments are the message

A project's own dispatcher takes the subject and the body as separate
arguments, `dispatcher.dispatch("order.placed", order)`, so there is no
one value to read the message off. `{ each: "theCall" }` says the call
is the message, a method entry needs no `input`, and the channel and
the body are each an argument pick:

```ts
messageSends({
  wire: "aws_sqs",
  client: typed({ from: ["@acme/async"], named: ["CommandDispatcher"] }),
  messages: { each: "theCall" },
  channel: [{ argument: { at: 0 } }],
  body: { argument: { at: 1 } },
  unsettledName: "nothing",
}).methods({ dispatch: {} });
```

`configuredSends(spec, wire)` builds these from a dependency stub's
statement. A subject nothing settles records the send with no channel,
the way the SDK sends read theirs.

## A callback a call hands over

A query hook takes the function it runs either as an argument or as a
property of its options. The pack lists where to look, in order:

```ts
callbacks({ client: constructedFrom("@tanstack/react-query", "react-query") })
  .methods({
    useQuery: {
      callback: [
        { written: "here", at: 0, property: ["queryFn"] },
        { written: "callback", at: 1 },
        { written: "here", at: 1, property: ["queryFn"] },
      ],
    },
  })
  .schedules({ via: "asWritten", unread: { missing: "missing-query-function", other: "non-literal-query-function" } })
  .unitWhenInPlace({ kind: "scheduled-callback", name: ["parent", "callee", "countPerCallee"] });
```

The first pick that finds a value settles which function the call
runs. `written: "callback"` takes the argument when the source writes a
function there or a name, and passes over anything else: a name for an
object is the call's options, and `undefined` says the call passes no
function in that place. `written: "here"` reads an object the call
writes out, by its own keys, so an object passed by name and a property
only a spread brings in are not read. `written: "block"` reads the block
a Ruby call is written with. A pick can take a `keyword`, as an
argument pick does, for Python and Ruby.

The effect records the callee as `via`, and `callbackRef` says what was
found: `literal` for a function written in place, the name for a name,
and the pack's `unread` reasons for anything else or for nothing.

`.unitWhenInPlace` compiles to the pack's `subUnits` hook. The adapter
runs it for a unit and hands it `calls(parent)`, the calls the parent's
body runs in source order, the ones in functions it runs inline
included. The hook matches each call the way the recognizer does and
claims the callback when its `form()` is `function`, handing back the
adapter's own node through `ast()`. The name is built from the parts in
order: the parent's name, `.` and the callee, `#` and how many claims
under that callee came before it in the parent. A callback written
inside another claimed one still belongs to the parent, because the
calls are not cut at a claim.

## A write to one of the process's streams

`streamWrites` records a write to stdout or stderr. Nothing pairs
against it, since whoever reads a stream is a person or a shell. The
client is usually a `global`, and each method says which stream it
writes to, or `receiver` for the stream it is called on:

```ts
streamWrites({
  streams: { "process.stdout": "stdout", "process.stderr": "stderr" },
  client: anyOf(
    global("process.stdout", "process.stderr"),
    typed({ from: [GLOBAL_MODULE], named: ["NodeJS.WriteStream"] }),
  ),
}).methods({ write: { to: "receiver" } });
```

`streams` gives the stream for each path `receiverGlobal` can return.
A receiver matched only by its type, or one two paths reach, writes to
no stream in particular, and so does a method with a stream of its own
when its receiver matched only by type: a `Console` parameter could be
an instance made with any streams. `typed` from `GLOBAL_MODULE` reads
the parameter's annotation as the source writes it, since no file
imports a type the runtime declares.

The payload is read through the ops. One value written through an
encoder is recorded as what went in, with `serialized: "json"`, and so
is one a template puts nothing but whitespace around, the way a command
ends its JSON report with a newline. Any other single value is recorded
as `text` with its own `shape()`, and several values become a record
keyed by position. The effect's `groupId` is `callSiteKey` of the
effect.

## A read of a runtime object

`runtimeReads` records a read of an object the runtime provides and
nothing declares, such as the environment:

```ts
runtimeReads({ object: global("process.env"), deployment })
  .entries({}, { reads: "config" })
  .throughHelpers();

runtimeReads({ object: global("process") })
  .entries({ argv: { reads: "config", named: "argv", callee: "site" }, cwd: META })
  .writes({ exitCode: { changes: "state" } });

runtimeReads({ object: handedIn("env"), deployment })
  .entries({}, { reads: "config" });
```

The object is a global the source spells, or `handedIn(name)`, a
parameter the platform fills when it calls a unit, as a Worker's
trigger is handed its bindings. A dotted callee spells a handed-in
object by its name, so `settings.GREETING` reads as `env.GREETING`
whatever the project calls the parameter.

`entries` says what a read of each entry is: a config read, which pairs
against whatever declares the entry, a metadata read, which records
that the unit depends on the runtime and pairs with nothing, or no read.
`otherwise` covers every entry the table does not list, and a key the
program works out at run time is read through it with no name. A
callee is `dotted`, the object's path and the entry however the read
was written, `site`, the read as written, or `object`, the path alone.
A config read is dotted unless it says otherwise and a metadata read is
the site. An empty key isn't read. A config entry with `indexed` reads
the entries off its own value too, each under the name `indexed` gives
it: `process.argv[2]` is `argv[2]`, beside the read of `argv`, with the
read as written for its callee. A position the program works out at run
time adds nothing, since the read of `argv` covers it.

The chain runs on the access walk, which visits property reads and
calls. At a property read it reports the read when the site is off the
object. When the site is spelled as the object itself, as `process.env`
is, it also reports the reads off it that the walk never visits, the
adapter's `readsOff`, from this site. A bracket read and a destructured
one are reported at the site the walk visits, which keeps a multi-line
destructuring on the line its object is on.

An entry `writes` lists gives a state change when the site is assigned
to, with the number the value settles to or its source as written, and
is read through `entries` otherwise. `writes({}, { changes: "nothing" })`
makes an assignment to any entry no read at all, which is what the
Node pack says of `process.env.X = v`.

`throughHelpers()` reads a key a call passes down to a read off the
object: `requireEnv("TABLE")` passes `TABLE` to the `name` that
`process.env[name]` reads, so the call records a read of `TABLE`. A key
the caller's own parameter forwards belongs to whoever calls the
caller. Each name is read once, in the order the arguments first pass
it, and it is defaulted when every site that reads it copes with a
missing value or the call itself does. Its callee spells the object
its first site reads. A site the chain counts as a write is left out,
so `setEnv("TABLE", v)` into `process.env[name] = value` reads nothing.

`getters` reads a call on the object that takes the key as an
argument, Python's `os.environ.get("B", "d")` or Ruby's
`ENV.fetch("B", "d")`. The table says where the key is and where the
fallback can be, and a getter that raises without one is not defaulted
when the call passes none. No shipped pack declares a getter yet.

## The example every declaration states

```ts
.example('redis.get("user_online:42")')
```

`runExamples(pack, run)` passes each declaration's example to the
compiler the caller supplied and returns what came out. A pack's test
asserts the effect the example states. When an example stops matching,
the pack's test fails, and the documentation cannot go wrong without
anyone noticing. `examplesMissing(pack)` lists the declarations with no
example.

## Ordering

Each link is a guard, so the compiled hook checks the cheapest one
first. Looking a method up in a table costs nothing, while following a
receiver to the library that made it means walking declarations. A link
that changes what the receiver is, the way Prisma's model property
will, needs the links checked in declared order again. That change goes
in `compile.ts`.
