# How a pack declaration is compiled

The [README](./README.md) says what `@suss/recognize` is for.

## The four jobs a pack does

A pack does four jobs: it discovers units, it recognizes calls inside
them, it declares terminals, and it claims sub-units. The design writes
all four as the same chain of links, differing only in what the last
link yields. Today recognition and sub-units are written that way.

```
where the match starts -> which method -> read the arguments -> yield
                                                                effects
                                                                a unit
                                                                a terminal
                                                                a sub-unit
```

Ten endings are built. Eight yield effects: `storageAccess` asks the
call what it reached, `sqlAccess` reads the statement the call was
given, `messageSend` and `unitInvoke` read the object the call sends,
`messageReceive` reads the message a handler decodes, `schedule` reads
the callback the call hands over, `streamWrite` reads what the call
writes to a stream, and `runtimeRead` reads a value off an object the
runtime provides. `httpRequest` yields the requests a call sends,
which the adapter's client walk turns into client units. `claims`
records nothing on the call's unit. A `callbacks` or `renderedProps`
chain that ends in it, like a schedule chain, says what a callback
written in place becomes, which is how a pack claims a sub-unit as
data.

Discovery is declared as data too, as patterns every adapter reads
through the module ops (see [A unit a pattern finds](#a-unit-a-pattern-finds)),
and those patterns are not chains. Terminals still come from the pack's
terminal patterns. A job written as a chain becomes a new member of
`Ending`, with its own entry in the `YIELD` table in `compile.ts`.

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
| `allOf` | a receiver every one of several origins accepts, asked in order | yes |
| `readOff` | a member read off a runtime object: `env.SESSIONS` off the `env` a Worker is handed | yes |
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
`node_modules` or in a copy of the module its generator wrote. A type
the runtime declares, listed under `GLOBAL_MODULE`, is imported by no
file, so its name is enough: a parameter's annotation as written,
`NodeJS.WriteStream`, or the name of one of the receiver's own types,
`KVNamespace` on a Worker's `env.SESSIONS` through its `Env` interface.
When the checker cannot resolve the type, TypeScript reads the names
written on the declaration, and a local with none is read through what
it was set to.

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

`readOff(object)` takes a receiver that is a member read off a
`RuntimeObject`, the object a read chain starts from. A Worker's
bindings arrive in `env`, so `env.SESSIONS.get(key)` is made on a
member read off `handedIn("env")`. The receiver is asked the way a read
site is, so a local set to `env`, a helper's parameter `env` is passed
to, and a cast around it all count, and a member put in a local first,
`const sessions = env.SESSIONS`, is followed through its declaration.
Which store a binding is comes from its type, so the Workers pack writes
`allOf(readOff(handedIn("env")), typed({ from: [GLOBAL_MODULE], named:
["KVNamespace"] }))`. `allOf` asks its origins in order and stops at the
first that refuses, so a pack lists the cheap one first.

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

`spelled(...names)` takes a receiver, or a call with no receiver,
written as one of the names, whatever the program binds the name to.
It reads the source text and asks no rules. fetch needs it, because
a `fetch` a caller hands in, or one a fetch library exports, is nearly
always an implementation of fetch, and `global("fetch")` leaves out
every name the program binds itself.

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
site. There are two implementations. `callOpsFor` in
`@suss/adapter-typescript` reads TypeScript's syntax and checker, and
the ops over the facts in the next section answer the same questions
for every adapter. The adapter puts the result on the recognizer context
under `ops`.

| op | what it gives back |
|---|---|
| `method()` | which method the call reaches for, as the source spells it |
| `receiverIsFrom(origin)` | whether the receiver came from where the origin says |
| `isFrom(origin)` | whether the call itself came from where the origin says |
| `argumentCount()` | how many arguments the call passes |
| `nameAt(index, unsettled)` | the name that argument gives, with the hole policy applied |
| `calleeText()` | the callee, as the source writes it |
| `receiver()` | the call the receiver is, as ops of its own |
| `receiverValue()` | the value the method is called on as the source writes it, `db` in `db.query(User)` and `Orders.query()` in `Orders.query().first()`, with no name followed (optional) |
| `chainedOn()` | the call made on what this call returns, `.set(v)` for `db.update(t)` in `db.update(t).set(v)`, or null when the result is stored, returned or passed instead (optional) |
| `member()` | the member read the call is made on, `db.user` in `db.user.findMany()`, as ops whose method is the member's name (optional) |
| `file()` | the path of the file the call is in (optional) |
| `argument(index)` | the call that argument is, as ops of its own |
| `callee()` | the call the callee itself was written as |
| `namedCallee()` | whether the call goes to a name the program bound (optional) |
| `calleeImport(modules)` | the export of one of the modules that the file's own import statement binds the callee to, read off the import and nothing past it (optional) |
| `callsInCallee()` | the calls written in the project function the call reaches, nested functions included, in source order (optional) |
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
| `writtenItems()` | the text of each item of a list written at this spot, a spread as written, without following a name; null for anything else |
| `listed()` | the list a value comes to through names, without following a call, as its key and each entry the source writes, a spread marked as one |
| `property(name)` | what one named property states, as a value of its own |
| `parts()` | the pieces of text the source wrote, with the holes left out |
| `holes()` | what the source interpolated between those pieces, each as the call it was written as |
| `form()` | how the source wrote the value at this spot: `function`, `name`, `object` or `other`, without following anything |
| `ownProperty(name)` | what an object written at this spot states under one of its own keys, with spreads left out |
| `encoded()` | the value a call of one of the language's encoders was handed, and the encoding: `x` under `json` for `JSON.stringify(x)`, `json.dumps(x)`, `JSON.generate(x)` or `x.to_json`. Null for any other value |
| `shape()` | the shape the source writes the value in at this spot, without following a name |
| `readsOff(object)` | the properties the value reads off `object`, through the calls, comparisons, entries and template holes it is written from, each once in source order. A function written in the value, or a helper that built it, is not entered |
| `comparisons()` | the operands the value compares when it is a comparison, one entry for each pair of neighbouring operands with the operator between them: `User.id == x` is `User.id`, `==`, `x`. Empty for any other value |
| `className(notFrom)` | the name of the class the value is, or is one of, as the adapter reads it. A value declared as a type from one of `notFrom`'s modules gives null |
| `runtimePath(object)` | the path among a runtime object's that the value is: the one it is spelled as, or the object's first path when the rules followed the object into it. Undefined when it is not the object |
| `mentions({ calls, options })` | whether the value is written with a call to one of `calls` or sets one of `options`, through its receivers, arguments, entries and fallback branches. A function written in the value is not entered |

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
The SQLAlchemy and BigQuery Python packs list `python` among their
languages, and the pg and BigQuery Ruby packs list `ruby`.

| op | read from |
|---|---|
| `method()`, `calleeText()` | `call(r, c)`, then `readsProperty(c, o, n)` for the method, with the adapter's `memberName` turning a class's own spelling back into the plain name, or the source text of `c` |
| `argumentCount()`, `argument(k)`, `nameAt(k)`, `valueAt(k)` | `callArg(r, k, a)`, and `callArgCount` where an adapter states it |
| `receiver()` | a name or a field followed to what it was written as, through the adapter's `writtenAs`, and then through a call into a project function to what it returns |
| `callee()`, `argument(k)` | a name followed to what it was written as, through the adapter's `writtenAs`. A field is not followed, since the readers of a command object rely on reading a name alone |
| `returnedCall()` | the one `returnsValue(f, x)` row of the function the callee comes to, when `x` is a call whose `callArg` rows are `f`'s parameters at their own positions and nothing else |
| `dropped(owned)` | the adapter's `dropped`: Python asks the shared `passedOn` rules about the one local the call's value is written to. TypeScript and Ruby drop nothing |
| `callerSite()` | the `makesCall(f, r)` row on the call, or null for a call at the top of a file |
| `enclosingBody()` on a call | the `makesCall(f, r)` rows on the call, the one whose `f` starts last. TypeScript and Python state one, and Ruby states one for the method and one for each block around the call, so the last is the innermost block |
| `enclosingBody()` on a value | the `enclosingBody()` of the call a block is written with, through `callBlock(r, b)`, or of the call `passedTo()` gives; else the `containsFn(f, g)` rows on the value, the one whose `f` starts last. Ruby states `containsFn` from the method around a block or a lambda, so the call is asked first |
| `propertyAt`, `property`, `entries`, `items` | `holdsProperty`, `writtenEntryAt` and `holdsUnderKey`, with a computed key read off `computedKeyAt` at the entry's position through `nameOf`. A call into a project function is read as the one value it returns, through `writtenAs` on the call, and a library call or a construction stays as written. An object's spread is read in its place, its name or project call followed the same way, or failing that through `comesTo`, and a key written twice keeps its first place and takes the later value. A list built by mapping is one item, read off `eachElement`: what the function a call hands over returns, from its one `returnsValue` row, or the element a comprehension writes. A list's spread is left out |
| `object()` | the value itself when it is an object written out, or else the one object among the adapter's `comesTo` answers, any function among them left out. `comesTo(x, z)` follows names and calls that return their argument, and never a factory call |
| `function()` | `func(x)` on the value itself, or else the one function among the `comesTo` answers, or else the adapter's `givesBack`: what `givesBackUnwrapped`, then `givesBack`, says a factory call returns |
| `parts()`, `holes()`, `interpolated()` | `partAt` and `holeAt`, on the value a name was written as, or on what a call into a project function returns, through `writtenAs` on the call, so a statement a helper builds keeps its pieces. A value written as neither a literal nor a template takes its parts from the adapter's `partsOf`, which Python reads through its evaluator, so `"SELECT id" + " FROM users"` has parts and no holes |
| `keywordNames()` | the `callKeywordArg(r, n, v)` rows of the call, each `n` once, in the order the adapter states them, which is the order the call writes them |
| `passedTo()` | the one `callArg(r2, k, r)` or `callKeywordArg(r2, n, r)` row whose value is the call, giving `r2` and the position or keyword. A result kept in a name has none. On a value it is the same row with the value in place of the call, so a function written as an argument gives its call, and a Ruby block, which no `callArg` row states, gives none |
| `bindsAtTopLevel(name)` on a module | the adapter's `ModuleWritten.bindsAtTopLevel`, since no fact is keyed by file for a declaration the file does not export. TypeScript reads the file's imports and top-level declarations; Python and Ruby list none yet, and the op is unset there |
| `text()`, `flag()`, `name()`, `names()`, `asArg()` | the adapter's own reading of the value, `literalOf`, `nameOf`, `namesOf` and `argOf` |
| `literal()` | the adapter's `literalOf` on the value's own key, where `text()` asks it of what a name was written as |
| `evaluated()`, `source()`, `importedFrom()` | the adapter's evaluator through `evaluatedOf`, the text at the key through `textOf`, and the module specifier an import statement spells through `importSpecifierOf`. Ruby imports no names, so it gives no specifier |
| `form()` | the adapter's `formOf`, and `other` where it has none |
| `ownProperty(name)` | `holdsProperty` and `writtenEntryAt` on the value's own key, its spreads left out, when `shapeOf` says it is an object |
| `encoded()` | the adapter's `encodedOf`, asked of the value a name was written as, the way `asArg()` is, so an encoding kept in a name is still read. Python and Ruby find the encoded value through `call`, `readsProperty` and `callArg` |
| `decodes()` | the adapter's `decodedOf` on the call, over a `DECODERS` table beside its encoders: `JSON.parse` in TypeScript, `json.loads` in Python, `JSON.parse` and `JSON.load` in Ruby. What the call gives back is the value at the call's own key |
| `read()` | `readsProperty(x, o, n)` or `readsEntry(x, o, n)` at the value, with `memberName` as `member()` reads it. A name is followed through one declaration by `binds`, the way `member()` follows one, and gives the one read among what it is bound to, so `const text = record.body` reads as `record.body` |
| `memberRead()` | the same rows at the value's own key, with no name followed. Where the adapter says `readsMembersAsCalls`, as Ruby does, a `call(x, c)` with no `callArg`, `callKeywordArg` or `callBlock` rows reads as the read its callee `c` is, so `Entry.id` is `id` off `Entry` |
| `element()` | `elementOf(x, over)` on the value, or on what its one `binds` row takes it to, which is how TypeScript keys a loop's or a callback's variable through its declaration |
| `typed(origin)` | the adapter's `valueTypedAs` on the value. Where an adapter has none, as in Ruby, the construction the value was written as, checked the way `constructed` is |
| `keysRead()` | the read sites the adapter's `readSitesOf` lists, which TypeScript states as it is asked. Otherwise the `readsProperty` and `readsEntry` rows off the value, off each name `binds` takes to it, and off each reference `binds` takes to that name, with the adapter's `readsOff` on each. A site that is the callee of a `call` row, or has an `assigns` row, is left out, and the keys come in the order the sites are written, from the span in each key |
| `shape()` | the adapter's `typeShapeOf` on the value's own key, with no name followed |
| `receiverIsFrom`, `receiverGlobal` with `global` | the adapter's `spellsGlobal` on the receiver, or else `globalsReaching`: the paths `wantedStreamValue` says reach the receiver, from every `streamObject` |
| `isFrom` with `global` | the adapter's `callsGlobal` on the call, for a call with no receiver, or in Python one whose callee the file's imports spell as the path: `os.getenv(...)`, and `getenv(...)` after `from os import getenv` |
| `block()` | `callBlock(r, b)`, which only Ruby states |
| `nestedBodyCall()` | a `nestedBodyCall(r)` row on the call |
| `isFrom`, `receiverIsFrom` with `constructed` | the construction a receiver was written as, checked through `importedFrom` |
| `isFrom`, `receiverIsFrom` with `declaredBy` | the adapter's `declares`, since only a type checker can say who declared a method |
| `isFrom`, `receiverIsFrom` with `typed` | the adapter's `typedAs`, or the construction a receiver was written as where the adapter has none |
| `isFrom`, `receiverIsFrom` with `inherits` | the adapter's `typedInherits` where it reads declared types. Elsewhere the classes `instanceOf` says the receiver is one of, and the class each construction it was written as makes, each followed through `comesTo` and walked up `extends` to a base the adapter's `importedAs` says the module exports as a name the spec lists |
| `isFrom`, `receiverIsFrom` with `handedBy` | the receiver, or the declaration it `binds` to, as a `paramOf(f, k, p)` at the asked position, or as the block variable the adapter's `parameterOf` places, since Ruby states no `paramOf` for a block. Then the call that passes `f` as `callArg(r, 0, f)`, directly or through a name `binds` to it, or that is written with it as `callBlock(r, f)`, asked whether its method is the one asked and its receiver is from `on` |
| `member()` | the object of the callee's `readsProperty`, as ops over that member read when it is one itself, or as the call it is when that call passes no arguments. A name is followed through one declaration by `binds`, two rows in TypeScript (reference to declaration to value) and one in Python and Ruby, and counts when the value is read off something: `const users = db.users` reads as `db.users`, and `const db = new Client()` gives no member |
| `chainedOn()` | the `readsProperty(c, r, m)` whose object is the call, then the `call(r2, c)` whose callee is that read: one hop of the `chainedCall` rule. A result kept in a name has none |
| `receiverValue()` | the object of the callee's `readsProperty`, as written, with no name followed |
| `comparisons()` | the `comparesWith(c, l, o, r)` rows on the value's own key, in the order stated, which Python and Ruby state for their comparison operators and TypeScript does not |
| `className(notFrom)` | the adapter's `classNameOf`, which Python reads the way its storage reader reads a model: a CapWords name is its own class, a variable is the class its annotation or the call it is assigned from gives, an attribute is its CapWords member or what it is read off, and a call is its callee's class or its first argument's. Elsewhere the name of the class `asClass()` settles the value to |
| `readsOff(object)` | a closure from the value's own key, with no name followed: each `readsProperty(x, o, n)` gives `n` when `o` is a name the adapter's `writtenAs` settles to what `object` settles to, or when neither settles and the adapter's `textOf` spells both the same, and goes on into `o`; `call`, `callArg`, `callKeywordArg`, `callBlock`, `compares`, `holeAt`, `conditionalBranch`, `fallbackBranch` and `writtenEntryAt` go on into what they state. A function's body has no row the closure follows, so it is not entered |
| `file()` | the file in the call's key, which every adapter writes first |
| `isFrom`, `receiverIsFrom` with `imported` | the adapter's `importedAs` on the callee or the receiver: `comesFrom(x, m, n)` over `imports`, `exportsAs` and `reExports`, so an alias and a project barrel read as the export. A value that only calls into an import does not count |
| `namedCallee` | the callee is a name: stated as none of a call, a read, an object or a written value |
| `calleeImportedAs` | the adapter's `importedAs` on the callee, kept when it gives one export other than the whole module. It is asked only when `imports` is stated for the callee or for what it `binds` to, so a parameter is never followed through its callers |
| `calleeImport` | the `imports` rows of the callee, or of what it `binds` to, under one of the modules, kept when they give one export other than the whole module. TypeScript reads the import statement itself through `importedUnder`, which states nothing |
| `receiverSettledFrom` with `imported` | the `imports` rows of the receiver, or of what it `binds` to, read the way `calleeImport` reads them, with `*` for a whole module. A member read off a name an import binds is the member of that module. A name no import binds is from no import, unless `writtenAs` settles it to a name one does, and a parameter is never followed through its callers, the way `calleeImportedAs` never follows one. An import of a file in the run, which `importsFile` states or the fact source's `importsProjectFile` says, leaves the answer open, since the rules follow a project module's own names |
| `receiverSettledFrom` with `constructed` | the construction the receiver was written as, as `constructed` reads it, with the `imports` rows of the name the construction's callee starts from in place of `importedFrom`. A callee written with a name the origin does not ask for is from no construction, and a name no import binds leaves the answer open |
| `calleeSettledFrom` | the callee of a call with no receiver, read the way `receiverSettledFrom` with `imported` reads a receiver |
| `url(site)` | the adapter's `urlOf`, handed the call and argument the value was read off by `valueAt` or `keywordAt`, since a name in Python or Ruby has a key and no node, and two assignments to one name share it |
| `constructionSites()` | the adapter's `constructionSitesOf` on the call |
| `callsInCallee` | `makesCall` closed over `containsFn` from the function `functionBehind` settles the callee to, in source order, the way `callInBody` reads a body. TypeScript keeps the checker's callee, `helperCalleeOf`, and the calls under it, and hands each one out as ops that read `method()` and `calleeText()` off the node and state the call only when a chain asks it something more |
| `runtimePath(object)` | the adapter's `runtimePathOf`. TypeScript asks `isEnvironmentValue` and then `environmentReadOff`. Python and Ruby take the path the value is spelled as, and otherwise ask `wantedEnvironmentValue` whether an environment spelled as one of the paths reaches it. So the object has to be one of the run's environments. An adapter without it reads `spellsGlobal`, `globalsReaching` and the `handedIn` rows the way a read site's object is read |
| `mentions(words)` | a closure from the value's own key over `call` to the callee and `readsProperty` to its object, `callArg`, `holdsProperty` and `callKeywordArg` to a value, and `fallbackBranch` and `conditionalBranch`. A method's name is the `readsProperty` name, a bare callee's is the export its `imports` row gives, and an option is a `holdsProperty` or `callKeywordArg` name. A key stated as `func` is not entered |
| `named` on `constructed` | the name the constructor is written with, or the export the adapter's `importedAs` says it was imported as, asked only when an import binds the constructor the way `calleeImportedAs` checks |
| `anchorCall` | the adapter's `anchorCalls`, with the single-answer policy |
| `member(name, singleton)` | `holdsProperty` on the value, or on what it `comesTo`, the last statement winning; a class's own member is spelled as `classMemberName` spells it |
| `returns()`, `marked(word)` | `returnsValue(f, v)` and `marks(f, word)` on the function `function()` settles to |
| `tag()` | `jsxElement(v, t)` on the value as written |
| `attributes()` | `jsxAttribute(v, n, x)` on the value as written, ordered by where `x` is written, the first row of each `n` kept |
| `elementsWithin()` | the `jsxParent(c, v)` rows on the value as written, each `c` in source order |
| `listed()` | `writtenEntryAt(c, k, x, form)` on the value as written, in the order of `k`, when `shapeOf` says it is a list. The value as written follows a name and never a call, so a list a function returns is no list here, where `items()` reads it. A spread is an entry with the form `spread`, where `items()` leaves it out, and the list's own key says which list it is |
| `elements(tag)` | the adapter's `elementsOf` on the function `function()` settles to, which states `writesElement` for every element written under it and the element's `jsxElement`, `jsxAttribute`, `jsxSpread` and `jsxChild` rows. It keeps the elements whose `jsxElement` tag the adapter's `textOf` spells as `tag`, in source order. Each element's `props()` are its `jsxAttribute` names, its `spreads()` the values of its `jsxSpread` rows, and `hasChildren()` says whether it has a `jsxChild` row. An adapter that writes no JSX leaves `elementsOf` unset, and the op gives nothing |
| `declaration()` | the adapter's `declarationOf` where it has one. TypeScript reads the declaration a name `binds` to, and for an import binding follows `imports(d, m, n)` to what the store's export table gives for `m` under `n`, with each module stated only as far as its export statements; a variable, function or class gives its name, a name leads on to what it binds to, and anything else gives its file and no name. Without `declarationOf`, `imports(x, m, n)` on the value leads to the `exportsAs(m, n, v)` row, following `v` on when it is imported in turn, and otherwise the `exportsAs` row of the value or of what it `binds` to gives the file and the name, which is how Python states a module-level def and Ruby a top-level class or constant. When neither gives an answer and the value is a member read, `readsProperty(x, o, n)`, it is declared where `property(n)` of `o`'s `object()` is, so `Card.Root` with `Card = { Root: CardRoot }` is declared where `CardRoot` is. TypeScript asks this of the expression inside `Slider.Root<number>`. Null when nothing is behind it |
| `parameterAt(fn)` | the position `k` of a `paramOf(f, k, p)` row on the function `fn` settles to, where `p` is the value itself (how Python and Ruby key a name for a parameter), what it `binds` to (how TypeScript does), or the parameter whose destructure has that declaration as its rest, `restOf(d, p)`. Null for none, or for two positions |
| `writtenItems()` | the adapter's `writtenItemsOf` on the value as written: an array literal's elements in TypeScript, a list's, tuple's or set's children in Python, and an array's children in Ruby |
| `asClass()` | the value, or what it `comesTo`, stated as `objectValue` and neither written out as an object nor a function. Its `inherits(bases)` walks `extends` through `comesTo` once, the way `libraryBase` does, until a base the adapter's `importedAs` says came from one of a spec's modules under one of its names, or an `extendsNamed` base the adapter's `spellsBase` says one of the specs spells, which is how Ruby matches `ActiveRecord::Base` in a project that reopens `class Base` inside `module ActiveRecord`. A project class the walk reaches also counts when `spellsBase` says its own `name()` spells one, so `class Query < BaseObject` inside `module Types` reaches `Types::BaseObject`, though the class the walk starts from is never its own base. At each class the walk also reads every key the adapter's `otherDeclarationsOf` gives, so Ruby's `class Types::Reopened` written a second time with no base keeps the base the first body wrote; its `members(kind)` are the functions among its `holdsProperty` rows |
| `name()` on a class | `rbConstantName(c, q)` in Ruby, which gives a nested class its full name, and `exportsAs` elsewhere |
| `bodyCalls()` on a value or a module | `bodyCallAt(f, k, r)` on the value's own key or the file's path, in the order of `k`: the calls written as statements of the body, through the branches of a conditional |
| `bodyCalls()` on a class | `classBodyCall(c, r)`, which the adapter asks the rules for: the class body's statements and, in Ruby, those of each block written there, in source order |
| `fieldCalls()` | the `holdsProperty(c, n, v)` and `declaresDefault(c, n, v)` rows whose `v` is a call, in source order, each under its plain name |
| `writesBase()` | an `extendsNamed(c, n)` row, which an adapter states for a base the declaration writes and never for a mixin |
| `classes()` | the classes and modules the adapter lists for the file through `ModuleWritten.classes`, each as a class |
| `classes()` on a class | the `holdsProperty(c, n, v)` rows whose `v` is itself a class as `asClass()` reads one, without following `comesTo`, in source order, each under `n`. Python and Ruby state one for each class or module written as a statement of the body, so a name the body sets to another class is not one. A nested Python class has no `exportsAs` row, so `n` is the only name the facts give it |
| `method(name, kind)` | the first function among the class's `holdsProperty` rows of that kind under the name, else the same on each class an `extends(c, b)` row's `b` `comesTo`, in the order of the rows and through each base's own bases before the next, each class once |
| `site()` on a value | the value's own key, the one its facts are stated under |
| `blockCall()` | `callBlock(r, b)` read by its second column, the value's own key |
| `asCall()` | the `call(r, c)` row on the value's own key, so a list item written as a call is that call; a name is not followed. With `{ follow: "namesAndFields" }`, the value is read the way `receiver()` reads a receiver, so `include_router(users.router)` and `@router.get` on the same router give one call |
| `nothing()` | the adapter's `writesNothing` on the value's own key: `None`, `nil`, or `null` and `undefined` |
| `pairArgs()` | `callPairArg(r, k, v)` in the order the adapter states them, which only Ruby does |
| `loopsOver()` | the call's block from `callBlock(r, b)`, or else a function written as its first argument. The `elementOf(x, o)` row off the call's receiver `o` whose `x` is that function's first parameter, by `paramOf` or the adapter's `parameterOf`, gives the element's variable, and `positionOf(i, x)` the position's. A variable's name is the one `paramNamed` gives it, or its text |
| `evaluatedWith(bindings)` | the adapter's `evaluatedWith`, its evaluator with the names bound. An adapter with none reads the value as `name("nothing")` does |

A read chain asks its questions of `ReadOps`, which `factReadOps` reads
the same way:

| op | read from |
|---|---|
| `entry()` | `readsProperty(x, o, n)` or `readsEntry(x, o, n)` gives `n`, and `readsKeyed(x, o, k)` gives null. At a site the facts state none of the three at, it is undefined and a chain doesn't match |
| `byKey()`, `computedKey()` | the same rows: a read at a key is `readsEntry` or `readsKeyed`, and a computed key is the `k` of `readsKeyed(x, o, k)` |
| `isOff(global)`, `objectPath(paths)` | the adapter's `spellsGlobal` on the object the site reads off, or else `globalsReaching` on it. TypeScript follows the environment objects there through `wantedEnvValue`, so `env.PORT` is off `process.env` when `env` is a parameter that defaults to it or a caller hands it. The adapter's `objectOf` gives the object without stating the site, and the rows above give it otherwise |
| `isOff(handedIn)` | `handedIn(p, n)` on the object the site reads off, which is how Python and Ruby key a parameter's reads, or on what a `binds` row takes that object to, which is how TypeScript does. Otherwise the adapter's `handedReaching`, the names the rules followed into the object through `runtimeValue`: a helper's parameter the unit passes the object to, or a local set to it. A run that states no `handedIn` row under the name stops at the first lookup |
| `readsOff()` | the adapter's `readsOff`: in TypeScript, the element read `o[k]` or the binding elements of `const { A } = o` when the site is `o`, stated as they are asked. Python and Ruby visit those sites themselves and leave it unset |
| `defaulted()`, `fallback()` | the adapter's `defaultedAt` and `fallbackOf`, each its own walk over the syntax. What counts as coping with a missing value is the language's |
| `assigned()` | `assigns(x, v)`: the site is the left side of a plain `=` and `v` the value written on the right |
| `keysSuppliedTo(object)` | the adapter's `keysSupplied` where it has one, as TypeScript and Python do. Python's passes a key by position or by keyword, across every function the callee resolves to. Otherwise, for each parameter of the function `call(r, c)` comes to, the sites the adapter's `sitesNaming` says take their key from it, kept when they are off the object |
| `call()` | the adapter's `callAt` where it has one, as TypeScript does, which reads the call's name without stating its facts. Otherwise the call ops at the site's key |

`keysSuppliedTo` is on the read ops rather than on the call's. A read
chain asks it at every call the access walk visits, and in TypeScript
building a call's ops states the call's facts, which for a call at
module scope the invocation walk never does. Asked this way, a call that
supplies no key is read off its nodes and nothing is stated.

`classAt`, `parameterReadsAt` and the two batching hints are left out.
Each comes in with the pack that reads it. Until then an adapter adds
them through `FactSource.extend`, which every call the ops reach goes
through, and TypeScript takes them from `callOpsFor` at the same node.

`statesSlots` belongs to whoever runs the hooks, so the Python and Ruby
runners set it on the ops of the call in hand only. They listen through
`SlotsHeard`, which gives each value back as the key the ops read it
at. A name in those languages has a key and no node, and the source
walk behind a slot's provenance starts from the key. `valueKeyOf` gives
one value's key the same way, for the fallback a getter passes, which
Python's `fallbackOf` hands back as a key.

The pack harness runs every recognizer that reads the ops a second time
over `callOpsFor`, and fails the test on any difference that
`tools/pack-harness/src/knownDifferences.ts` does not list with a reason.

### A unit a pattern finds

These discovery patterns are read here for every adapter, through
`discoverDeclared` over the module ops: a function a deploy manifest
says the platform calls (`manifest`), exports by name or by a pattern,
with an object's members (`namedExport`), the methods of a class that
reaches a library base (`subclassOf`), the functions a directive marks
(`marked`), a function a call hands over (`registeredFunction`), and a
function written under one of a library's decorators (`decorated`).
They are not chain endings, since a unit found by an export, a file or
a manifest is not reached from a call. `factModuleOps` answers the
module ops from these facts:

| op | read from |
|---|---|
| `exports()` | `exportsAs(file, n, v)`, or the adapter's own export table where it follows a re-export, as TypeScript's does. Each member's `line` is the adapter's `lineOf` at `v`, the line the declaration starts on, which for a re-export is in the file it leads to |
| `export(path, member)` | the first name through `exports()`, then `member` for each name after it, then the member asked for. Ruby writes a nested constant in one piece too, `class Reports::Nightly`, so its module ops also try the leading names joined with `::`, and a class written both ways is two values, the first that has the member winning |
| `marked(word)` | `marks(file, word)`, once the adapter's `mentions(word)` says the file's text has the word |
| `markedFunctions(word)` | `marks(f, word)` on each function the adapter lists in the file, since TypeScript states a function's facts only when something reads it. It asks `mentions(word)` first, since stating every function of every file to find a word most files never write costs more than the rest of a run |
| `calls(scope)` | the calls the adapter lists outside every function body, or with `file` every call the file writes, each as the fact ops for it in source order |
| `elements()` | the elements the adapter lists for the file through `ModuleWritten.elements`, which TypeScript states as `writesElement(file, v)` with their rows when asked, keeping those with no `jsxParent(v, p)` row. Python and Ruby write no JSX and leave it unset |
| `importedNames(modules)` | the adapter's `importedNames`: the file's named imports of the modules in TypeScript, and its `from m import n as x` bindings at module scope in Python. Ruby imports no names, and leaves it unset |
| `decorated()` | `decoratedWith(x, d)` for each function and class the adapter lists through `ModuleWritten.decorated`, with the decorators in source order and the name the adapter says the definition is declared under. A decorator that is a call comes back as its call ops, and any other as its value ops. TypeScript lists the classes and methods written under a decorator, Python every decorated function and class. Ruby writes no decorators and leaves it unset |
| `mentions(word)` | the adapter's own `mentions`, which in TypeScript looks for the word in the file's text. Python and Ruby leave it unset, and the module ops then say yes |

`registeredFunction` with a global start and no method asks
`mentions` for each of the start's paths before it lists the calls. A
call to a global is written with the global's own name, so a file
whose text has none of them makes no such call, and listing the module
body's calls states facts for every one of them. A method on a global
can be called through a variable imported from another file, so that
form is always read. A start every member of which is an import or a
construction from a module is read the same way: the file's text has
to write one of the modules, so `react-dom` gates React's boot calls.
Without the gate, reading every call of every file of a frontend stated
facts in an order that changed what other packs found, since what the
store answers about a parameter depends on which callers' facts it has
already stated.

`in: "file"` reads every call the file writes, the ones inside
functions too, since most apps boot inside a function. Each adapter's
walk skips the bodies it defers for the module body, a function in
TypeScript and Python and a method, lambda or block in Ruby, and keeps
them for `file`.

`decorated` reads `decorated()` for the functions written under a
decorator the library gives as a method of something it made:

```ts
{
  type: "decorated",
  on: constructedFrom({ from: ["fastapi"], named: ["FastAPI"] }),
  named: { middleware: { kind: "middleware" } },
}
```

A decorator written as a call, `@app.middleware("http")`, is read
through its receiver, and one written as a member read with no call,
`@app.before_request`, through the object it is read off. The pattern's
`on` is asked of the call that value was written as, `FastAPI()` for
`app`, so a value a project function returns is not one the library
made. The unit is the function, under the name it is declared with,
and a function nested in another function or a class counts. A class
under the decorator gives no unit. Each unit says which decorator found
it in `decoratedBy`: the method, the decorator, the receiver as written
and the call it was written as, which is where a reader looks for the
object the decorator registers the function on. A file whose text
writes none of the methods is not read, and the receivers of the
decorators that call one are asked about at once.

`subclassOf` can also declare a unit for each call in the class body
that its `calls` lists, the way graphql-ruby's `field :user_name`
declares the field `userName` on its type:

```ts
{
  type: "subclassOf",
  inherits: rubyConstants("Types::BaseObject"),
  skipClasses: ["Types::BaseObject"],
  members: { kind: "instance", names: [] },
  className: { call: "graphql_name", suffixRemoved: "Type" },
  calls: {
    field: {
      name: { at: 0 },
      naming: { camel: { keyword: "camelize", default: true } },
      runs: [
        { classAt: { keyword: "mutation" }, method: "resolve" },
        { method: { keyword: "resolver_method" } },
        { method: "named" },
      ],
    },
  },
}
```

The reader takes each call on self in the class's `bodyCalls()` whose
callee `calls` lists, and skips a class `skipClasses` lists. The unit
is named `<class>.<name>`. The class's part is the string the first
`className.call` in the body writes, else the last segment of the
class's name with `suffixRemoved` taken off, else the whole name when
the match gives no `className`. The unit's part is what `nameAt` settles
the argument to, turned to camel case unless the call writes `false`
under the keyword. An argument that does not settle keeps its source
text and runs nothing. graphql-ruby stores fields by name, so the last
call under a name wins, at the place of the first.

`runs` says what the unit runs, and the first pick whose keyword the
call writes applies. A `classAt` pick takes the method of the class the
keyword's value `asClass()` comes to, a `method` pick with a keyword
takes the class's method under the name that keyword's value gives,
and `method: "named"` takes the class's method under the unit's own
name before camel casing. Each method is found with `method(name,
"instance")`, through the class's project ancestry. The unit's `func`
is that method, or null when there is none, as for a wired class the
run did not read. Its `namedBy` hands the adapter the call, the class,
both parts of the name and which pick applied, so the adapter can read
the rest of what the call declares.

A unit spec's `handedIn` lists the parameters the platform fills when
it calls the unit, by position and the name a read chain asks for each
under. When an adapter claims a unit, before it reads the body, it
states `handedIn(p, name)` on the parameter at each position, with
`stateHandedIn` in `@suss/resolution`. A read chain off
`handedIn(name)` then finds the reads in the body.

`discoverEntryObject` reads a module whose entry export says which unit
the module is about, and whose other exports each give that unit one
set of inputs. Storybook is the case it was written for: the default
export says the component, and each named export is a story with its
args. It takes the first export named `entry` whose `object()` has the
`target` property, then every other export whose `object()` is not
null, in `exports()` order. Each member's inputs are the entry's
`inputs` entries, then its own, through `lastValueWins`, with a key
nothing settles left out. A member has no function, so the match never
builds a unit, and it is kept out of `DeclaredDiscoveryMatch` so that no
pack can list it in `discovery`. A contract reader calls it directly.

Each reader ends at `function()` and hands the adapter back its own
node. The TypeScript adapter runs a pattern like any other in its
discovery dispatch, and Python and Ruby run the patterns a pack lists
in `declaredDiscovery` beside their own route patterns.

### A test case a runner collects

`discoverTestCases` reads a `testCases` match: the test cases a runner
collects in one module, each with its titles, the function it runs,
where its unit is recorded, whether it skips itself and what it mocks.
The pytest, Minitest, RSpec and vitest packs declare one. Each adapter
builds a `test` unit on each case, and the Python and Ruby adapters walk
it the way they walk a reached function. A file is read when its name matches one of
`files.matching` and, when `files.listed` is set, it is one of the
listed files. A case is recorded at its function's `site()`, or for a
block at the site of the call `blockCall()` says it is written with,
since that call is where Minitest's `test "x" do` declares it.

A case written as a function is an export whose name matches
`functions.pattern` and whose `function()` is the export's own value,
with the same `site()`. A `def` is one, and a name for a function or a
call that returns one is not, so a test one module imports from another
is not a case of the importing module. A case written as a method is
one of `members("instance")` on a class the runner collects, whose name
matches `classes.methods.pattern`. A class is collected when its
`name()` matches `classes.named` or it `inherits` one of
`classes.inherits`. With `classes.nested`, each class the collected
class's body writes, through `classes()` on the class, is collected the
same way under its own name as another title. Python declares a nested
class under no `name()` of its own, so the module's classes are then
the ones it declares at its top level. The cases come out in
`bySourceOrder` of where they are recorded, so a class's methods and
the classes nested in it keep the order they are written in.

Minitest's `test "cancels twice" do` is a method too. The minitest pack
lists a class-body declaration in which `test` defines the instance
method `test_cancels_twice` from its block, the Ruby adapter states it
as `holdsProperty`, and `members("instance")` lists it beside each
`def test_*`. A test a loop in the class body declares is found the same
way, since `classBodyCall` follows a loop's block.

`caseRuns` gives every case in the module by its function's site, the
listed files or not, each with `before`: the functions the runner calls
before the case, in the order it calls them. They are the module's
`before.module.always` functions, then its `forFunctions` ones for a
case with no class around it, then the classes' own. A list of
`before.methods` names methods the case's own class writes, which run
with the blocks of its `before.calls` in the order the class writes
them all, as Minitest runs `setup do` and `def setup`. Otherwise each
class's methods run from the outermost class in, looked up with
`method(name)` so a method on a project base class counts, and a class
the runner collects by its ancestry runs `before.methods.byAncestry`
and any other class `byName`.

A case is skipped when a call on self to one of `skips.statements` is
one of its own `bodyCalls()`, with no block and not a `nestedBodyCall()`,
so `skip "later" unless ready?` does not skip it. `isRunnerCall` says
a call is the runner's own when it is written on self and its method
is one of `runner.names` or starts with one of `runner.prefixes`. With
`runner.chains`, the name checked is the one the chain starts from as
written: a walk down `receiverValue()` through each call written in
place, `asCall()`, to a call on self, whose callee it takes, or to a
receiver whose `form()` is a name, whose `source()` it takes. So `to`
and `eq` in `expect(x).to eq(y)` count by `expect`, and `order.cancel`
counts by `order`, which is no runner name. The adapter asks it of each
call the walk meets in a case.

Each case also gets its `markers`: the `decorated()` decorators of its
function, then for each class around it from the innermost out the
class's decorators and the items its body assigns to
`skips.decorators.variable`, then the items the module assigns to it.
An item written as a call is a call marker, and anything else a value.
A case is `skipped` when one marker comes from one of
`skips.decorators.origins`, read by `decoratorIsFrom`: a call by its
callee's `isFrom`, and a value by `globalPath` for a global origin, so
`pytest.mark.skip` is matched through the module's imports. The
adapter reads the other markers it needs, pytest's `usefixtures`, off
the same list.

`mockRead` reads one call against `mocks`, in order. A rule applies
when the call is one of its patchers, by its callee's `isFrom`, as a
listed method on a parameter the caller says the function takes, or
as one of `by.methods` whatever it is called on, and writes the
argument the rule reads as a string: `replacesModule` gives the dotted
path, and `replacesMember` the member's name and where the object is,
an argument's position or `receiver` for what the call is made on, as
Minitest's `Order.stub(:cancel, 1)` replaces `cancel` on `Order`. The
adapter lists the calls, since which functions a case runs through is
its own, and turns a dotted path or a receiver into a file with its
module resolution.

RSpec's mocks take three more rules. `replacesMessages` reads a
message expectation, `allow(Order).to receive(:cancel)`: a call of its
patchers whose `receiverValue()` is a call of one of `targets`, and
whose first argument is a chain that starts, down `receiverValue()`,
with a call of one of `messages`. The message's symbols and its
`keywordNames()` are the members it replaces, on the target's argument
at `of.at`. A symbol is a value whose `form()` is a name and whose
`evaluated()` is a string, which is how Ruby writes one.
`replacesConstant` reads `stub_const("Order", fake)` as the constant
its argument at `name.at` gives the name of. `standsIn` reads a double,
`instance_double(Order)`, which replaces the constant at `of.at` only
when the call `chainedOn()` gives is `becomes`, `.as_stubbed_const`,
and is a mock that replaces nothing otherwise.

A case written as a call is read off `calls` by `callCaseRuns`, as the
vitest and rspec packs declare it. Each call in `module.calls("file")`
is asked whether it is one of the runner's. With `from` an import, the
call is read for the name its callee starts from and the members
written after it: a callee written as a name is its own root, a method
comes after what its receiver gives, the receiver's `source()` when its
`form()` is a name or else the chain of its `member()`, and a call made
on a call, `it.each(rows)("t", fn)`, reads its `callee()` when that
chain ends in one of `modifiers.takingArguments` or `modifiers.perRow`.
The root is the runner's when `importedNames(from.importedFrom)` maps
it to one of the runner's names, or, in a file `globalsIn` matches,
when it is one of them and `bindsAtTopLevel` says the file does not
bind it. With `from` a global, a call written on self is the runner's
by its callee, and a method by its name when its `receiverValue()` is
spelled as one of the global's paths, as `RSpec.describe` is. The
names are the groups, the cases, and the shared groups and the calls
that include one. With `body: "block"`, a group, a case or a shared
group is written with a block, and a call with none is not the
runner's. A call that is none of the runner's is read against `mocks`
with `mockRead`.

Each runner call is placed under the nearest runner call a walk up
from it meets: from a call or a function to the call `passedTo()`
gives, from a block to its `blockCall()`, or else to its
`enclosingBody()`, until the top of the file. The walk keeps what it
found at each step it passed, so a later walk stops there. The cases
are then read off that tree from the top. A group is walked into, a
shared group is not, and nothing written inside a case is read. A case
with no group around it is one unless `topLevelCases` is false. An
include with a group around it asks `shared.includedAt(site)`, the
table of the run's shared groups the adapter hands in, and reads that
shared group's cases in its place: from this file's tree when the file
writes the group, or from a tree over the group's block's `calls()`.
An include the table has no shared group for is read through, and one
that includes a shared group the walk is already in reads nothing.

A case's titles are those of the runner calls around it, then its own.
A group adds its first argument; a shared group adds none, and an
include adds its first argument after its `nestedTitle` when it has
one, `behaves like x`. A title is the argument's `constantPath()` when
the source writes a constant there, else what `evaluated()` gives when
that is a string, and else its `source()`, unresolved. A call that
passes no title, as `it { is_expected.to be_valid }` does, is titled by
its block's source on one line, unresolved. A per-row case's own title
is unresolved too. A case runs its block, or with `body: "function"`
the first argument after the title whose `function()` settles. It is
recorded at its call's site when the module writes the call, and a case
read from a shared group in another file at the innermost runner call
around it that the module writes, the include or the group around it.
It is skipped when it or a runner call around it is written with a
`modifiers.skip` member, under a `skipped` name, or with
`skips.metadata`: a name that `evaluated()` gives as one of the keys,
or a keyword whose value is not the literal false or nothing. A
`skips.statements` call among its block's own statements, or among
those of the block of a `before.calls` call a runner call around it
writes, skips it too. A mock applies to it when the nearest runner call
around the mock is the case or one around it.

`CaseRun.groups` lists the runner calls a case runs through, each
followed by the shared groups it includes in place: those an include
with no `nestedTitle` among its own statements reads. `before` is the
blocks of the `before.calls` calls each of them writes on self as its
own statements, in order. `caseAt` gives the same for one block, read
from the block up as the cache needs it: the groups the walk passes,
and at the first shared group, the groups around its one include, or
none when it has another number of includes. `sharedGroupsWritten`
gives the adapter what one file writes for its table: each shared
group that is a statement of the file or of a group, by its title, and
each include with a group or shared group around it, with those
around it. Its walk takes cases as nothing and stops at each include.

Neither reader keeps anything. The reach walk asks about every test
function until the run ends, so the adapter reads each file once and
keeps nodes, as the Python adapter's test index does. Keeping the ops
would keep every value they read alive through the whole walk.

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

## A route table

Some libraries write their routes as a table apart from the handlers,
such as Rails' `config/routes.rb`, where `resources :orders do ... end`
gives seven routes to `OrdersController`. A pack states such a
table as a `RouteTableDeclaration`: what each entry is called and the
role it plays. `composeRoutes(table, sources)` walks the entries through
the module ops and returns a `RouteSet`, every route each controller
action serves and the entries it could not read.

```ts
const RAILS_ROUTES: RouteTableDeclaration = {
  roots: { calledOn: "routes", kinds: { prepend: 0, draw: 1, append: 2 }, children: { in: "block" } },
  handler: { separator: "#", namespaceJoin: "/" },
  loops: ["each", "each_with_index"],
  roles: {
    get: { role: "serves", methods: ["GET"], path: [{ pair: "key" }, { at: 0 }], handler: [{ keyword: "to" }, { pair: "value" }] },
    namespace: { role: "scopes", both: { at: 0 }, children: { in: "block" } },
    // ...
  },
};
```

The roles:

| role | what the entry does |
|---|---|
| `serves` | serves one or more methods at a path, routed to the handler a pick reads, or, with no handler, to the action its path or `action` says on the expansion it is inside |
| `expands` | serves a fixed list of rows under a base, such as `resources`, and opens an expansion that nested entries start from. `param` renames the member segment and the nesting parameter, and `shallow` serves the member routes, and what nests inside, from the shallow path that a scope with `shallowPath` starts |
| `scopes` | adds a path segment, a namespace segment, both, or neither to every entry inside it |
| `base` | chooses whether a bare entry inside an expansion starts from the member or the collection |
| `defaults` | gives its keywords to every entry inside it that leaves them out |
| `fragment`, `replay` | gives a block of entries a name, and the replay walks it again in its own scope |
| `include` | reads another file's entries in place |
| `mount` | serves another table under a prefix, keyed under that table's namespace |

An `EntryPick` says where an entry states a value: a position, a
keyword, the key or value of a pair argument, or a key, which reads an
element's attribute or an object's own property. `ChildrenIn` says
where an entry's children are: its block, the body of the function it
is handed, the entries of a list it is handed, or the elements written
inside it. An entry with no role has its children where the roots have
theirs: a loop over a literal list in `loops` is walked once per
element with its variable bound, a library's wrapper with entries
inside is walked in place and reported, and anything else is reported
unread. `ChildrenIn.chain`, for a table written as a chain of calls, is
in the types with no reader yet.

An entry is a call, as Rails writes one, or, for a table like React
Router's, a JSX element or an object in a list:

```ts
const REACT_ROUTER_ROUTES: RouteTableDeclaration = {
  roots: { kinds: { createBrowserRouter: 0 }, children: { in: "list", pick: { at: 0 } }, in: "file", elements: true },
  roles: {
    Route: {
      role: "serves",
      methods: ["GET"],
      path: [{ key: "path" }],
      index: { key: "index" },
      handler: { value: [{ key: "element" }] },
      children: [{ in: "elements" }, { in: "list", pick: { key: "children" } }],
    },
  },
  objects: "Route",
  from: ["react-router", "react-router-dom"],
  absolutePaths: "standAlone",
  elementLists: ["createRoutesFromElements"],
  loops: [],
};
```

- `from` reads a root call's name and an element's tag as the name one
  of these modules exports, through the module ops' `importedNames`. A
  file whose text writes none of the modules, or that imports none of
  the table's root or role names from them, has no table, and nothing
  else of it is read.
- A root with `in: "file"` is read among every call the file writes,
  through `calls("file")`. With `elements: true`, every element of the
  file that no element written with children encloses is a root too,
  walked in place: an element no role reads, such as `<Routes>` or a
  guard, has its `elementsWithin()` walked as entries in the same
  scope.
- With `objects`, a list pick reads `listed()`: each object item is an
  entry under that role, and a spread or an item written as anything
  else is reported where it is. A pick that reads an element, or a call
  in `elementLists`, reads nothing, since those elements are read where
  they are written. A pick that reads no list is reported, at the root
  call when it is the root's own list. A list reached again inside
  itself stops, as an include of the file being read does.
- A `serves` role whose `handler` is `{ value: [...] }` hands back the
  value the pick reads. It serves it at its path, or at the scope's own
  path when its `index` flag reads true, and walks its `children`, the
  first rule that reads, under that path. An entry with neither a path
  nor an index serves nothing and leaves the scope to its children as
  it is. A path that does not read is reported, and so is every route
  under it.
- `absolutePaths: "standAlone"` reads a nested path written with a
  leading `/` as the whole path. A relative segment goes under the
  prefix with its trailing slashes left off.

What such a table serves comes back as `RouteSet.outcomes`, in walk
order: each route with its handler value and its entry, and each entry
or list item left unread with the reason, a `RouteUnread`. The
`routeTable` discovery pattern reads a table in one file into units
from them: a route is a unit on the function its handler's component
settles to, or a boundary announced at the entry, and an entry left
unread is a unit that claims no route, with the pattern's sentence for
the reason.

What stays with the pack is what needs the file system or the pack's
configuration: which files to read, which table an owner such as
`Rails.application` refers to, the file an include reads, and how the
library inflects a name. These are the `RouteSources`.

`composeRoutes` joins paths with one slash between, the way
`joinMountedPath` joins a mount prefix, and a segment that is nothing
leaves the prefix as it is. A table that mounts itself and a file that
includes itself each stop.

`packages/cli/src/routeTableLanguages.test.ts` writes one table with
blocks in Ruby, callbacks in TypeScript and lists in Python, and
expects the same routes from each. It also writes one table of objects
in all three languages, with a nested list, an index entry, a path that
does not read, a spread and an item that is no object, and expects the
same outcomes from each.

### A table whose entries are made on a value

FastAPI writes no entry inside another. A route is a decorator called on
the app or on a router, and a router is mounted by a call made on the
app or on another router, in any file:

```ts
const FASTAPI_ROUTES: RouteTableDeclaration = {
  roots: { kinds: { FastAPI: 0 }, children: { in: "receiver" }, in: "file", unlessDropped: { owned: ["middleware", "exception_handler"] } },
  from: ["fastapi"],
  joins: "asWritten",
  loops: ["for"],
  throughWrappers: true,
  roles: {
    get: { role: "serves", methods: ["GET"], path: [{ at: 0 }, { keyword: "path" }], handler: { decorated: true } },
    include_router: { role: "mount", table: [{ at: 0 }, { keyword: "router" }], at: [{ keyword: "prefix" }], prefix: "inFront" },
    APIRouter: { role: "scopes", path: [{ keyword: "prefix" }], children: { in: "receiver" }, noValue: "unreadable", trailingSlash: "kept" },
  },
};
```

- `{ in: "receiver" }` makes an entry's children the entries made on the
  value it builds. They are found in every file the sources list, by
  the value their receiver comes to, `receiver().site()`, the first
  time a table asks, and walked in the order the files are read and
  then in source order. A serves role whose handler is
  `{ decorated: true }` takes its entries from the module ops'
  `decorated()`, the decorators that call the role's method, so a
  dictionary's `.get(...)` is never one, and its handler is the
  definition under the decorator. Every other serves role and every
  mount role takes the calls of its method from `calls("file")`, in a
  file whose text has one of those methods. Before it reads a file's
  entries, the composer says through `readingReceivers` which
  decorators and which calls it will ask the receivers of, so an
  adapter that asks the rules once per question can ask once per file.
  A receiver written as two values, a name assigned two routers, comes
  to none, and `receiverCalls()` lists both: an entry on two roots
  serves under the path both put in front of it, and is `unreached` with
  `shared` set when they put different ones there, as an entry on two
  routers is.
- A module the file imports whole, `import fastapi`, which the module
  ops list through `importedWhole`, names each root, scope and decorated
  serves role under its own name, so `fastapi.APIRouter(...)` is a
  router.
- A decorator written as a name the file imports from the table's
  modules, `@route("/x")` after `from wrapper import route` with
  `wrapper` among `from`, is the library's own decorator. It is made on
  no value and serves at its own path. It is read that way ahead of
  `throughWrappers`, so a module a project says re-exports the library
  gives its users the library's names.
- `methods: { members }` serves each method of a decorated class whose
  name the list has, upper-cased, with the method as the handler and the
  class as the outcome's `owner`, which is how flask-restx writes a
  resource.
- `methods: { pick, unstated }` serves the methods an entry lists at
  the pick, upper-cased, and the `unstated` ones when it passes nothing
  there: FastAPI's `@app.api_route("/x", methods=["GET", "POST"])`
  serves both, and `@app.api_route("/x")` serves GET, as FastAPI does. A
  value at the pick that reads as no word serves nothing, so a list
  built at run time gives no route rather than a guessed one.
- `throughWrappers` reads a decorator written as a call to a project
  function as the library call that function returns, through
  `returnedCall()`, with the decorator's own arguments. The outcome
  gives that call as `made`, so a reader can find what it is made on.
- A mount role with `prefix` mounts a value. Its table pick is read
  with `asCall({ follow: "namesAndFields" })`, so `users.router` is the
  `APIRouter(...)` the module assigns, and the call that built it is
  walked as an entry, named the way its own file imports the name. With
  `for` among the `loops`, a mount whose table is a loop's variable
  mounts each item of the list the loop goes over, through `element()`,
  whether the list is written out in place or returned by a call the
  rules settle, through `returnedItems()`. A loop that takes each
  element apart, which `elementPart()` says, is one the table cannot
  list.
  `prefix: "inFront"` puts the mount's path in front of the value's own;
  `"replaces"`, which the table does not follow, leaves every route
  under it unread.
- A scopes role with `noValue` reads its path the way a library reads a
  router's prefix. `unstated` reads `""`, `0`, `false` and the
  language's literal for no value as no path, and `unreadable` keeps
  only a string. `trailingSlash: "trimmed"` trims the path, and
  `prefixRequired` leaves the routes under a scope that states none
  unread. A path that does not read leaves them unread too, ahead of
  what the mounts above say, since the router's own prefix is what it is
  built with.
- `joins` puts a prefix and a path together as strings: `asWritten`
  writes one after the other, as FastAPI does, and `merged` then merges
  repeated slashes, as Werkzeug serves a path. A reader that reads an
  entry's own path itself puts it after the outcome's `prefix` through
  `joinedTablePath`, the same join.
- `unlessDropped` leaves out a root its function drops, as
  `CallOps.dropped` says, with every entry made on it, and a value a
  root would mount that its function drops the same way. It takes the
  methods the library may call on the app besides the roles, `owned`,
  because FastAPI's middleware and exception handler decorators are
  registrations that are no role of the table, and an app that only
  has those called on it is still dropped.

flask-restx serves an `Api`'s routes under a path the `Api` states and
one the Flask blueprint it is built within states:

```ts
roots: {
  kinds: { Api: 0 }, children: { in: "receiver" }, in: "file",
  path: [{ keyword: "prefix" }], noValue: "unstated",
  carrier: {
    at: { at: 0 }, handedBy: "init_app", from: ["flask"],
    paths: { Blueprint: [{ keyword: "url_prefix" }] }, noValue: "unstated",
    registeredBy: { method: "register_blueprint", at: { at: 0 }, path: [{ keyword: "url_prefix" }] },
  },
},
```

- A root's `path` goes in front of every route under it, read the way
  a scopes role with `noValue` reads its own.
- A root's `carrier` is the value it is built within: the one its
  construction states at `at`, or one a `handedBy` call made on it
  states there later. A construction of a name in `paths`, imported
  from the carrier's `from`, puts its path in front of the root's. Any
  other construction from those modules, such as the Flask app,
  puts nothing there. The carrier is read with `asCall({ follow:
  "namesAndFields" })`, and a name written as two values is told apart
  through `asCalls()`.
- A carrier's registrations, the `registeredBy` calls whose `at` comes
  to it, are read only for whether they move it somewhere its own path
  no longer says: a registration that states a path at all, one made on
  another carrier with a path, or a second registration.

What such a table cannot claim a path for comes back as an outcome
with a `ReceiverUnread` reason. A `routeTable` pattern says a sentence
for each one its table can give, and a table that never reads
receivers can leave them out. Each reason tells the reader of a unit
with no path where to look, so each cause has its own.

| reason | when, and why the table needs it |
|---|---|
| `unreached` | a decorated entry whose value no root's walk reaches: nothing mounts it, it is mounted only on values nothing mounts, or it comes to no one value. A route on a router nobody mounts still gets its unit, with no path |
| `unlistedLoop` | the same, while a mount written in a loop the table cannot list, in a directory that contains the entry's file, may mount it, so the unit can point at the loop |
| `rivalledMount` | a mount above it is written in a function while such a loop elsewhere may mount the value instead, and which of the two the app runs is not written down |
| `mountUnread` | a mount above it states a path that does not read, which the reader fixes at the mount and not at the router's own prefix |
| `prefixUnstated` | a scope above it states no path where its library makes one up, as flask-restx does for a namespace, so the path served is one the source never states |
| `prefixReplaced` | a mount above it states a path that replaces the scope's own, which flask-restx does and the table does not follow |
| `cycle` | a mount above it leads back into a value the walk is already inside. The value's entries are walked once more with no path claimed, so every route on the cycle, and under it, is unread, since the cycle gives it no one path |
| `rootPrefixUnread` | the path its root states does not read |
| `carrierSeveral` | its root is built within one carrier and handed another, or handed two |
| `carrierUnfollowed` | its root's carrier comes to no construction from the carrier's modules |
| `carrierShared` | its root's carrier is a name assigned more than one value |
| `carrierPrefixUnread` | the path its root's carrier states does not read |
| `carrierRepathed` | its root's carrier is registered with a path of the registration's own, which Flask reads three ways depending on what it is |
| `carrierNested` | its root's carrier is registered on another carrier, which the table does not follow |
| `carrierRegisteredTwice` | its root's carrier is registered more than once |

A reason about a root or its carrier is said before any reason about
what is mounted under it, except a scope's own path, since a router is
built with its prefix whatever it is mounted on.

An outcome also says where it is, so a reader can word the reason the
way the library's users would and run what is registered on the way.
A route, and an entry whose own path does not read, has the `mounts`
the walk came down, outermost first, each the mount call and the value
it mounts, and the `prefix` in front of its own path. An unread one
has `on`, the value it is made on, and `router`, the value its reason
is about: the scope whose path did not read, the value a mount that
did not read or that a loop rivals mounts, the value a cycle leads
back into, or the root for a reason about the root or its carrier. A
decorated entry's unread outcome has its `method`, one for each method
it would serve.

An entry no walk reaches is read the way a walk would have read it, in
the order a library stops serving a route: its value's own prefix,
then each mount of the value, by the prefix of the value it is mounted
onto, its own path and a loop that may rival it, and then the value it
is mounted onto, which no walk reached either. Only a value nothing
mounts is `unlistedLoop` when a loop may mount it.

`packages/cli/src/routeTableReceiversLanguages.test.ts` reads one app
written in Python and in TypeScript, with decorated functions and class
methods, a router mounted twice, two mounted from a loop over a list,
and one nobody mounts, and expects the same outcomes from each.

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
| `{ to: "chained" }` | the call made directly on what the call returns |
| `{ to: "receiver", every: true }` | every call up the receivers, in the order the walk meets them; with `method` or `origin`, every one of those it accepts. `method` can list several methods |
| `{ to: "receiver", every: true, inPlace: true, until: session }` | every call up the receivers the source writes in place, stopping before the chain's first call on the session: the calls after `db.query(User)` in `db.query(User).filter(c).first()` |
| `{ to: "chainStart", except: ["execute"] }` | the first call of the chain the source writes in place, `db.query(User)` above, or the call itself when its receiver is no call written in place; nothing when that call makes one of the methods `except` lists |
| `{ to: "chainStart", method: ["values"] }` | the same call, only when it makes one of the methods listed |
| `{ to: "chained", fromItself: true, every: true }` | the call itself and every call out along what it returns |
| `{ to: "chained", every: true, except: ["values"] }` | every call out along what the call returns, passing over the calls to `values` |
| `{ to: "passedTo", at: 0 }` | the call this call's result is passed to in place as its first argument, `session.execute(text(sql), params)` from `text(sql)`; with `method`, only a call to that method |
| `{ to: "builder", method: "object", from: ["zod"] }` | the call a library's builder made the value with, this call included, through up to eight methods chained on its result: `z.object({ ... })` from `z.object({ ... }).strict()` |

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

With `every`, a step keeps going after the first call it accepts and
reaches each one, so `filter(a).filter(b)` picks rows at both filters.
`except` lists the methods whose calls the walk passes over without
reaching them, as a query's `values` call supplies values rather than
picking rows. The walk stops the same way either way.

`inPlace` keeps the walk to the chain the source writes: it takes a
receiver only when the call it came from is the one `chainedOn()` says
is made on it, so `q.first()` after `q = db.query(User)` does not
reach the query. `until` stops the walk before the chain's first call
on its origin, which is the first call the origin accepts. When that
call is made on a call written in place, as `.first()` in
`Orders.query().first()` is made on the query `Orders.query()` gives
back, the chain starts at the start of that call's own chain. A walk
from the chain's first call reaches nothing.

A session chain's start is `[{ to: "chainStart", except }, { to:
"chained", fromItself: true, every: true }]`: the chain's first call and
every call out from it, one of which is made on the session. That is
the first call itself for `db.add(order)` and `db.query(User)`, and the
call after it for `Orders.query().first()`. `except` lists the methods
a chain may not start with, so `db.execute(stmt).scalars().all()`
reads nothing while `db.query(User).scalar()` reads.

A pick over the calls a step reaches can take `itself: true`, which
adds the call the pick starts from after them, when the first step
would have kept it: its method, `except`, origin and `until` apply to
it as to the others. `.first()` comes after `.filter(c)`, and
`db.query(User)` read alone adds nothing, since it is the chain's first
call.

A `passedTo` step reaches the call that takes this call's result as an
argument, through `passedTo()`, one hop like `chainedOn()`. A result
kept in a name first reaches nothing, since the name, and not the
call, is what was passed.

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

## A statement a function the file imports builds

SQLAlchemy builds a statement with a function, `select(User)`, and
the calls after it pick rows:

```ts
const STATEMENT = imported({ from: ["sqlalchemy"], named: ["select", "update"] });
storageCalls({ system, client: STATEMENT, clientAt: [{ to: "chainStart" }] }, { outermost: true })
  .methods({ select: READ, update: WRITE }, { of: [{ to: "chainStart" }] })
  .container(MODEL);
