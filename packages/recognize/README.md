# @suss/recognize

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Write a pack as data. A pack declares where a match starts, which
methods count, and what each one reads or writes. This package compiles
that declaration into the recognizer hooks the adapters already call,
and any adapter that implements the executor ops can run it.

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

export default function redisFramework() {
  return pack("redis", [calls], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-redis",
  });
}
```

This package never imports a syntax tree. Each adapter states facts
about the source, and the ops this package builds over those facts
answer every question a declaration asks, so the same declaration runs
on the TypeScript, Python and Ruby adapters. A pack says which of them
it runs on in `languages`.

Each builder declares one kind of call a library offers:

- `storageCalls` and `sqlStatements` for a call that reads or writes a store
- `messageSends` and `messageReceives` for a queue's producer and consumer
- `unitInvokes` for a call that runs a deployed function
- `httpRequests` for a request an HTTP client sends
- `callbacks` and `renderedProps` for a function the library runs later
- `runtimeReads` and `schemaReads` for a read of the environment
- `streamWrites` for a write to the process's output

`pack()` assembles a list of them into a pack. A pack whose other
fields are written by hand uses `requestRecognizersOf`, `subUnitsOf`
and `declarationsIn` instead. Route tables, test cases and discovery
patterns are data in a pack's own fields, and this package reads them
through the same ops.

## More

- [Write a pack](https://suss.sh/packs/write-a-pack)
- [How packs work](https://suss.sh/packs/what-a-pack-is)
- [What a declaration compiles to](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-recognize.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
