# @suss/framework-express

Framework pack for [Express](https://expressjs.com/) handlers. Declarative patterns for registration-based discovery and Express's response method chains.

## What this package is

`@suss/framework-express` returns a `PatternPack` object describing:

- **Discovery** via `express.Router().get/post/put/delete/patch()` registration calls
- **Wrappers** registered around the routes: `app.use(fn)` runs for every route on the app, and the same call with a four-argument function is an error handler, which Express invokes only for a request that threw, handing it the thrown value as its first parameter. Arity is the only thing that tells the two apart. Each becomes a summary of its own, where the status it produces lives, and every route on the same app points at it.
- **Terminals**: `res.status(N).json(body)`, `res.json(body)`, `res.sendStatus(N)`, `res.redirect()`, and `throw`
- **Input mapping**: positional parameters `(req, res, next)` with semantic roles

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-express.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
