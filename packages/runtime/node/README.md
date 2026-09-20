# @suss/runtime-node

Runtime pack for [Node.js](https://nodejs.org/). Recognizes the parts of
the Node surface a project reaches for without importing anything:
scheduling calls, the process object, and the module-location globals.

## What this package is

`@suss/runtime-node` returns a `PatternPack` object describing:

- **Invocation recognizers** for the scheduling calls: `setImmediate`,
  `setTimeout`, `setInterval`, `queueMicrotask`, and
  `process.nextTick`
- **Access recognizers** for `process.env.X` reads, the keys of a
  schema parsed against `process.env`, the rest of the process surface
  (`argv`, `exit`, and the process metadata), and the module-location
  globals `__dirname`, `__filename`, and `import.meta.url`
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
resolution rules say which parameters end up supplying the name at such
a read, however many helpers forward it along the way.

That question is asked once for a whole project, from the reads rather
than from the parameters. A project has a handful of reads with a
computed index and thousands of parameters some call could fill, so
asking from each parameter meant ten thousand questions and seven
minutes on a project the size of suss. With the read bound, the rules
run from each callee out to its callers, which is the direction the
call facts are built for. Standing at a call, the pack looks the
callee's parameters up in that one answer and reads an argument only
where one of them is in it.

The store extracts files as questions demand them, so before the first
env question it scans the project's sources for a read off a declared
path with a computed index, and extracts the files that have one. That
keeps the answer the same whatever order the readers happen to run in.
The answer is true of the files extracted when it was worked out, so a
later reader that has brought more of the project in asks again.

Extraction reaches what a file exports, so a file that exports nothing
states no facts, and the rules cannot speak about its parameters either
way. The store says so rather than saying no, and the pack then looks
for the read in the callee's own body. That covers the helper a module
keeps to itself, which is how a test file spells its knobs
(`const runs = envInt("FUZZ_RUNS", 60)`); a helper this way that
forwards its name to another function is still out of reach.

A read reports `defaulted` when every read site behind it supplies a
fallback, or when the call itself is wrapped in one:
`requireEnv("PORT") ?? "3000"`.

On suss itself a cold `suss extract -f node -f fetch` runs in 26.5s,
where the hand-written walk this replaces ran in 33.7s, and both report
the same 101 config reads.

The helper can be what a factory call gave back rather than a
declaration: `const requireEnv = makeReader(prefix)` then
`requireEnv("TABLE_NAME")` reads `TABLE_NAME`, and so does a second
helper that forwards its own parameter into `requireEnv`. A name the
source writes as a call is asked about twice, once for the declaration
behind it and once for what calling it gives back, so a name that is
already a function costs nothing extra.

Four spellings it says nothing about:

- a name taken off an options object, `requireEnv({ key: "TABLE_NAME" })`
- a name built at run time from something only the run knows
- a name built by interpolation from a parameter, `process.env[prefix + "_URL"]`
- a helper built with `.bind`, `readEnv.bind(null, prefix)`. That is a
  step to `readEnv` itself rather than to what calling it gives back,
  and it moves every argument one place left, which the pack has no way
  to undo.

A helper that reads through an environment object it was handed as an
argument is covered. `makeReader(process.env)` giving back `(name) =>
env[name]` reads whatever its callers pass, and so does the same object
handed through several calls, or written into a name first. What the
helper is handed has to come down to `process.env`; a plain object
reads nothing.

## Reads through a schema

A service that validates its configuration writes every variable it
reads into one object literal and hands `process.env` to a library:

```ts
const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  ACCOUNTS_TABLE: z.string().optional(),
  ORDERS_URL: z.string(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return Env.parse(env);
}
```

Nothing there spells `process.env.PORT`, so the property readers above
see one read of the environment object and no variable names at all.
The names are the schema literal's keys, so the pack reports one
config read per key, at the parse call.

Six libraries, in the spellings each of them uses:

```ts
const env = cleanEnv(process.env, { PORT: port({ default: 8080 }) });   // envalid
export const env = createEnv({ server: { DB }, runtimeEnv: process.env }); // @t3-oss/env-core
const env = parseEnv(process.env, { PORT: z.number().default(8080) });  // znv
const parsed = v.parse(v.object({ DB: v.string() }), process.env);      // valibot
const config = Env.parse(process.env);                                  // zod
const config = Env.safeParse(process.env);                              // zod
```

`@t3-oss/env-nextjs` reads the same way as `@t3-oss/env-core`, and
`parseAsync` and `safeParseAsync` the same way as their synchronous
pairs. A zod schema is read through whatever refinements the program
chained onto it, so `z.object({ ... }).strict()` gives the same keys.
Keys a schema spreads in from another literal are read too.

A key reports `defaulted` when its value chain contains `default`,
`optional`, `nullish`, `catch` or `or`, or an envalid `default` or
`devDefault` option, whichever way the library spells the call.

The reader fires only where the environment object reaching the call
comes down to `process.env`: written there, kept in a name, a
parameter whose default is `process.env`, or a parameter some caller
passes it to. A schema parsed against a request body is the same call
shape, and reporting its keys as environment variables would accuse
every field of being unset.

A handler that calls a config module's `loadConfig()` reports what the
parse inside it reads, at the call, the same way a call to a
`requireEnv` helper does.

Two things it says nothing about. A library nothing in the table above
covers reads nothing, since the table is what says where the schema
and the environment object are in each call. And a `runtimeEnv` that
lists the variables one by one, `{ DB_NAME: process.env.DB_NAME }`,
is read by the dotted reader rather than by this one, which reports
the same names.

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

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
