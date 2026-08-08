# Compatibility

`suss extract` reads your project through its tsconfig, so it sees the
same files and the same module resolution your compiler does. The rest
of this page is about that command. Python and Ruby are read by
separate adapters with their own rules; see
[Read a Python or Ruby project](/guides/python-and-ruby).

## Languages

| | Supported |
|---|---|
| TypeScript | Yes |
| JavaScript | Yes, with `allowJs` in your tsconfig |
| Python | Routes only, through `@suss/adapter-python`. Not reachable from the CLI. |
| Ruby | graphql-ruby fields only, through `@suss/adapter-ruby`. Not reachable from the CLI. |
| Anything else | No |

## Modules and resolution

| | Supported |
|---|---|
| ESM | Yes |
| CommonJS | Yes |
| `moduleResolution: "node"`, `"node16"`, `"nodenext"` | Yes |
| `moduleResolution: "bundler"` | Yes |
| `paths` aliases (`~/*`, `@app/*`) | Yes |
| A tsconfig that `extends` a base | Yes |
| Project references (`composite`) | Not tested |

## Type declarations

| | Supported |
|---|---|
| Types written inline in `.ts` | Yes |
| A `.js` file with a sibling `.d.ts` | Yes, read from the `.js` |
| `@types/*` packages | Yes, once installed |

## Dependencies

Install your project's dependencies before running suss. Some packs
need them; the rest do not.

| | What happens |
|---|---|
| Dependencies installed | Everything works |
| Not installed, pack reads a file on disk | Works. The AWS pack finds handlers through your SAM template. |
| Not installed, pack resolves symbols | Finds nothing, and tells you why |
| A library with no pack | suss marks the call unknown. The rest of the handler still comes through. |

If a pack needs a package you have not installed, suss tells you which one:

```
No summaries to write.

  102 files import @apollo/client, but that package is not installed
  here, so suss cannot see what those calls do.
  Install this project's dependencies, then run the command again.
```

If there is no pack for a library, suss marks that call unknown and
reads the rest of the handler normally:

```ts
const thing = await someInternalLib.lookup(id);  // unknown
if (!id) {
  return json(400, { error: "missing id" });     // read
}
return json(200, { id, name: thing.name });      // read
```

## Your own response helpers

Most handlers build a response through a helper rather than at the
return site. suss follows the call and reads the helper, so it works
with whatever argument order you wrote:

```ts
return json(200, { status: "ok" });   // json(statusCode, payload)
return json({ status: "ok" }, 200);   // json(payload, statusCode)
```

Both come out as 200 with a body of `{ status }`. The name does not
matter either, so `respond`, `ok`, and `send` all work.

suss reads a helper that branches one branch at a time. Each branch that
can run becomes its own outcome, and a branch the caller's arguments
cannot reach is left out:

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

One thing it will not do yet: follow a helper reached through an
object, like `responses.json(...)`. It does read a helper called by name.

## Several services in one folder

suss identifies an HTTP boundary by its method and path, and nothing
else. Two services that both expose `GET /users` count as one boundary,
so a client of either pairs against both:

```
Providers with no client to compare against:
  GET /users
    get, get      <- two unrelated services, one entry
```

Check one service at a time until this is fixed:

```bash
suss extract -p services/auth/tsconfig.json -f hono -o auth/api.json
suss check --dir auth/
```

## Not supported

| | |
|---|---|
| Other languages | Go, Java, C# and the rest are invisible. The adapter interface is language-agnostic, so one could be written; Python and Ruby were. |
| Routes registered at runtime | `registerRoutes(configBuiltAtRuntime)`. suss reads what the code says without running it. |
| Your own wrapper around a library | A project that wraps `useQuery` in a hook of its own is invisible to the Apollo pack, which looks for the library call itself. |
