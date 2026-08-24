# @suss/pack-harness

Runs a pack over a snippet of code and hands back the effects, for the
pack's own tests. Internal to this repo and never published.

```ts
const redis = packUnderTest(redisFramework(), {
  library: {
    ioredis: `export default class Redis {
      get(key: string): Promise<string | null>;
    }`,
  },
});

const effects = redis.effectsIn(`
  import Redis from "ioredis";
  declare const redis: Redis;
  export async function read(id: string) {
    return redis.get(\`user_online:\${id}\`);
  }
`);

expect(storageOf(effects[0]).semantics.container).toBe("user_online");
```

## Why it exists

A pack test asks one question: given this code, what does the pack emit?
Getting there took every pack the same thirty lines. Write the client
library into `node_modules`, because a pack settles a call by where the
method it calls was declared and cannot do that against a module the
compiler never found. Build the project. Walk every call expression.
Hand each recognizer a context.

Seven packs had their own copy of those thirty lines, and each copy
built the recognizer context a little differently. Some passed a
`isImportedFrom` that always said no. Some passed an `extractArgs` that
returned nothing, and two wrote their own, which approximated the
adapter's. A pack could pass every test against a context that
extraction never builds.

So the context comes from the adapter now, through
`invocationContextFor` and `accessContextFor`, which are the same two
functions the adapter's own walkers call on the way past a node.

Both walks run, because a pack can put a declaration on either. A chain
that reads a statement written as SQL goes on the access walk, since
`prisma.$queryRaw` is a tagged template rather than a call and the
invocation walk never reaches one.

## What is deliberately not the adapter's

The walk. Extraction starts at a function and stops descending at a
nested declaration, because a named inner function is a unit of its own.
A test fixture is a few top-level statements with the interesting call
inside an exported function, so the adapter's walk would reach none of
it. The harness descends the whole file instead.

## Narrowing an effect

`Effect` is a union, and the part a storage test cares about is two
levels down: an interaction effect, whose `binding.semantics` is
storage and whose `interaction.class` is a storage access. TypeScript
will not narrow through `.filter()` down there, so every pack wrote a
guard that threw on the way. `storageOf`, `storageByOperation` and
`interactionsOf` are those guards, once.
