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

export default pack("redis", [calls], {
  languages: ["typescript", "javascript"],
  recognizedAs: "@suss/framework-redis",
});
```

This package never imports a syntax tree. The same declaration runs on
the TypeScript adapter today, and will run on the Python and Ruby
adapters once they implement the ops.

## More

- [Write a pack](https://suss.sh/packs/write-a-pack)
- [How packs work](https://suss.sh/packs/what-a-pack-is)
- [What a declaration compiles to](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-recognize.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
