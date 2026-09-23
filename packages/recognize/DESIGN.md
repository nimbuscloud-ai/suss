# How a pack declaration is compiled

The [README](./README.md) says what `@suss/recognize` is for.

## The four jobs a pack does

A pack does four jobs: it discovers units, it recognizes calls inside
them, it declares terminals, and it claims sub-units. All four are
written as the same chain of links. They differ only in what the last
link yields.

```
where the match starts -> which method -> read the arguments -> yield
                                                                effects
                                                                a unit
                                                                a terminal
                                                                a sub-unit
```

Two endings are built, and both yield effects. One asks the call what
it reached, and the other reads the statement the call was given.
Discovery, terminals and sub-units are further members of `Ending`,
each with an entry in the compile table.

### Where a match starts

Where a match starts is a separate choice from the rest of the chain,
and a receiver is one of the options. Across the 29 shipped packs a
match starts from at least thirteen places, and most of them are not
receivers: an exported name, a file path, a decorator, a parameter's
type, a template file beside the module, a function's return type.
Those go into `MatchStart`.

The starts that begin at a receiver form their own union,
`ReceiverOrigin`:

| origin | what it matches | built |
|---|---|---|
| `declaredBy` | a receiver whose method one of these modules declared | yes |
| `constructed` | a client made from one of these modules' exports | yes |
| `factoryMade` | `app = express()` | no |
| `imported` | a function the file imports | no |
| `anchored` | a chain read from its anchor call | no |
| `inherits` | a Ruby or Python receiver matched by ancestry | no |
| `global` | `process.env`, bare `fetch` | no |

A pack uses `declaredBy` when the source never writes out which client
it is using. In `const redis = await this.getClient()` nothing mentions
ioredis, but the declaration behind `redis.get` comes from ioredis.
`constructed` looks at where the receiver itself was made, so it still
works where the method has no type.

A chain can also match a call made directly on the tracked value, with
no method, by adding `.calls(meaning)` next to its methods table. A
store hook is the usual case. `useAppStore((s) => s.bears)` calls no
method, so the table has no method name to list. The call matches when
its callee is a bound name whose written value came from the chain's
origin. Such a call usually reads its fields inside a selector lambda,
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

`packGradients` in `@suss/adapter-typescript` reads the counts from a
run. Three health checks fire on those counts: a link written as a
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

A computed key such as `{ [this.tableName]: [...] }` is read like any
other name. When the source settles its value, the entry's key comes
back settled.

On an adapter with no ops, a chain matches nothing and does not throw.
A pack loaded into the wrong adapter is a configuration mistake, and it
should not crash the run.

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
bucket at different distances. The search stops after eight receivers.
A receiver chain can loop back to itself through a variable, and a pack
that asks for more than eight hops has made a mistake in the step.

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
nothing records the scope the pack was built with.

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
