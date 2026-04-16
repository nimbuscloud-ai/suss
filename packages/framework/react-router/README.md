# @suss/framework-react-router

Framework pack for [React Router](https://reactrouter.com/) loaders and actions. Declarative patterns for file-convention-based discovery and React Router's terminal shapes.

## What this package is

`@suss/framework-react-router` returns a `FrameworkPack` object describing:

- **Discovery** via named exports (`loader`, `action`)
- **Terminals**: `json()`, `data()`, `redirect()` function calls and `throw` with `httpErrorJson`
- **Input mapping**: single object parameter with `request`, `params`, `context` roles

## Where it sits in suss

Depends only on `@suss/extractor` (for the `FrameworkPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-react-router.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
