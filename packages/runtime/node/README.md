# @suss/runtime-node

Runtime pack for [Node.js](https://nodejs.org/). Recognizes the parts of
the Node surface a project reaches for without importing anything:
scheduling calls, the process object, and the module-location globals.

## What this package is

`@suss/runtime-node` returns a `PatternPack` object describing:

- **Invocation recognizers** for the scheduling calls: `setImmediate`,
  `setTimeout`, `setInterval`, `queueMicrotask`, and
  `process.nextTick`
- **Access recognizers** for `process.env.X` reads, the rest of the
  process surface (`argv`, `exit`, and the process metadata), and the
  module-location globals `__dirname`, `__filename`, and
  `import.meta.url`
- **Sub-units** for the callbacks handed to a scheduling call, so what
  runs later is described as its own unit

The pack discovers no units of its own. Everything above fires on units
another pack already found, so run it alongside a pack that finds this
project's handlers.

```bash
suss extract -p tsconfig.json -f express -f node -o summaries/code.json
```

`process.env.X` reads and `process.argv` come back as a runtime-config
boundary, which is how a deployable unit's configuration channel is
described. The two options below say what that boundary is called.

## Options

```json
{
  "deploymentTarget": "ecs-task",
  "instanceName": "orders-api"
}
```

- `deploymentTarget`: the kind of deployment the config reads belong to.
  One of `lambda`, `ecs-task`, `container`, or `k8s-deployment`.
  Defaults to `lambda`.
- `instanceName`: the name of the deployed instance the config
  boundary is bound to. Defaults to `<unknown>`, which leaves the
  boundary unpaired until somebody sets it.

## Where it fits in suss

Depends on `@suss/extractor` for the `PatternPack` type and
`@suss/behavioral-ir` for the boundary shapes its recognizers emit.
Contains no analysis logic.

The design is written up in
[`design/proposals/runtime-node.md`](../../../design/proposals/runtime-node.md).

## Coverage

![coverage](../../../.github/badges/coverage-runtime-node.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