```

`select(User)` is made on nothing, so the start counts a call the steps
reach when it is a call of the client itself, the way a bare call in
hand is read. The statement is what its function says, so `of` looks
the method up on the chain's first call, and that call's method is the
operation: `update(User).where(c).values(name=x)` is an update read at
`.values`. The picks still run from the call in hand. `about` would
move them to the first call too, and a walk out from there meets the
calls in source order, where a session chain reads them from the last
call back. A statement written alone, `stmt = select(User)`, is its own
first and last call.

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

`fieldsRead` also takes every argument from a position, `{ from: 1 }`,
and reads each one in turn, each column once, so `select(User.id,
User.name)` reads both off `User`.

`keywordsOf` gives the keywords the calls its steps reach pass, each
once, in the order the calls and their keywords are written, through
`keywordNames()`: `filter_by(id=x)` in Python and `where(id: x)` in
Ruby both pass `id`. TypeScript's calls pass no keywords, so it reads
none there. When somebody listens, each keyword's value is the slot
for its column.

Neither pick is a function, so pack health counts both as data, and
`fieldsRead` records nothing it read as a slot.

A table can say what every method it leaves out does, with
`.otherwise(meaning)`, for a client whose methods nearly all read: a
session lists the methods that write, and every other method on a
receiver the start accepts reads. A call with no receiver still has to
be listed, or be an export the table lists. A table with an `otherwise`
cannot say which methods' receivers it asks about, so it does not call
`readingReceivers`.

A chain built with `{ outermost: true }` reads a call only when nothing
is chained on what it returns, so `db.query(User).filter(c).first()` is
read once, at `.first()`, and `db.query(User)` alone at itself. It asks
`chainedOn()` before anything else, and an adapter that cannot say
reads every call. Its hook says `claimsChainStart`, since the call
it claims is the one that starts the chain, the call into the library,
and the Python adapter marks that call as read so the reach walk does
not report it as lost.

A method whose `kind` is `nothing` matches and records no access, so
the call still counts as the client's. A session's chain that starts
with `execute` is one: a chain about its first call, `.about({ to:
"chainStart" })`, lists those methods with `kind: "nothing"`, and
`db.execute(stmt).scalars().all()` is claimed without an access.

## A query that compares columns of a class

An ORM query says which table it reads by the class it is passed, and
picks rows by the columns of that class it compares:

```python
db.query(User).filter(User.id == user_id, User.age > 18).first()
```

The container is a class pick, `{ class, notFrom }`: the first value
one of the sources reaches whose `className(notFrom)` is not null. A
source is an argument pick, or `{ of, receiver: true }` for the value
a reached call is made on, so the class of `Orders.query().first()` is
`Orders`.
The picks that read columns state the class the same way, through
`ofClass`, and a column is a value `memberRead()` gives as a read off a
value of that class, so Ruby's `Entry.id` is one as well as Python's.

```ts
const START: CallStep = { to: "chainStart" };
const LATER: ToReceiver = { to: "receiver", every: true, inPlace: true, until: SESSION };
const MODEL: ClassPick = {
  class: [{ of: [START], at: 0 }, { of: [{ ...LATER, method: ["select_from", "join"] }], itself: true, at: 0 }, { of: [START], receiver: true }],
  notFrom: ["sqlalchemy"],
};
fields: [{ columns: { of: [START], from: 0 }, ofClass: MODEL }, { keywordsOf: { of: [START] } }],
selector: { conditions: { of: [LATER], itself: true }, ofClass: MODEL, combinedBy: ["and_", "or_", "not_"], pinnedBy: ["and_"], equality: ["=="] },
```

`columns` gives the arguments from a position on that are columns of
the class, so `select(User.id, User.name)` reads `id` and `name` and
`func.count(User.id)` reads nothing. `conditions` reads each call in
turn: its keywords, then the columns of the class it compares under an
`equality` operator in a comparison of two operands, looking inside
`pinnedBy` calls only. Each of those states the value it is compared
with as its slot. Then it reads every call again for every column that
is an operand of any comparison, looking inside `combinedBy` calls.
Each name comes once, so the query above picks by `id`, with
`user_id` as its value, and by `age`.

A list of picks reads each pick in turn and keeps each name once, so
`fields` above gives the columns the first call is passed, then its
keywords.

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
too, so it also catches the unsafe form. A client that only ever takes
its statement as a call's argument can say `walk: "invocation"`, which
keeps its accesses among the call effects, in the order the calls were
made, before every effect of the access walk.

A Cloudflare D1 database is declared in `wrangler.toml` by its binding,
and the contract says nothing about its tables. `.container({ of: [{
to: "member" }] })` makes the access one per call, on the member the
call is made on: `env.LEDGER.prepare(sql)` is a read or a write on
`LEDGER`, a write when the statement writes any table, with no fields
and no selector. A statement the parser can't find a table in still
records nothing.

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

A parameter pick can also read the keywords a call passes as one
object, `{ of: [{ to: "chained", method: "bindparams" }], keywords:
true }`, which is where SQLAlchemy's `text(sql).bindparams(id=x)`
binds `:id`. A library that takes its statement through a function it
exports, rather than a method on a client, states where with
`.calls(meaning)`, the bare call the start's origin accepts:

```ts
sqlStatements({ system, dialect: system, client: imported({ from: ["sqlalchemy"], named: ["text"] }) })
  .calls({
    statement: { at: 0 },
    parameters: [
      { of: [{ to: "chained", method: "bindparams" }], keywords: true },
      { of: [{ to: "passedTo", at: 0 }], at: 1, keyword: "params" },
    ],
  });
