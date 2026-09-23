---
title: Compatibility and limits
description: The languages, project layouts and frameworks suss reads today, and the places it stops.
---

# Compatibility

`suss extract` reads a TypeScript or JavaScript project through its tsconfig, so it sees the same files and the same module resolution your compiler does. Python and Ruby have adapters of their own, which follow different rules. Those rules are in [Read Python or Ruby](/guides/python-and-ruby).

## Languages

| | Supported |
|---|---|
| TypeScript | Yes |
| JavaScript | Yes, with `allowJs` in your tsconfig |
| Python | Yes: `suss extract --lang python` |
| Ruby | Yes: `suss extract --lang ruby` |
| Anything else | No |

The Python and Ruby adapters parse with tree-sitter compiled to WASM, so neither needs an installed interpreter. A directory with a `pyproject.toml` or a `Gemfile.lock` in it is recognized without the flag.

## Frameworks and libraries

Everything suss recognizes comes from a pack, and the packs ship inside `@suss/cli`. [Pack catalog](/packs/catalog) lists them all, with the libraries each one reads. `suss init` matches your dependencies against that list and prints the commands for your project.

## Modules and resolution

| | Supported |
|---|---|
| ESM | Yes |
| CommonJS | Yes |
| `moduleResolution: "node"`, `"node16"`, `"nodenext"` | Yes |
| `moduleResolution: "bundler"` | Yes |
| `paths` aliases (`~/*`, `@app/*`) | Yes |
| A tsconfig that `extends` a base | Yes |
| Project references (`composite`) | Yes. A tsconfig with no files of its own takes its file list from the union of its references. |

## Type declarations

| | Supported |
|---|---|
| Types written inline in `.ts` | Yes |
| A `.js` file with a sibling `.d.ts` | Yes, read from the `.js` |
| `@types/*` packages | Yes, once installed |

## Dependencies

Install your project's dependencies before running suss. Some packs resolve symbols through them and cannot do their job otherwise.

| | What happens |
|---|---|
| Dependencies installed | Everything works |
| Not installed, pack reads a file on disk | Works. The AWS pack finds handlers through your SAM template. |
| Not installed, pack resolves symbols | Finds nothing, and tells you which package is missing |
| A library with no pack | suss marks the call unknown and reads the rest of the unit |

When a pack needs a package you have not installed, the run tells you which one:

```
No summaries to write in 0.02s.
  1 file imports @prisma/client, but that package is not installed here.
  suss cannot see what a call does without the package behind it.
  Install this project's dependencies, then run the command again.
```

## Your own response helpers

Most handlers build a response through a helper of their own. suss follows the call and reads the helper, so it works with whatever argument order you wrote:

```ts
return json(200, { status: "ok" });   // json(statusCode, payload)
return json({ status: "ok" }, 200);   // json(payload, statusCode)
```

Both come out as 200 with a body of `{ status }`. The name does not matter either, so `respond`, `ok` and `send` all work.

A helper that branches is read one branch at a time. Each branch the caller's arguments can reach becomes its own outcome, and the ones they cannot reach are left out:

```ts
function json(statusCode, payload) {
  if (statusCode > 399) {
    return { statusCode, body: JSON.stringify({ error: payload }) };
  }
  return { statusCode, body: JSON.stringify(payload) };
}

return json(200, { status: "ok" });   // 200 only. 200 > 399 is false.
return json(500, "boom");             // 500 only, with an error body.
return json(code, payload);           // both, since `code` is unknown here.
```

## Your own route helpers

A service that outgrows one file hands its app to functions of its own, and those functions write the routes:

```ts
// src/routes.ts
export function registerHealth(app: Express): void {
  app.get("/health", (_req, res) => res.json({ ok: true }));
}

// src/index.ts
const app = express();
registerHealth(app);
```

suss reads `GET /health` here. The receiver is a parameter, the parameter comes from whatever each caller passed, and the walk ends at the `express()` that built the app. It follows the app through however many helpers you hand it to, and it resolves the path and the handler the same way.

A helper called from several places with different arguments would leave those values undecided, so suss works from the other direction. Before extraction it writes down what each such function registers in terms of its own parameters, then fills those parameters in at every call site. Given a helper that writes ``app.get(`/${name}`, handlers.list)``, the call `registerCrud(app, "users", handlers)` gives you `GET /users` and `POST /users`. The helper's own file doesn't have to mention express, so a parameter typed with an interface of your own works here too.

## Where it stops

**A helper reached through an object.** suss follows a helper called by its own name. `responses.json(200, payload)` is not followed, and the handler comes back with a low-confidence summary recording that the return didn't match any terminal shape in the pack.

**An app with two values.** When the app itself is built twice and handed to one helper, suss cannot tell which app the helper registered on, so the route is left out. The handler's summary says so under `Could not follow:` in `suss inspect`:

```
Could not follow:
  The call to target.get is made on a receiver this run reads as 2 different
  values, so nothing says which one it registers on and the registration is
  left out
```

**Two services in one folder.** suss identifies an HTTP boundary by its method and path and nothing else, so two services that both expose `GET /users` count as one boundary and a client of either pairs against both. Check one service at a time until this is fixed; [Work across services](/guides/work-across-services#two-services-that-serve-the-same-path) has the commands.

**Routes registered at runtime.** suss gets nothing out of `registerRoutes(configBuiltAtRuntime)`, because it reads what the code says without running it.

**Other languages.** suss reads nothing of Go, Java, C# or anything else. The adapter interface is not tied to a particular language, so somebody could write an adapter for one of them, the way the Python and Ruby adapters were written.
