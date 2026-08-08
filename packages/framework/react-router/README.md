# @suss/framework-react-router

Framework pack for [React Router](https://reactrouter.com/): the routes an app declares, and the loaders and actions that serve them.

## What this package is

`@suss/framework-react-router` returns a `PatternPack` object describing:

- **Discovery** via named exports (`loader`, `action`), and via the route tree the app declares in its own JSX
- **Terminals**: `json()`, `data()`, `redirect()` function calls, the JSX a routed component returns, plus `throw` through any error helper the project lists in `errorHelpers`
- **Input mapping**: single object parameter with `request`, `params`, `context` roles

## Routes the app declares

A `<Route path="/users/:id" element={<UserDetail />} />` becomes a summary for
`UserDetail` bound to `GET /users/:id`, so it pairs with whoever calls that URL.
Nested routes join their parent's path and an index route serves the parent's
own path, following React Router's own composition. The object form
(`createBrowserRouter([{ path, element }])`) works the same way, including
through a name the array is bound to above the call, and
`createRoutesFromElements` reads through to the elements themselves.

When the pack cannot read something, it says so rather than guessing. A path
built at runtime, a spread standing in for routes another module declares, and
a route object a call builds each produce a summary that claims no path and has
a gap saying what went unread. A route whose path the pack can read but whose
element is computed stays discovered, as a boundary with nothing behind it.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-react-router.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
