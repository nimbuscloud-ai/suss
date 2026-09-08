# @suss/recognize

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

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

## More

- [Write a pack](https://nimbuscloud-ai.github.io/suss/guides/writing-a-pack)
- [How packs work](https://nimbuscloud-ai.github.io/suss/packs)
- [What a declaration compiles to](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-recognize.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
