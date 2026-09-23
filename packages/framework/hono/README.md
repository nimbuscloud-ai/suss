# @suss/framework-hono

Framework pack for [Hono](https://hono.dev/). A Hono handler takes one context and returns its response, so the pack reads the status off the response call itself.

```ts
const app = new Hono();

app.get("/orders", requireCaller, (c) => c.json(orders, 200));
app.route("/admin", adminApp);
```

## What this package is

`@suss/framework-hono` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: calls to `.get`, `.post`, `.put`, `.delete`, `.patch`, `.options` and `.all` on `new Hono()` and `new OpenAPIHono()`. When a sub-app is mounted with `app.route(prefix, sub)`, the prefix is added to the routes the sub-app declares, and suss follows the sub-app through an import when it lives in another file. If the resolution store cannot follow a mount to a concrete sub-app, or the prefix is not a string literal, the route's path stays as written.
- **Discovery** of `app.openapi(route, handler)` too. The route there is a `createRoute({ method, path, ... })` object, usually on a shared contract in another file, and the pack reads the method and the path off it.
- **Wrappers**: middleware registered around the routes. `app.use(path, middleware)` runs for the routes the path pattern covers. `app.onError(fn)` runs only for a request that threw, and Hono passes the thrown value as its first parameter. Each gets a summary of its own, which is where its 401 or its 500 is recorded, and every route on the same app points at it. A route can also list its own, as in `app.get("/orders", requireCaller, handler)`, and suss reads each one listed as a middleware of that route, inside whatever the app registers. A registration whose function the resolution store cannot follow adds nothing.
- **Terminals**: `c.json(body, status?)`, `c.text(body, status?)`, `c.body(data, status?)`, `c.redirect(location, status?)`, `c.notFound()`, and `throw new HTTPException(status, ...)`. A handler that leaves the status off gets 200, except for `redirect` (302) and `notFound` (404).
- **Contract reading**: the `responses` property of the `createRoute` object registered with the handler. A handler that returns a status the route never declares comes out as a contract finding.
- **Input mapping**: one positional parameter, the context, which has the request and the response methods on it.
- **Request spelling**: the parts of the request a handler reads, `c.req.header`, `c.req.query`, `c.req.param` and `c.req.json`. Hono takes the field as an argument (`c.req.header("x-tenant-id")`), and the recorded read has the method without the field. So suss compares a `receives` block on a Hono route one section at a time instead of one field at a time.
- **Transparent wrapper**: `createRoute` from `@hono/zod-openapi` returns its config unchanged, so the call is the route object. The pack has to declare this because the wrapper's body is in the library, where suss cannot read it.

## Options

None. The pack used to take `registrationHelpers`, which listed what a route helper of the project's own registers:

```ts
export function registerCrud(app: Hono, name: string, handlers: Handlers) {
  app.get(`/${name}`, handlers.list);
  app.post(`/${name}`, handlers.create);
}

registerCrud(app, "users", userHandlers);
registerCrud(app, "orders", orderHandlers);
```

suss reads helpers like this itself now. Before it walks any file, it finds every function the project passes its app to and records what each one registers in terms of its own parameters (`GET /{1}` with the handler at `{2}.list`). Then it fills those in at each call site, so the two calls above give four routes. A config file that still sets the option gets a warning, and in 0.22.0 it stops the run with a line saying so.

If suss reads a helper and then no call matches it, the helper shows up under `no-helper` in [pack health](../../../docs/guides/fix-an-empty-run.md). The bug is in suss, since suss found the call site in the first place.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type and the two helpers that build the discovery patterns. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-hono.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
