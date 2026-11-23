---
title: Write a pack
description: Build a pack for a framework suss does not ship yet, run it through the CLI, and register it so -f finds it.
---

# Write a pack

Write a pack when suss ships nothing for a library your code uses. The example below builds one for [itty-router](https://itty.dev/itty-router) from start to finish and runs it through the CLI. The finished pack is fifty lines of data.

Here is the code to be read:

```ts
// src/routes.ts
import { Router, error, json } from "itty-router";

import { findUser } from "./db.js";

const router = Router();

router.get("/users/:id", async ({ params }) => {
  const user = await findUser(params.id);
  if (!user) {
    return error(404, "no such user");
  }
  return json(user);
});
```

## Answer three questions

A pack for a framework, which finds the units your code is made of, starts with the same three questions, and the answers become the three required fields of a `PatternPack`. A pack for a library those units call, such as a database client or an HTTP client, is written differently, and [Declare the calls a library offers](#declare-the-calls-a-library-offers) below covers it.

**How does the framework register a handler?** itty-router registers with `router.get(path, handler)`, on a router built by the imported `Router`. Express and Hono register the same way, and `@suss/extractor` ships `httpRouteDiscovery` for it, so the pack passes the module, the names it exports, and the verbs.

**What does producing a response look like?** itty-router handlers return the result of `json(body)` or `error(status, message)`, both imported from the library. Neither is a method on a parameter, so these are `functionCall` terminals.

**How do inputs arrive?** The handler takes one object and destructures it: `({ params })`. That is `objectParam`, with `params` mapped to the path parameters.

[Pack patterns](/packs/patterns) has every variant of each field. If none of them fits your framework, open an issue instead of working around it in the pack. A pattern that only one pack can express points at a gap in the pattern system.

## Write the discovery half first

Start with discovery alone and leave `terminals` empty. The pack then finds the right units without describing what happens inside them, and the CLI reports exactly that, so this is a good place to check your work.

```js
// index.mjs
import { httpRouteDiscovery } from "@suss/extractor";

export function ittyRouter() {
  return {
    name: "itty-router",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: httpRouteDiscovery({
      importModule: "itty-router",
      importNames: ["Router", "AutoRouter"],
      methods: [".get", ".post", ".put", ".patch", ".delete"],
    }),

    terminals: [],
    inputMapping: { type: "objectParam", knownProperties: {} },
  };
}

export default ittyRouter;
```

`name` is what summaries record as the pack that recognized the boundary. `protocol` is the transport, so `"http"` here. Export the factory as the default, since that is what the CLI loads.

Put that in a package of its own with `@suss/extractor` as a dependency, install it in the project, and point `-f` at the package name:

```bash
$ suss extract --dir src -f @acme/suss-pack-itty-router -o summaries.json
Wrote 2 summaries to /projects/api/summaries.json in 0.22s

Pack health (1):
  no-output  itty-router  1 summaries -> 0 transitions
```

Discovery works. The `no-output` line in the health report means the pack claimed a unit without describing anything inside it. `suss inspect` reports the same thing under the route it applies to:

```
routes.ts
└─ GET /users/{id}  (itty-router handler | line 7 | confidence: low)
   
       !! 2 returns in this function match none of the terminal shapes this pack looks for, so what they produce is not described here
```

The method and path are already right, and the confidence is low because the pack does not yet describe what the route returns. [Fix a run that found nothing](/guides/fix-an-empty-run) covers the other health codes.

## Add the terminals

`json(user)` and `error(404, "no such user")` are calls to imported functions, so both are `functionCall` matches. Set `requiresImport` on each: `json` and `error` are ordinary names, and without the gate the pack would read a project's own `json` helper as itty-router's, get the argument order wrong, and report high confidence while doing it.

```js
terminals: [
  {
    kind: "response",
    match: {
      type: "functionCall",
      functionName: "json",
      requiresImport: ["itty-router"],
    },
    extraction: {
      body: { from: "argument", position: 0 },
      defaultStatusCode: 200,
    },
  },
  {
    kind: "response",
    match: {
      type: "functionCall",
      functionName: "error",
      requiresImport: ["itty-router"],
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 1 },
    },
  },
],

inputMapping: {
  type: "objectParam",
  knownProperties: { params: "pathParams", query: "queryParams" },
},
```

`defaultStatusCode: 200` is the framework's own default for `json(body)`, which takes no status. Without it the transition comes out with no status code and inspect renders `???`.

Run it again:

```bash
$ suss extract --dir src -f @acme/suss-pack-itty-router -o summaries.json
Wrote 2 summaries to /projects/api/summaries.json in 0.23s

$ suss inspect summaries.json
routes.ts
└─ GET /users/{id}  (itty-router handler | line 7)
       if  !findUser()
         -> 404 "no such user"
           + db.findUser →
       else
         -> 200 { id, name }
           + db.findUser →

db.ts
└─ findUser  (reachable library | line 1)
       -> return { id, name } | null

2 summaries.
```

You get both branches, both status codes, the fields of each body, and the call into `db.ts` that each branch makes. That is enough for the checker to pair this route against a client, an OpenAPI spec, or an intent doc.

## Declare the calls a library offers

A library your handlers call, such as a key-value store, discovers nothing. Its pack declares which calls count and what each one reads or writes, with a builder from `@suss/recognize`, and `pack()` turns the declarations into a `PatternPack`:

```js
// index.mjs
import { constructedFrom, pack, storageCalls } from "@suss/recognize";

const CALLS = storageCalls({
  system: "keyv",
  client: constructedFrom({ from: ["keyv"], named: ["default", "Keyv"] }),
})
  .methods({
    get: { kind: "read", selector: { at: 0 } },
    set: { kind: "write", selector: { at: 0 } },
    delete: { kind: "write", selector: { at: 0 } },
  })
  .example('keyv.get("session:42")');

export default function keyvPack() {
  return pack("keyv", [CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@acme/suss-pack-keyv",
  });
}
```

`client` says where the receiver of a call has to come from, here a `new Keyv()` from the `keyv` package, so a project's own object with a `get` method is left alone. The methods table says what each call does and which argument is the key. `.example` gives one call the declaration matches, which the pack's test runs and pack health asks for. `pack()` gates the pack on the modules the declaration starts from, so a file that never imports `keyv` is skipped. Run it beside a framework pack, `-f hono -f @acme/suss-pack-keyv`, and every handler that calls the store gets a storage effect for the key it reads or writes.

An HTTP client is declared the same way with `httpRequests`, and its pack lists the compiled chains under `requestRecognizers`. [Pack patterns](/packs/patterns#declared-calls) lists every builder and the shipped pack that uses it.

## Only hardcode what the library defines

Every identifier written into a pack has to be one the library itself declares. `Router`, `json` and `error` come from itty-router, so they belong in the pack. A wrapper your own team wrote does not: that goes in the pack's options, which the CLI fills from `-f <pack>=config.json` or from a [dependency stub](/guides/teach-a-dependency). In TypeScript, with the factory typed against the options interface, that looks like this:

```ts
export interface IttyRouterOptions {
  /** Response helpers this project composes the library's own into. */
  responseHelpers?: string[];
}

export function ittyRouter(options: IttyRouterOptions = {}): PatternPack {
  // ...
}
```

A name that one codebase chose gives every other user false matches. It also inflates any coverage number measured against that codebase, because discovery then finds those units by name instead of by pattern.

## Ask the project for a value the code does not show

Some packs cannot read anything until the project tells them one fact. ActiveRecord talks to Postgres, MySQL and SQLite through the same calls, so the pack has to be told which database is behind the connection. A pack declares a value like that under `configuration` on its `declares`:

```ts
configuration: {
  file: "suss.activerecord.json",
  example: { storageSystem: "postgresql" },
  required: true,
  why: "which database is behind the connection: postgresql, mysql, or sqlite.",
  readFromProject: storageSystemFromDatabaseYml,
  databaseOption: "storageSystem",
},
```

`suss init` writes `file` for the project when it can fill the values in, and lists the pack in `suss.json`. It fills them from three places. `defaults` is for values that every project the library's own generator makes has, and init writes them as they are. `readFromProject` is for a value the project has already written down in a file the library itself reads, such as Rails' `config/database.yml`. Init calls it with the project root, and it returns the values and where it found them, as in `{ values: { storageSystem: "sqlite" }, from: "the development adapter in config/database.yml" }`. Init prints where each value came from, so the user can check it.

`databaseOption` is the option that says which database is behind the connection, for a library that talks to several. When `readFromProject` does not settle it, init works it out from what every stack declares: the database driver in the project's manifest, such as `pg` in `Gemfile.lock` or `psycopg` in `pyproject.toml`, and the scheme of a `DATABASE_URL` in `.env.example` or the other environment files. When the project declares more than one database, init takes the one `readFromProject` gave, then the `DATABASE_URL`, then the first driver, and prints a line saying which it took over which.

What `readFromProject` returns goes over the database init worked out, which goes over the defaults. When a required value comes from none of them, init still lists the pack, and every run reports that it reads nothing until the value is set, with `example` to fill in.

Write `readFromProject` only when the library says where that file lives, for the same reason a pack hardcodes only what the library defines. The function should read that file, or the copy a project checks in for it such as `database.yml.sample`, and return. It returns null when the file is missing or does not settle the value, such as an adapter written as ERB.

When an option is a file or directory path, list it under `paths`, as the Rails pack does with `paths: ["root", "routesFile", "engineRoots", "routesFiles"]`. The pack also declares `configDirectory` in its options schema, and resolves a relative path against it. The CLI fills that in with the config file's folder. When it loads the pack, the CLI checks each listed path and reports any that points at nothing, so a config file kept outside the project does not leave the pack quietly reading an empty directory. A test fails when a pack takes `configDirectory` and lists no `paths`.

## Ship it

A pack works as soon as the CLI can import it. `-f @acme/suss-pack-itty-router` imports the package as written, so a pack published under your own scope, or linked into `node_modules`, runs with no further setup.

Contributing the pack to suss takes a few more edits, and a check fails for each one you miss:

- `packages/framework/<name>/`, with `private: true` on its manifest, a `README.md`, a `vocabulary.json` mapping each identifier the pack hardcodes to where in the library it comes from, and an exported `declares: PackDeclaration`.
- `packages/packs/src/<name>.ts`, re-exporting `default`, `declares` and `optionsSchema` from the pack, plus a `./<name>` subpath in the exports of `packages/packs/package.json` and a devDependency on the pack so turbo builds it first.
- `<name>: "@suss/packs/<name>"` in `BUILTIN_FRAMEWORKS` in `packages/cli/src/extract.ts`, since `-f <name>` resolves through that table.
- An entry in `scripts/coverage-packages.mjs`, so the coverage gate reads the package.

`npm run check:packs` reads the first three, `npm run check:vocabulary` reads the vocabulary file, and `npm run check:pack-counts` fails when the [pack catalog](/packs/catalog) does not mention the pack. The catalog's tables are generated from `declares`, so `npm run docs:packs` writes them.

## Test it

A pack test has two layers.

The first layer checks the pattern object, to confirm the returned `PatternPack` is put together the way you meant. Assert on `pack.discovery[i].match.type`, `pack.terminals[i].match`, `inputMapping.knownProperties`. These catch a refactor that silently drops a verb.

The second layer tests extraction end to end. Build a ts-morph project over a fixture, run the adapter, and assert on the summaries:

```ts
const adapter = createTypeScriptAdapter({
  frameworks: [ittyRouter()],
  cacheDir: null,
});
adapter.tsProject.addSourceFileAtPath(FIXTURE);
const summaries = await adapter.extractAll();
```

Assert on status codes, transition counts, input roles, and gaps if the pack reads a declared contract. Share the summaries through `beforeAll` so the ts-morph setup runs once per file. Where the setup is heavy the shipped tests raise the timeout to 30 seconds, since pack tests run concurrently under turbo. `packages/framework/hono/src/index.test.ts` is a short example of both layers.

A pack built from declarations has one more test. `runExamples(pack, run)` from `@suss/recognize` hands each declaration's example to `run`, a function you write that compiles one line and returns the effects the pack recorded, and the test asserts the effect each example states. When the library changes and an example stops matching, that test fails. Inside the repository, the pack harness in `tools/pack-harness` writes the library's types into a test project and builds `run` for you, and `packages/framework/redis/src/index.test.ts` uses it.

## What you do not need to know

A pack author does not touch the engine. You can write a pack without learning how conditions are extracted, how the extractor assembles a summary, or what any other pack does. If you find yourself reaching past your pack's own directory into the engine to express a pattern, the pattern system is missing something. Open an issue for it.
