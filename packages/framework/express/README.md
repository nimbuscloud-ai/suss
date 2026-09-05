# @suss/framework-express

Framework pack for [Express](https://expressjs.com/) handlers. Declarative patterns for registration-based discovery and Express's response method chains.

## What this package is

`@suss/framework-express` returns a `PatternPack` object describing:

- **Discovery** via `express.Router().get/post/put/delete/patch()` registration calls. The router can come from either import spelling: `import { Router } from "express"` and `Router()`, or `import express from "express"` and `express.Router()`. So can the app, `express()`.
- **Wrappers** registered around the routes: `app.use(fn)` runs for every route on the app, and the same call with a four-argument function is an error handler, which Express invokes only for a request that threw, handing it the thrown value as its first parameter. Arity is the only thing that tells the two apart. Each becomes a summary of its own, where the status it produces lives, and every route on the same app points at it.
- **Terminals**: `res.status(N).json(body)`, `res.json(body)`, `res.sendStatus(N)`, `res.redirect()`, and `throw`
- **Input mapping**: positional parameters `(req, res, next)` with semantic roles
- **Project helpers**: a function the code hands its app to is read before extraction, and what it registers is filled in at each call site, so `registerCrud(app, "users", h)` and `registerCrud(app, "orders", h)` give both routes

## Setup

Run `suss extract -f express` against the project. The pack does not require `express` itself to be installed: it matches on the import specifier, so it reads a checkout whose dependencies were never fetched, and says so in a note at the end of the run. Installing the project's dependencies lets suss resolve types through Express's own declarations, which produces more detail on the routes it finds.

## Options

None. `registrationHelpers` used to say what a route helper of the project's own registered; the reading above replaced it. A config file that still sets it is read past with a warning, and stops the run in 0.22.0.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-express.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
