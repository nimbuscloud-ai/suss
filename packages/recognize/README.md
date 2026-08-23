# @suss/recognize

Write a pack as data. A pack states where a match starts, which methods
count, and what each one reads or writes; this package compiles that
into the recognizer hooks the adapters already call, and any adapter
that implements the executor ops can run it.

```ts
import { declaredBy, pack, storageCalls } from "@suss/recognize";

const COMMANDS = {
  get: { kind: "read", selector: { at: 0 } },
  hset: { kind: "write", selector: { at: 0 }, fields: { at: 1 } },
} as const;

const calls = storageCalls({
  system: "redis",
  client: declaredBy("ioredis", "redis", "iovalkey"),
})
  .methods(COMMANDS, { ignoringCase: true })
  .container(namespaceOf)
  .example('redis.get("user_online:42")');

export default pack("redis", [calls], {
  languages: ["typescript", "javascript"],
  recognizedAs: "@suss/framework-redis",
});
```

Nothing here imports a syntax tree, so the same declaration drives the
TypeScript adapter today and the Python and Ruby adapters once they
implement the ops.

## The spine

A pack does four jobs: it discovers units, it recognizes calls inside
them, it declares terminals, and it claims sub-units. They share one
spine and differ in what the ending yields.

```
where the match starts -> which method -> read the arguments -> yield
                                                                effects
                                                                a unit
                                                                a terminal
                                                                a sub-unit
```

Only the effects ending is built. The other three are further members of
`Ending` with an entry in the compile table.

### Where a match starts

The start is its own axis, and a receiver is one value on it. Across the
29 shipped packs a match starts from at least thirteen places, and most
of them are not receivers at all: an exported name, a file path, a
decorator, a parameter's type, a template file beside the module, a
function's return type. `MatchStart` is where those arrive.

The receiver-shaped starts are their own union, `ReceiverOrigin`:

| origin | what it matches | built |
|---|---|---|
| `declaredBy` | a receiver whose method one of these modules declared | yes |
| `constructed` | a client made from one of these modules' exports | yes |
| `factoryMade` | `app = express()` | no |
| `imported` | a function the file imports | no |
| `anchored` | a chain read from its anchor call | no |
| `inherits` | a Ruby or Python receiver matched by ancestry | no |
| `global` | `process.env`, bare `fetch` | no |

`declaredBy` is what a pack wants when the source never spells the
client out: `const redis = await this.getClient()` says nothing about
ioredis, and the declaration behind `redis.get` says everything.
`constructed` asks the receiver itself, so it still works where the
method is untyped.

## The gradient

Expressiveness is bought link by link, and the price is printed.

1. A chain of data links. Serializable, inspectable, and it runs
   wherever the ops do.
2. A link written as a function. That link is code, the rest stay data,
   and pack health says which ones are opaque.
3. `astLink` from `@suss/recognize/ast`, which hands the function the
   adapter's own node. Behind its own import, so reaching for it shows
   up in the diff, and pack health reports it the way it reports a pack
   that declares no version.

`packGradients` in `@suss/adapter-typescript` reads the counts off a
run, and three health checks fire on them: a link written as a function,
a link that reads the syntax tree, and a declaration with no example.

## The executor ops

`CallOps` is the whole of what a chain asks about one call site. An
adapter implements it once. Today `callOpsFor` in
`@suss/adapter-typescript` is the only implementation, and it puts the
result on the recognizer context under `ops`.

| op | what it gives back |
|---|---|
| `method()` | which method the call reaches for, as the source spells it |
| `receiverIsFrom(origin)` | whether the receiver came from where the origin says |
| `argumentCount()` | how many arguments the call passes |
| `nameAt(index, unsettled)` | the name that argument gives, with the hole policy applied |
| `calleeText()` | the callee, as the source writes it |
| `receiver()` | the call the receiver is, as ops of its own |
| `argument(index)` | the call that argument is, as ops of its own |
| `propertyAt(index, property, unsettled)` | what a named property of that argument says |

The last three are what let a chain read a call next to the one in
hand. `receiver()` and `argument(index)` give back another `CallOps`,
so every question above works one step along; `propertyAt` is the only
one that reaches inside a value, because a property bag is not a call
and nothing else reaches into one.

A chain running on an adapter with no ops matches nothing rather than
throwing, since a pack loaded into the wrong adapter is a configuration
mistake and not a crash.

## Reaching a call next to this one

Two of the three storage shapes put what a pack needs somewhere other
than the call the adapter is standing on.

```ts
s3.send(new GetObjectCommand({ Bucket: "photos", Key: "a.jpg" }));
storage.bucket("photos").file("a.jpg").download();
```

The first says `send` at every call site in the codebase and puts the
operation, the bucket and the key in the command. The second puts the
bucket two hops back up the receivers and the object one hop back.
Neither needs a question of its own: both are the questions above,
asked of a different call.

A pack says which call with `about`, and a pick says which call with
`of`. Both take steps, and a step is data:

| step | what it reaches |
|---|---|
| `{ to: "receiver" }` | the call the receiver is |
| `{ to: "receiver", method: "bucket" }` | the first call to `bucket` up the receivers |
| `{ to: "argument", at: 0 }` | the call the first argument is |
| `{ to: "argument", at: { from: 0 } }` | every argument that is a call, first one that matches wins |

```ts
storageCalls({ system: "s3", client: constructedFrom("@aws-sdk/client-s3") })
  .about({ to: "argument", at: { from: 0 } })
  .methods({ GetObjectCommand: { kind: "read", selector: KEY } })
  .container({ at: 0, property: ["Bucket"] });
```

With a subject, every other link is asked of the call the steps reach:
the operation is that call's own name, the origin check is about that
call, and a pick with no `of` reads that call's arguments. The effect
still records the call in hand as its callee, since that is where a
reader would go and look.

A step that says which method is searched for rather than counted to,
because `bucket(b).file(p).download()` and `bucket(b).getFiles()` put
the bucket a different distance back. The search is bounded at eight
receivers: a receiver chain can come back round to itself through a
variable, and a pack that meant more than eight hops has written
something else by mistake.

A pick reads the argument itself, or a property of the object the
argument states. The properties are tried in order, so `property:
["Key", "Prefix"]` is "the key, or the prefix a listing asked for
instead". A construction is unwrapped first, since that is where a
command puts its inputs.

## A method the caller says which way round it goes

Most methods read or write whatever the call site looks like, and a few
are told. A signed URL is the one in the shipped packs: the same call
hands back a URL for reading or for writing depending on what it was
asked to sign for.

```ts
kind: {
  asks: { at: 0, property: ["action"] },
  means: { read: "read", write: "write" },
  otherwise: "read",
}
```

`otherwise` is what the call comes to when it says nothing, which is
the library's own default rather than a guess.

## The example every declaration states

```ts
.example('redis.get("user_online:42")')
```

`runExamples(pack, run)` takes each declaration's example, hands it to
the compiler the caller supplied, and gives back what came out. A pack's
test asserts the stated effect, so the day the example stops matching
the pack fails rather than the documentation quietly lying.
`examplesMissing(pack)` lists the declarations that state none.

## Ordering

The links are guards, so the compiled hook checks the cheap one first:
looking a method up in a table costs nothing, while following a receiver
to the library that made it walks declarations. A link that changes what
the receiver is, the way Prisma's model property will, needs the
declared order back, and `compile.ts` is where that goes.
