# @suss/framework-fastify

Framework pack for [Fastify](https://fastify.dev/) handlers. Declarative patterns for `app.<method>(path, handler)` registration and Fastify's `reply` API.

## What this package is

`@suss/framework-fastify` returns a `PatternPack` object describing:

- **Discovery** via `Fastify().get/post/put/delete/patch/head/options(path, handler)` registration calls (both default and named imports)
- **Terminals**: `reply.code(N).send(body)`, `reply.status(N).send(body)`, `reply.send(body)`, `reply.redirect(...)`, and `throw`
- **Input mapping**: positional parameters `(request, reply)` with semantic roles

### Limitations (v0)

- The "return value becomes the body" pattern (`return user`, where Fastify serializes the return) is **not** matched as a response terminal. Only `reply.<method>(...)` chains are recognized today. Workaround: use `return reply.send(value)` (also valid Fastify) when you want suss to see the response.

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-fastify.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