```

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

All three adapters write the slots they hear as provenance, so a
chain's slots reach its summaries in every language it runs in.

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

## A message a handler reads

A Lambda handler is handed a batch of records, and the producer wrote
each record's `body` as JSON. The receive is read at the decode, a call
of one of the adapter's decoders, and the pack says how the program gets
from what the platform handed it to the payload:

```ts
messageReceives({
  wire: "aws_sqs",
  codec: "json",
  envelope: [
    { path: [{ read: "Records" }, { each: true }, { read: "body" }] },
    {
      from: typed({ from: ["aws-lambda"], named: ["SQSRecord"] }),
      path: [{ read: "body" }],
    },
  ],
});
```

The chain has no links. `compile` hands it to `compileReceives`, and the
pack runs it on the invocation walk. At each call the hook asks
`decodes()`, and a call that decodes nothing, or decodes under another
encoding, matches nothing. Then it walks each envelope from the payload
outward, last step first. A `read` step asks `read()` and needs the key
the step says, then goes on to the object. An `each` step asks
`element()` and goes on to the collection. When the steps run out,
`from`, if the envelope states one, asks `typed()` of where the walk
ended. The first envelope that gets through matches, so a typed record
in a loop gives one receive and not two.

The fields are the keys `keysRead()` reads off what the decoder gave
back: at the call, through the one name the result is kept in, and in a
destructure of that name. No key read means no body, and the checker
then compares nothing. The effect names no channel, because the queue a
handler drains is in the deployment. The checker pairs it with the
sends on that queue through the consumer the template declares.

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
and the pack's `unread` reasons for anything else or for nothing. A
chain records that effect only when it says `.schedules(...)`. Without
it the chain's ending is `{ yields: "claims" }`, no walk dispatches on
it, and it only claims the callbacks its calls write in place. React's
`useEffect` is read that way, since the component's summary keeps
nothing of an effect.

A runtime's timer takes nothing but its callback in the first place, so
the Node pack reads it with `written: "argument"`, which takes whatever
the source writes at the position. A value there that is neither a
function nor a name is a callback the run cannot read, and the effect
gives the `other` reason where `written: "callback"` would pass over it.
A method that takes a delay says where, and `hasDelay` says whether the
call passes an argument there:

```ts
const WAITS = { callback: { written: "argument", at: 0 }, delay: { at: 1 } };

