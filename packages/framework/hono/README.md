# @suss/framework-hono

Framework pack for [Hono](https://hono.dev/) handlers. A Hono handler takes one context and returns its response, so the terminals read the status off the response call itself.

## What this package is

`@suss/framework-hono` returns a `PatternPack` object describing:

- **Discovery** via `new Hono()` and `new OpenAPIHono()` registration calls: `.get`, `.post`, `.put`, `.delete`, `.patch`, `.options`, `.all`. A sub-app mounted with `app.route(prefix, sub)` composes the prefix into the routes the sub-app declares, following the sub-app through an import when it is declared in another file. A mount the resolution store cannot follow to a concrete sub-app, or whose prefix is not a string literal, leaves the route's path as written.
- **Discovery** of `app.openapi(route, handler)`, where the route is a `createRoute({ method, path, ... })` object that usually lives on a shared contract in another file. The method and the path are read off that object.
- **Terminals**: `c.json(body, status?)`, `c.text(body, status?)`, `c.body(data, status?)`, `c.redirect(location, status?)`, `c.notFound()`, and `throw new HTTPException(status, ...)`. A handler that leaves the status off gets 200, except for `redirect` (302) and `notFound` (404).
- **Contract reading** from the `responses` property of the `createRoute` object registered alongside the handler, so a handler returning a status the route never declares comes out as a contract finding.
- **Input mapping**: one positional parameter, the context, carrying the request and the response methods together.
- **Transparent wrapper**: `createRoute` from `@hono/zod-openapi` hands its config back unchanged, so the call is the route object. The pack has to say so because the wrapper's body lives in the library, where nobody can read it.

## Options

A project that registers routes through a helper of its own passes that helper in. A helper's name belongs to one project, so this arrives through per-project pack config rather than shipping inside the pack.

```json
{
  "registrationHelpers": [
    {
      "helperName": "registerCrud",
      "importModule": "./routes/crud",
      "registrations": [
        { "method": "GET", "pathTemplate": "/{1}", "handlerArg": "{2}.list" },
        { "method": "POST", "pathTemplate": "/{1}", "handlerArg": "{2}.create" }
      ]
    }
  ]
}
```

Pass it with `suss extract -f hono=config.json`.

- `registrationHelpers`: the project's own registration helpers, each expanded into the routes one call registers.
  - `helperName`: the helper's exported name, as the project's code imports it.
  - `importModule`: the module the helper is imported from, which tells two same-named helpers apart. Optional.
  - `registrations`: one entry per route the helper call registers. `{N}` is replaced by the helper call's argument at position N, and `handlerArg` can add one property on that argument.

## Where it fits in suss

Depends only on `@suss/extractor`, for the `PatternPack` type and the two helpers that build the discovery patterns. Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-hono.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
