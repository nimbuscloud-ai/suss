# @suss/framework-express

Framework pack for [Express](https://expressjs.com/). It finds the routes an app or a router registers, and reads the status and body each handler sends back through Express's response methods.

```ts
import express from "express";

const app = express();
const router = express.Router();

router.post("/", validate, asyncHandler(login), respond);
```

## What this package is

`@suss/framework-express` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: calls to `get`, `post`, `put`, `delete` and `patch` on a router from `express.Router()`. Both import spellings work: `import { Router } from "express"` with `Router()`, and `import express from "express"` with `express.Router()`. The same goes for the app, `express()`.
- **Wrappers**: middleware registered around the routes. `app.use(fn)` runs for every route on the app. When `fn` takes four arguments it is an error handler instead, and Express calls it only for a request that threw, passing the thrown value as its first parameter. The number of parameters is the only way to tell the two apart. Each middleware gets a summary of its own, which is where the status it sends is recorded, and every route on the same app points at it. A route can also list its own. In `router.post("/", validate, asyncHandler(login), respond)`, the first two run before `respond`, and suss reads each as a middleware of that route, inside whatever the app registers. A middleware with no name of its own is named after its factory and the route, as in `asyncHandler@POST /login`.
- **Terminals**: `res.status(N).json(body)`, `res.json(body)`, `res.sendStatus(N)`, `res.redirect()`, and `throw`.
- **Input mapping**: the positional parameters `(req, res, next)`, each with its role.
- **Request spelling**: the parts of the request a handler reads, `request.headers`, `request.query`, `request.params` and `request.body`, each by the field it wants. suss compares a boundary intent's `receives` block against those reads.
- **Project helpers**: before extraction, suss reads any function the code passes its app to, and fills in what that function registers at each call site. So `registerCrud(app, "users", h)` and `registerCrud(app, "orders", h)` give both routes.

## Setup

Run `suss extract -f express` against the project. `express` itself does not have to be installed. The pack matches on the import specifier, so it can read a checkout whose dependencies were never fetched, and suss prints a note saying so at the end of the run. If you install the project's dependencies, suss resolves types through Express's own declarations and records more detail on the routes it finds.

## Options

None. `registrationHelpers` used to list the route helpers a project wrote for itself, and the helper reading above replaced it. A config file that still sets it gets a warning, and in 0.22.0 it stops the run.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-express.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