callbacks({ client: global("setTimeout", "setInterval") })
  .methods({ setTimeout: WAITS, setInterval: WAITS })
  .schedules({ via: "asWritten", unread: { missing: "missing-callback-argument", other: "non-literal-callback" } })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
    metadata: { node: { schedulingPrimitive: { reads: "callee" } } },
  });
```

A `global` start matches a call with no receiver spelled as one of its
paths. In TypeScript and Python a name the program binds itself, to an
import or to a declaration of its own, is not the global, so a local
`setTimeout` or one imported from `node:timers/promises` does not match.
Ruby still matches the spelling.

`.unitWhenInPlace` compiles to the pack's `subUnits` hook. The adapter
runs it for a unit and hands it `calls(parent)`, the calls the parent's
body runs in source order, the ones in functions it runs inline
included. The hook matches each call the way the recognizer does, a bare
call of the chain's global first, and claims the callback when its
`form()` is `function`, handing back the adapter's own node through
`ast()`. For a bare call whose callee the table does not list as
written, the hook asks what the callee was imported as before it asks
whether the call starts at the chain's origin. A component calls its
own setters far more than a library's hooks, and a callee no import
binds is turned down without asking the store. The recognizer keeps the
origin first, since there most calls fail the origin and the import
question costs more. The name is built from the parts in order: the
parent's name, `.` and the callee, `#` and how many claims under that
callee came before it in the parent. A callback written inside another
claimed one still belongs to the parent, because the calls are not cut
at a claim.

