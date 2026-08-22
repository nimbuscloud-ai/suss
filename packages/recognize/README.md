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

A chain running on an adapter with no ops matches nothing rather than
throwing, since a pack loaded into the wrong adapter is a configuration
mistake and not a crash.

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
