# @suss/framework-fastify

Framework pack for [Fastify](https://fastify.dev/). It finds routes registered as `app.<method>(path, handler)` and reads what each handler sends through Fastify's `reply` API.

```ts
import Fastify from "fastify";

const app = Fastify();

app.get("/users/:id", async (request, reply) => {
  return reply.code(404).send({ error: "not found" });
});
```

## What this package is

`@suss/framework-fastify` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: calls to `get`, `post`, `put`, `delete`, `patch`, `head` and `options` on `Fastify()`, with either the default or the named import.
- **Terminals**: `reply.code(N).send(body)`, `reply.status(N).send(body)`, `reply.send(body)`, `reply.redirect(...)`, `throw`, and a return with a value (`return user`), which Fastify serializes as the body of a 200.
- **Input mapping**: the positional parameters `(request, reply)`, each with its role.
- **Request spelling**: the parts of the request a handler reads, `request.headers`, `request.query`, `request.params` and `request.body`, each by the field it wants. suss compares a boundary intent's `receives` block against those reads.
- **Project helpers**: before extraction, suss reads any function the code passes its app to, and fills in what that function registers at each call site. So `registerCrud(app, "users", h)` and `registerCrud(app, "orders", h)` give both routes.

## Options

None. `registrationHelpers` used to list the route helpers a project wrote for itself, and the helper reading above replaced it. A config file that still sets it gets a warning, and in 0.22.0 it stops the run.

### Limitations (v0)

- A bare `return;` does not count as a response terminal, and neither does a handler that runs off the end of its body. Fastify sends nothing in either case, so the handler comes back with no transition and a gap saying nothing in the body matched. Write `return reply.send(value)`, or return a value, when the route is meant to respond.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-fastify.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
