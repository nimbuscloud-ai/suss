# @suss/framework-express

Framework pack for [Express](https://expressjs.com/) handlers. Declarative patterns for registration-based discovery and Express's response method chains.

## What this package is

`@suss/framework-express` returns a `PatternPack` object describing:

- **Discovery** via `express.Router().get/post/put/delete/patch()` registration calls
- **Terminals**: `res.status(N).json(body)`, `res.json(body)`, `res.sendStatus(N)`, `res.redirect()`, and `throw`
- **Input mapping**: positional parameters `(req, res, next)` with semantic roles

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-express.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
