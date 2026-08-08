# @suss/client-web

Client pack for the web `fetch` API. It discovers `fetch()` call sites, extracts the method and path from the arguments, and produces client behavioral summaries.

## What this package is

`@suss/client-web` returns a `PatternPack` object describing:

- **Discovery** via global `fetch()` call sites (not an import; `fetch` is a built-in)
- **Binding extraction**: URL path from the first argument (literal strings only), HTTP method from `options.method` (defaults to `GET`)
- **Terminals**: `returnStatement` (any return) and `throwExpression`

This is a "client pack": `fetch` is a built-in web API, not a third-party framework. It uses the same `PatternPack` interface because the adapter interprets both of them identically.

## Where it fits in suss

This package depends only on `@suss/extractor` (for the `PatternPack` type). It contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-web.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
