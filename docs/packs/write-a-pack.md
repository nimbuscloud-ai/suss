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

Every pack starts with the same three, and the answers become the three required fields of a `PatternPack`.

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

## What you do not need to know

A pack author does not touch the engine. You can write a pack without learning how conditions are extracted, how the extractor assembles a summary, or what any other pack does. If you find yourself reaching past your pack's own directory into the engine to express a pattern, the pattern system is missing something. Open an issue for it.
