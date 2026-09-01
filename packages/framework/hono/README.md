# @suss/framework-hono

Framework pack for [Hono](https://hono.dev/) handlers. A Hono handler takes one context and returns its response, so the terminals read the status off the response call itself.

## What this package is

`@suss/framework-hono` returns a `PatternPack` object describing:

- **Discovery** via `new Hono()` and `new OpenAPIHono()` registration calls: `.get`, `.post`, `.put`, `.delete`, `.patch`, `.options`, `.all`. A sub-app mounted with `app.route(prefix, sub)` composes the prefix into the routes the sub-app declares, following the sub-app through an import when it is declared in another file. A mount the resolution store cannot follow to a concrete sub-app, or whose prefix is not a string literal, leaves the route's path as written.
- **Discovery** of `app.openapi(route, handler)`, where the route is a `createRoute({ method, path, ... })` object that usually lives on a shared contract in another file. The method and the path are read off that object.
- **Wrappers** registered around the routes: `app.use(path, middleware)`, which runs for the routes the path pattern covers, and `app.onError(fn)`, which Hono invokes only for a request that threw, handing it the thrown value as its first parameter. Each becomes a summary of its own, where its 401 or its 500 lives, and every route on the same app points at it. A registration whose function the resolution store cannot follow contributes nothing.
- **Terminals**: `c.json(body, status?)`, `c.text(body, status?)`, `c.body(data, status?)`, `c.redirect(location, status?)`, `c.notFound()`, and `throw new HTTPException(status, ...)`. A handler that leaves the status off gets 200, except for `redirect` (302) and `notFound` (404).
- **Contract reading** from the `responses` property of the `createRoute` object registered alongside the handler, so a handler returning a status the route never declares comes out as a contract finding.
- **Input mapping**: one positional parameter, the context, carrying the request and the response methods together.
- **Transparent wrapper**: `createRoute` from `@hono/zod-openapi` hands its config back unchanged, so the call is the route object. The pack has to say so because the wrapper's body lives in the library, where nobody can read it.

## Options

None. The pack used to take `registrationHelpers`, saying what a route helper of the project's own registers:

```ts
export function registerCrud(app: Hono, name: string, handlers: Handlers) {
  app.get(`/${name}`, handlers.list);
  app.post(`/${name}`, handlers.create);
}

registerCrud(app, "users", userHandlers);
registerCrud(app, "orders", orderHandlers);
```

suss reads that itself now. Before any file is walked it finds every function the project hands its app to, reads what each registers in terms of the function's own parameters (`GET /{1}` with the handler at `{2}.list`), and fills those in at each call site. The two calls above give four routes. A config file that still sets the option is refused, with a line saying so.

A helper suss read that no call then matched comes out under `no-helper` in [pack health](../../../docs/guides/pack-health.md). That is a bug in suss rather than in your code: it found the call site to begin with.

## Where it fits in suss

Depends only on `@suss/extractor`, for the `PatternPack` type and the two helpers that build the discovery patterns. Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-hono.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
