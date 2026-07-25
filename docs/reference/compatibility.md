# What suss reads

Which project shapes suss handles, and where it stops. Every row is a
committed fixture under `fixtures/compat/`, run in CI against the same
one-route service, so this page cannot drift from what the tool does.

## Project shapes

| Shape | Supported | Notes |
|---|---|---|
| TypeScript | Yes | |
| JavaScript | Yes | Needs `allowJs` in the tsconfig, since suss reads the file set your compiler sees. |
| ESM | Yes | |
| CommonJS | Yes | |
| `moduleResolution: "bundler"` | Yes | The esbuild and Vite default. |
| `moduleResolution: "node"` / `"node16"` / `"nodenext"` | Yes | |
| A tsconfig that `extends` a base | Yes | Resolved the way `tsc` resolves it, including `paths`. |
| A helper implemented in `.js` with a sibling `.d.ts` | Yes | Read from the implementation, since a declaration says nothing about behaviour. |
| Dependencies not installed | Partly | See below. |

## When dependencies are not installed

Packs fall into two groups, and only one of them needs `node_modules`.

A pack that keys off something on disk keeps working without an install.
The AWS Lambda pack reads your SAM template to find handlers, so a fresh
checkout extracts fine.

A pack that has to resolve symbols does not. The Apollo Client pack has
to know that a `useQuery` came from `@apollo/client` before it can read
the operation, and without the package there is nothing to resolve
against. That run produces nothing, and says so:

```
No summaries to write.

  102 files import @apollo/client, but that package is not installed
  here, so suss cannot see what those calls do.
  Install this project's dependencies, then run the command again.
```

Run `npm install` in the project you are analyzing before extracting.

## Libraries suss knows nothing about

A call into an unrecognized library does not cost you the rest of the
summary. The handler's own branches, statuses, and body shapes still
come through; only the value that call returns is unknown, and it is
marked unknown rather than guessed.

```ts
const thing = await someInternalLib.lookup(id);  // opaque
if (!id) {
  return json(400, { error: "missing id" });     // still extracted
}
return json(200, { id, name: thing.name });      // still extracted
```

## Response helpers

Most handlers build their response in a helper rather than at the return
site. suss follows the call into the helper and reads its parameters, so
the argument order is whatever you wrote:

```ts
// Both of these extract as 200 with a body of { status }.
return json(200, { status: "ok" });     // json(statusCode, payload)
return json({ status: "ok" }, 200);     // json(payload, statusCode)
```

The name does not matter either. `respond`, `ok`, and `send` work the
same way, because the pack describes the envelope shape rather than
naming your function.

Two limits. A helper that branches into several returns builds several
envelopes, which suss does not model yet; those report the status as
unknown with the source text rather than picking one. And a helper
reached through an object (`responses.json(...)`) is not followed yet,
only a directly named function.

## Not supported

- **Languages other than TypeScript and JavaScript.** A Python or Ruby
  service is invisible. The adapter interface is language-agnostic, so
  another one could be written, but none exists.
- **Dynamic registration.** `registerRoutes(configArray)` where the array
  is built at runtime. suss reads what the code says statically.
- **Local wrappers around a library primitive.** A project that wraps
  `useQuery` in its own `useGraphQLQuery` hook is invisible to the Apollo
  pack, which recognizes the library call itself. Following recognition
  through a wrapper is designed but unbuilt.