`countInParent` counts every claim the chain makes in the parent,
however the callee is spelled, and writes the link's `countedAs` before
the count, so React's effects are `Panel.effect#0` and `Panel.effect#1`
whether the second was written `React.useEffect`. `metadata` on the link
is a record of records whose leaves say what to read, and the claim's
summary records it with each leaf read, keeping the order the pack
wrote the keys in:

```ts
.unitWhenInPlace({
  kind: "handler",
  name: ["parent", "countInParent"],
  countedAs: "effect",
  metadata: {
    react: {
      kind: { reads: "text", text: "effect" },
      component: { reads: "parent" },
      index: { reads: "count" },
      deps: { reads: "argumentItems", at: 1 },
    },
  },
})
```

`callee` is the callee as the source writes it, `text` the pack's own
text, `parent` the parent's name, `count` the number `countInParent`
writes, and `argumentItems` the items of the list the call passes at
`at` as the source writes each one, through `writtenItems()`. An
argument that is not a list written there is its whole text in a list
of one, since a name for a list is what the call passes, and a call
that passes nothing there gives null. A pack that builds its
`PatternPack` by hand takes the hook from `subUnitsOf(matches)`, which
is what `pack()` uses.

A pack built by hand can pass `{ onlyWhereWritten: true }` to `compile`
and to `subUnitsOf`, and the hooks then read the file's text through the
adapter's `mentions` before they ask the store anything. The sub-unit
hook skips a parent whose file writes none of the chains' method names
or modules, and a bare call is read as another name's export only in a
file that mentions one of the chain's modules. Without it, a chain that
starts from a module asks the store which export every bare call is, in
every file the pack reads, and the Node pack reads every file. A callee
that a project module re-exports under another name is lost with the
gate on, so `pack()` leaves it off.

