# @suss/runtime-web

Runtime pack for the web `fetch` API. Discovers `fetch()` call sites, extracts method/path from arguments, and produces client behavioral summaries.

## What this package is

`@suss/runtime-web` returns a `PatternPack` object describing:

- **Discovery** via global `fetch()` call sites (not an import — `fetch` is a built-in)
- **Binding extraction**: URL path from the first argument (literal strings only), HTTP method from `options.method` (defaults to `GET`)
- **Terminals**: `returnStatement` (any return) and `throwExpression`

This is a "runtime pack" — `fetch` is a built-in web API, not a third-party framework. It uses the same `PatternPack` interface because the adapter interprets both identically.

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-web.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
