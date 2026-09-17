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

## Reads through a project's own helper

Most services read their environment through one helper:

```ts
// env.ts
export function requireEnv(name: string): string {
  return process.env[name] ?? "";
}

// handler.ts
const table = requireEnv("TABLE_NAME");
```

The pack reports `TABLE_NAME` at the call in `handler.ts`, not at the
bracket read in `env.ts`, so the unit that named the variable is the
unit that reads it.

The pack declares `process.env` as the environment object. The adapter
states a fact for a read off it whose index is not a literal, and the
resolution rules say which parameters end up naming a variable, however
many helpers forward the name along the way. Standing at a call, the
pack asks about the callee's parameter and reads the argument only where
the rules say a read is behind it.

A project has far more calls than it has env reads, and asking the rules
costs a query, so three cases are settled before anything is asked. A
call that passes nothing readable as a string cannot report a variable
whatever the rules say, and reading an argument without the store is
free, so that one goes first. A parameter read off `process.env` in the
callee's own body is found by reading the body. A parameter the callee
hands to no other call has nowhere else to be read. What is left is a
parameter forwarded somewhere, which is what the rules answer.

On this repository that pre-filter takes the parameters asked about from
around ten thousand to around a thousand, and a cold `suss extract` runs
in 31s where the hand-written walk it replaces ran in 38s. Asking about
every callee parameter instead takes over ten minutes, so the filter is
what makes the rule affordable here.

Four spellings it says nothing about:

- a name taken off an options object, `requireEnv({ key: "TABLE_NAME" })`
- a name built at run time from something only the run knows
- a name no reading without the resolution store can settle, such as a
  constant imported from another module
- a forwarding call whose callee is a value rather than a name, such as
  a wrapper factory's result written into a const

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