## A function an element is handed

React calls the function a component hands an element under an `on`
prop when the event fires, so a pack claims it as a unit of its own:

```ts
renderedProps({ matching: "^on[A-Z]" })
  .unitWhenInPlace({
    kind: "handler",
    name: ["parent", "callee", "prop", "countOnCollision"],
    inputs: [{ position: 0, role: "event" }],
  })
  .unitWhenNamedInParent({
    kind: "handler",
    name: ["parent", "written"],
    inputs: [{ position: 0, role: "event" }],
  });
```

The hook asks the adapter's `elements(parent)` for the JSX elements the
parent renders, its own and those in functions it runs inline, the same
list `runsElement` gives. Each element's `tag()` comes from its
`jsxElement` row and its `attributes()` from its `jsxAttribute` rows,
each value keyed after `peelValue`. For an attribute whose name matches
the pattern, a value whose `form()` is `function` is claimed by
`unitWhenInPlace`, and a `name` whose `function()` the adapter's
`writes(parent, fn)` says the parent writes, at any depth, by
`unitWhenNamedInParent`. A name for a function declared elsewhere, a
prop passed through, or a member read is not claimed.

For an element the callee is its tag as written. `prop` is the
attribute's name, `written` the name the function was handed over as,
and `countOnCollision` adds `#N`, in source order, only when two claims
in the parent come out with the same name: two inline `onClick`s on
`<button>` are `Panel.button.onClick#0` and `#1`, and one on `<a>` beside
them is `Panel.a.onClick`. `inputs` becomes the unit's positional input
mapping. A chain over elements claims before a chain over calls. Python
and Ruby write no JSX and list no elements, so the chain claims nothing
there.

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

