# @suss/framework-react-router

Framework pack for [React Router](https://reactrouter.com/). It reads the routes an app declares, and the loaders and actions that serve them.

## What this package is

`@suss/framework-react-router` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: the named exports `loader` and `action`, and the route tree the app declares in its own JSX.
- **Terminals**: calls to `json()`, `data()` and `redirect()`, the JSX a routed component returns, and a `throw` through any error helper the project lists in `errorHelpers`.
- **Input mapping**: a single object parameter with the roles `request`, `params` and `context`.

## Routes the app declares

A `<Route path="/users/:id" element={<UserDetail />} />` becomes a summary for
`UserDetail` bound to `GET /users/:id`, so it pairs with any caller of that URL.
A nested route adds its path to its parent's, and an index route serves the
parent's own path, the same way React Router puts them together. The object form
(`createBrowserRouter([{ path, element }])`) works the same way, including when
the array is bound to a name above the call. `createRoutesFromElements` is read
through to the elements themselves.

When the pack cannot read something, it records that instead of guessing. A
path built at runtime, a spread of routes that another module declares, and a
route object built by a call each produce a summary that claims
no path, with a gap saying what went unread. A route whose path the pack can read
but whose element is computed is still discovered, as a boundary with nothing
behind it.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-react-router.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
