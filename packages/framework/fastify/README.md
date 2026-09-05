# @suss/framework-fastify

Framework pack for [Fastify](https://fastify.dev/) handlers. Declarative patterns for `app.<method>(path, handler)` registration and Fastify's `reply` API.

## What this package is

`@suss/framework-fastify` returns a `PatternPack` object describing:

- **Discovery** via `Fastify().get/post/put/delete/patch/head/options(path, handler)` registration calls (both default and named imports)
- **Terminals**: `reply.code(N).send(body)`, `reply.status(N).send(body)`, `reply.send(body)`, `reply.redirect(...)`, `throw`, and a return with a value (`return user`), which Fastify serializes as the body of a 200
- **Input mapping**: positional parameters `(request, reply)` with semantic roles
- **Project helpers**: a function the code hands its app to is read before extraction, and what it registers is filled in at each call site, so `registerCrud(app, "users", h)` and `registerCrud(app, "orders", h)` give both routes

## Options

None. `registrationHelpers` used to say what a route helper of the project's own registered; the reading above replaced it, and a config file that still sets it is read past with a warning, and stops the run in 0.22.0.

### Limitations (v0)

- A bare `return;` is not matched as a response terminal, and neither is a handler that runs off the end of its body. Fastify does not send anything for either one, so the handler comes back with no transition and a gap saying nothing in the body matched. Write `return reply.send(value)` or return a value when the route is meant to answer.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-fastify.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