A method can say two more things. `streamAt: { keyword: "file" }` takes
the stream from a keyword when the call passes one, so Python's
`print(x, file=sys.stderr)` writes to the stream `streams` gives for the
path the value is (`ValueOps.globalPath`). The value is read the way
`receiverGlobal` reads a receiver: spelled as the path, or a parameter
a caller passed that stream to. A value two streams reach writes to no
stream in particular. A value no stream reaches is a file, and the call
writes to no stream at all.
`onlyWithArguments: true` says a call that passes no argument writes
nothing, as Ruby's `abort` with no message exits without printing.

The payload is read through the ops. One value written through an
encoder is recorded as what went in, with `serialized: "json"`, and so
is one a template puts nothing but whitespace around, the way a command
ends its JSON report with a newline. Any other single value is recorded
as `text` with its own `shape()`, and several values become a record
keyed by position. Only the values passed by position count: Python's
fact source counts them through `positionalCount`, since its
`argumentCount` counts a keyword such as `sep=` too. The effect's
`groupId` is `callSiteKey` of the effect.

## A request a library sends

`httpRequests` says which calls of a client library send an HTTP
request. The chain doesn't record an effect. `pack()` compiles it to a
`requestRecognizers` hook, and the adapter's client walk calls that
hook at every call in a function body, then makes the function a
client of each request the hook returns. The unit, and what the caller
does with the response, stay the adapter's.

```ts
httpRequests({
  client: anyOf(
    imported({ from: ["requests"], named: ["*", "get", "request"] }),
    constructedFrom({ from: ["requests"], named: ["Session"] }),
  ),
})
  .methods({
    ...verbs({ get: "GET", post: "POST" }, { at: 0, keyword: "url" }),
    head: { sends: "HEAD", url: { at: 0 }, redirects: "response" },
    request: { sends: { from: { at: 0, keyword: "method" } }, url: { at: 1 } },
  })
  .response({ statusCode: ["status_code"], redirectDelivery: "followed" });
```

