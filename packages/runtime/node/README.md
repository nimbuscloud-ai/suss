# @suss/runtime-node

Runtime pack for [Node.js](https://nodejs.org/). It recognizes the parts
of Node a project uses without importing anything: scheduling calls, the
process object, and the globals that give a module's location.

```ts
const table = process.env.ORDERS_TABLE;
setTimeout(() => flush(table), 1000);
```

## What this package is

`@suss/runtime-node` exports a `PatternPack`, which is data the adapter
reads. It covers:

- **Invocation recognizers** for the scheduling calls: `setImmediate`,
  `setTimeout`, `setInterval`, `queueMicrotask` and `process.nextTick`.
- **Access recognizers** for `process.env.X` reads, the keys of a
  schema parsed against `process.env`, the rest of the process object
  (`argv`, `exit` and the process metadata), and the module-location
  globals `__dirname`, `__filename` and `import.meta.url`.
- **Sub-units** for the callbacks passed to a scheduling call, so what
  runs later is described as its own unit.

The pack does not discover any units of its own. Everything above fires
on units another pack already found, so run it alongside a pack that
finds this project's handlers.

```bash
suss extract -p tsconfig.json -f express -f node -o summaries/code.json
```

`process.env.X` reads and `process.argv` come back as a runtime-config
boundary, which describes a deployable unit's configuration. The two
options below set what that boundary is called.

`__dirname`, `import.meta.url`, `process.cwd` and the rest of the
process metadata come back on the same boundary with a different
interaction class, `metadata-read` instead of `config-read`. The runtime
provides these values itself, so a template has nothing to declare, and
the runtime-config checker does not pair anything with them. Before
they were split out, the checker reported `__dirname read by handler but
<instance> declares no __dirname in its environment` at error severity,
once for every Lambda that resolved a path.

A `config-read` is `defaulted` when the program handles the variable
being unset, and then the checker does not require a template to
declare it. A `??` or `||` after the read counts, and so does a test
for presence when the value is only used behind that test:

```ts
const version = process.env.APP_VERSION;
if (version) {
  resolved = version;
  return;
}
lookUpVersionElsewhere();
```

The test can be on the read itself, or on a local variable the read
initializes inside a function. An `if` that returns early when the
value is missing covers everything after it. If the local is used
anywhere a test has not passed, the read is not defaulted. The same
goes for a missing value that leads to a `throw`, whether in the branch
it takes or after the test: `if (url) return url; throw new Error(...)`
still requires the variable.

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

The pack reports `TABLE_NAME` at the call in `handler.ts`, instead of
at the bracket read in `env.ts`, so the unit that gave the variable's name
is the unit recorded as reading it.

The pack declares `process.env` as the environment object. The adapter
records a fact for a read from it whose index is not a literal, and the
resolution rules work out which parameters end up supplying the name at
such a read, however many helpers pass it along on the way.

That question is asked once for the whole project, starting from the
reads instead of from the parameters. A project has a handful of reads
with a computed index and thousands of parameters that some call could
fill. Asking from each parameter meant ten thousand questions and seven
minutes on a project the size of suss. Starting from the read, the
rules run from each callee out to its callers, which is the direction
the call facts are built for. At a call, the pack looks up the callee's
parameters in that one answer, and only reads an argument when one of
them is in it.

The store extracts files as questions need them. So before the first
env question, it scans the project's sources for a read from a declared
path with a computed index, and extracts the files that have one. That
keeps the answer the same whatever order the readers run in. The answer
is only correct for the files that were extracted when it was worked out, so a
later reader that has brought in more of the project asks again.

Extraction reaches what a file exports, so a file that exports nothing
does not produce any facts, and the rules cannot answer anything about its
parameters. The store reports that it does not know, instead of
answering no, and the pack then looks for the read in the callee's own
body. That covers a helper a module keeps to itself, which is how a
test file reads its settings (`const runs = envInt("FUZZ_RUNS", 60)`).
A helper like that which passes its name on to another function is
still out of reach.

A read reports `defaulted` when every read site behind it supplies a
fallback, or when the call itself is wrapped in one:
`requireEnv("PORT") ?? "3000"`.

On suss itself, a cold `suss extract -f node -f fetch` runs in 26.5s.
The walk written by hand that this replaces ran in 33.7s, and both
report the same 101 config reads.

The helper can also be what a factory call returned, instead of a
declaration. With `const requireEnv = makeReader(prefix)`,
`requireEnv("TABLE_NAME")` reads `TABLE_NAME`, and so does a second
helper that passes its own parameter into `requireEnv`. When the source
calls a name, suss asks about it twice: once for the declaration behind
it and once for what calling it returns. So a name that is already a
function costs nothing extra.

Four ways of writing the name that it cannot read:

- a name taken from an options object, `requireEnv({ key: "TABLE_NAME" })`
- a name built at run time from something only the run knows
- a name built by interpolation from a parameter, `process.env[prefix + "_URL"]`
- a helper built with `.bind`, `readEnv.bind(null, prefix)`. That leads
  to `readEnv` itself instead of to what calling it returns, and it
  shifts every argument one place left, which the pack cannot undo.

A helper that reads through an environment object it was given as an
argument is covered. `makeReader(process.env)` returning `(name) =>
env[name]` reads whatever its callers pass. So does the same object
passed through several calls, or assigned to a name first. What the
helper is given has to trace back to `process.env`. A plain object
does not count as a read.

## Reads through a schema

A service that validates its configuration writes every variable it
reads into one object literal, and passes `process.env` to a library:

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

Nothing there writes `process.env.PORT`, so the property readers above
see one read of the environment object and no variable names at all.
The names are the keys of the schema literal, so the pack reports one
config read per key, at the parse call.

It covers six libraries, in the form each one uses:

```ts
const env = cleanEnv(process.env, { PORT: port({ default: 8080 }) });   // envalid
export const env = createEnv({ server: { DB }, runtimeEnv: process.env }); // @t3-oss/env-core
const env = parseEnv(process.env, { PORT: z.number().default(8080) });  // znv
const parsed = v.parse(v.object({ DB: v.string() }), process.env);      // valibot
const config = Env.parse(process.env);                                  // zod
const config = Env.safeParse(process.env);                              // zod
```

`@t3-oss/env-nextjs` is read the same way as `@t3-oss/env-core`, and
`parseAsync` and `safeParseAsync` the same way as their synchronous
versions. A zod schema is read through any refinements the program
chains onto it, so `z.object({ ... }).strict()` gives the same keys.
Keys a schema spreads in from another literal are read too.

A key reports `defaulted` when its chain of calls contains `default`,
`optional`, `nullish`, `catch` or `or`, or when it has an envalid
`default` or `devDefault` option, whichever way the library writes the
call.

The reader only fires when the environment object passed to the call
traces back to `process.env`. It can be written there, kept in a
variable, a parameter whose default is `process.env`, or a parameter
some caller passes it to. A schema parsed against a request body looks
the same, and reporting its keys as environment variables would flag
every field as unset.

A handler that calls a config module's `loadConfig()` reports what the
parse inside it reads, at the call, the same way a call to a
`requireEnv` helper does.

A parse whose environment is only written by a caller in another file
is read too:

```ts
// config.ts, which never spells process.env
export function load(source: Record<string, string>) {
  return Env.parse(source);
}

// entry.ts
export const config = load(process.env);
```

The pack asks the resolution store which arguments the callers of
`load` pass as `source`. That question reaches across files, so the
caller can be anywhere in the project, any number of helpers away. A
parameter whose default is `process.env` is read the same way, and so
is a variable the file assigns `process.env` to first.

The question has a cost. On this repo's own `packages/cli`, where no
parse takes its environment from another file, extraction uses 6% more
CPU with the per-file cache off and 15% more with it on, and returns the
same summaries either way. An argument that is not an identifier, such
as a request body or a literal, costs two syntax tests and nothing more.

It cannot read two things.

A library that the table above does not cover does not produce any reads, since
the table is what gives the position of the schema and the environment
object in each call. Aliasing the import, as in
`import { cleanEnv as load }`, hides the call the same way, because the
name written in the source is the first thing checked.

A `runtimeEnv` that lists the variables one by one,
`{ DB_NAME: process.env.DB_NAME }`, is read by the reader for dotted
access instead of this one, and that reader reports the same names.

## Options

```json
{
  "deploymentTarget": "ecs-task",
  "instanceName": "orders-api"
}
```

- `deploymentTarget`: the kind of deployment the config reads belong to.
  One of `lambda`, `ecs-task`, `container` or `k8s-deployment`.
- `instanceName`: the name of the deployed instance the config
  boundary is bound to.

Both are left off the binding unless a run sets them. The code does not
show which deployment runs it, so the pairing pass takes the deployment
from the provider side, meaning the template or task definition that
declares the variables. A read of the runtime itself, such as
`process.cwd()` or `import.meta.url`, never has them.

## Where it fits in suss

The pack depends on `@suss/extractor` for the `PatternPack` type, and
on `@suss/behavioral-ir` for the boundary types its recognizers produce.
It has no analysis logic of its own.

The design is written up in
[`design/proposals/runtime-node.md`](../../../design/proposals/runtime-node.md).

## Coverage

![coverage](../../../.github/badges/coverage-runtime-node.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