A method sends the verb the table writes, the method an argument
states (evaluated and upper-cased, with `default` for a call that
states none or states one suss cannot settle), or the method of a
request object built from one of the classes it lists.
`.calls(meaning)` says what a call of the client itself sends, as
`fetch(url)` or `api(config)` after `api = axios.create()`.
`.baseUrl(pick)` reads the base URL off the
construction the call's receiver was made by, and `joins` says how the
library puts a path under it: `appended` writes it after the base with
one slash, and `resolved` resolves it the way RFC 3986 does, so a path
that starts with `/` replaces the base's path. An absolute URL on the
call goes where it says. `trailingSlash: "required"` is for a library
that refuses a base whose path does not end with `/`, as aiohttp does
since 3.10: that client is never built, so the call keeps its own path.
A call that passes an empty path goes to the base, and
`trailingSlash: "added"` is for a library that ends the base's path
with `/` itself, as httpx does, so that call goes to the base with a
`/` at the end.
A base path that ends in a hole is refused too, since it may or may not
end with `/` when it runs.

The construction is what `asCall({ follow: "writtenAs" })` gives for
the receiver as written, which follows whatever the adapter's rules say
the receiver was written as. In Ruby that includes a method the class
writes, so `conn.get(path)` after `def conn = Faraday.new(url: base)`
reads its base off that `Faraday.new`. An adapter whose receiver has no
such value reads `CallOps.receiver()` instead. A request object is the
construction the argument was made by, read the same way, and under each
construction of the enclosing class when the plain reading finds none,
since a class can be handed a different request each time it is built.

Some libraries take the host apart from the path. A URL pick with
`hostFirst` says where the call passes the host, the path and the
port: `Net::HTTP.get(host, path, port)`. The call takes that form when
the argument at `path` reads as a string (`ValueOps.isString`), and
reads its URL as one argument otherwise, as `Net::HTTP.get(uri,
headers)` does. `.baseUrl` with `reads: "host"` reads a construction
that states a host and a port and no path, `Net::HTTP.new(host, port)`.
Both read the host through `ValueOps.host`, which writes it with its
port the way the host of `http://host:port` is written, so it pairs
with an absolute URL to the same place.

The hook asks its questions in order of cost. A method call is looked
up in the table first, and a bare call by the name it is written with
or the export its own import statement binds (`calleeImport`). Only a
listed call asks where its receiver or callee came from. A receiver's
`imported` and `constructed` origins are asked of `receiverSettledFrom`
first, for every origin of an `anyOf` and of an `anyOf` inside it, and
of the rules only for the ones it leaves open. Most receivers of a
`get` are a dictionary or a project object, which their own statements
settle. A bare call's callee goes the same way through
`calleeSettledFrom`. A chain that says what a call of the client itself
sends asks this of every bare call in a file, and nearly all of them
are a project function or another library's.

A URL is read through `ValueOps.url`. When the call's own reading
leaves a hole, each construction of the enclosing class gives a request
of its own, read under that construction's site, and two constructions
with the same method, host and path give one. A URL that reads as no
path, or as only holes and slashes under a host suss did not read,
gives a request with no path (`statedRequestPath`). So does a URL
property of an options object suss cannot read, as `api({
...config })`. The adapter keeps it as a client unit, which pairs with
nothing. A URL the client reads without a request, a `data:` URL
(`UrlTarget.local`), makes no request at all. A base a library appends
to that has a hole was worked out at runtime, so its path is left out
and its host kept.

The call's redirect option is read with `keywordAt`, or, for a method
that says where the call passes its options object (`options`), as a
property of that object. An option the call leaves out of an object
suss reads in full is read off the client's construction, in the object
it states its base in, or else its first argument, as
`axios.create({ maxRedirects: 0 })`. A method's own `redirects` applies
when neither sets it.

Each claim says what it read so that an adapter can read the call
again: the table entry it matched (`read.entry`, which the hook's
`entries` lists in the pack's order), where the call states its URL
and its method, where it passes its options, the base apart from the
call's own path, and the construction it was read under (`site`).
TypeScript reads a wrapper's library call again under each caller's
values, and keeps one client unit per function, the first in the
table's order.

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
`ENV.fetch("B", "d")`. `functions` does the same for a function the
runtime provides that reads one entry, keyed by the global path it is
spelled as, Python's `os.getenv("B", "d")`. The table says where the key
is and where the fallback can be. The key is read as the source writes
it, through `ValueOps.literal`, so `os.environ.get(KEY)` is a read of a
key the program works out, the way `os.environ[KEY]` is. A call the
facts state a keyed read at is reported once, as the getter's read. The
read copes with a missing value when the call passes a fallback, or
when the adapter's rule says so; a getter with `raisesWithout` reaches
that rule as a read that raises, so only a test that runs before it
counts.

A mapping says `entriesBy: "key"`: Python's `os.environ` and Ruby's
`ENV` are read only at a key, and `os.environ.get` is a method of the
mapping, never an entry. `missing: "raises"` says a read at a key the
mapping lacks raises, which the adapter's rule reads. A config entry
with `callee: "keyed"` spells its callee `os.environ["B"]`, whichever
way the source read it, and a key the program works out as the site
as written.

`siteReadOf(chain, { read, ops })` says what the chain reads at one
site before anything asks whether the program copes: the entry, the
key as written, the fallback a getter passes, and whether a missing
entry raises there. The compiled ending reads the same answer, and an
adapter's rule asks it about the tests around a read, so the rule and
the chain agree on what counts as a read. `readSpellingsOf(chain)`
gives the object's paths, the getters and the functions as data, for
an adapter's own readers of the same spellings: the seeds its rules
start from, which run before any facts exist, and its value
evaluator's rows. Python's environment is the shipped chain with a
getter.

## A schema the environment is parsed against

A service that validates its configuration writes every variable it
reads into one schema and hands the environment to a library, so no
code writes `process.env.PORT`. The variables are the schema's keys:

```ts
schemaReads({ object: global("process.env", "import.meta.env"), client: exported(["envalid"], ["cleanEnv"]) })
  .methods({ cleanEnv: { environment: { at: 0 }, schema: [{ at: 1 }] } })
  .defaultedWhen({ calls: ["default", "optional"], options: ["default", "devDefault"] })
  .throughHelpers();

schemaReads({ object: global("process.env", "import.meta.env") })
  .methods({
    parse: {
      environment: { at: 0 },
      schema: [{ of: [{ to: "receiver" }, { to: "builder", method: "object", from: ["zod"] }], at: 0 }],
    },
  });
```

A schema chain is a read chain whose first link is the object the
reads are off, followed by the start and the methods table a call
chain has. Its ending is the runtime-read ending, so each key is a
config read named off the object: the effect is the one a read of
`process.env.PORT` gives. The table says, for each call that parses,
where the call takes the environment and where the objects whose keys
are the variables are. Every schema pick that finds an object adds its
keys, in order, so t3-env's `server`, `client` and `shared` are three
picks into one argument.

The hook runs on the access walk at every call. It asks the read ops
for the call with `call()` and looks its name up in the table before
anything else, since nearly every call is not a parse, and only then
asks whether the start accepts it. A bare call the table does not list
as written is read as the export the file's own import binds it to,
through `calleeImport`, so `load(...)` after `import { cleanEnv as load
} from "envalid"` is `cleanEnv`. That import is where the call came
from, so the start is not asked again. A chain with no client, as
zod's has, takes no alias.

The schema is read before the environment, since most calls named
`parse` parse something else. Its keys are what `object()` and then
`entries("nothing")` give, which read a spread in place and a computed
key the source settles. Only a parse that has keys asks `runtimePath`
of the value at the environment pick, and a value that is not the
object reads nothing, so a request body parsed against the same schema
adds no reads. The read's callee spells the object the call was handed,
so a schema parsed against `import.meta.env` reads
`import.meta.env.PORT`, and a parameter the rules followed the
environment into reads as the object's first path.

A key is defaulted when its value `mentions` one of the
`defaultedWhen` calls or options: `z.string().default(8080)`,
`v.optional(v.string())`, `port({ default: 9100 })`. A function
written in the key runs on the value later, so a call inside the one
`transform` takes says nothing about whether the variable may be
missing. When a key is defaulted and the call itself has a fallback,
`Env.parse(process.env) ?? fallback`, the read records it as its
`default`.

`throughHelpers()` reads a call into a project function whose body
parses as a read at the call: each call `callsInCallee` lists is asked
the same questions, and the keys of every parse among them are read at
the call into the helper. A helper two calls away is not followed. Each
chain reads its own library's parses, so a helper that parses with two
libraries lists one library's keys before the other's.

The builder step stops at the first call that is `method` called on a
value imported from one of the modules, or a bare call `calleeImportedAs`
says is that export. It starts at the call it is handed, so valibot's
`v.object({ ... })` written as the argument is its own builder, and it
goes up through `receiver()`, which follows a name, so `Base.strict()`
after `const Base = z.object({ ... })` reaches the builder too. It
climbs at most eight receivers, so a schema with more refinements than
that chained on it loses its keys.

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

## What a class body declares

```ts
classBody({
  calls: {
    has_many: association({ name: { at: 0 }, target: { keyword: "class_name" }, plural: true }),
    after_commit: callback({ methods: { from: 0 }, events: ["create", "update", "destroy"], narrowedBy: { keyword: "on" } }),
    scope: definesMethod({ name: { at: 0 }, body: { at: 1 } }),
  },
  fields: { association: { madeBy: imported({ from: ["sqlalchemy.orm"], named: ["relationship"] }) } },
})
```

An ORM reads a model's body as well as the calls made on it. A
`classBody` declaration says which calls the body writes, outside every
method and with no receiver, mean what, and which fields assigned from
a call declare an association. `declareClassBody(declaration, cls)`
reads `cls.bodyCalls()` and `cls.fieldCalls()` and returns what the
body declares. It states no fact. The adapter does, because an
association's class comes from the language's own inflection when the
call writes none, and only the adapter knows how its language keys a
class.

`in` limits the reading to the library's own classes, as
`classBody({ in: [{ from: ["ActiveRecord"], named: ["Base"] }] })`
does for ActiveRecord's models, so a serializer's `has_many` says
nothing. It lists bases the way every declaration that says what a
class extends does, and a class that reaches any one of them is read.
A body whose declaration writes no base class is read anyway.
A Ruby module has none, and its declarations reach a model through the
`include` that mixes it in. A class reopened without its base has none
either, and its body is the same model's.

A call is matched by the name it is written under. A callback's events
are the ones its `narrowedBy` argument lists, one name or a list, and
every event the meaning lists when that argument is absent or does not
settle. A method is defined only from an argument written as a
function. A `classBodies` entry on `PackSpec` reaches the adapters
through `PatternPack`, and the pack health report counts one data link
for each call and field it declares.

## Ordering

Each link is a guard, so the compiled hook checks the cheapest one
first. Looking a method up in a table costs nothing, while following a
receiver to the library that made it means walking declarations. A link
that changes what the receiver is, the way Prisma's model property
will, needs the links checked in declared order again. That change goes
in `compile.ts`.
