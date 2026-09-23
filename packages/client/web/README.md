# @suss/client-web

Client pack for the web `fetch` API. It finds `fetch()` call sites, reads the method and path from the arguments, and produces client summaries.

```ts
const response = await fetch("/api/orders/42", { method: "DELETE" });
```

## What this package is

`@suss/client-web` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: calls to the global `fetch()`. There is no import to match, since `fetch` is built in. The call can be written bare or through the global object, as `globalThis.fetch()`, `window.fetch()`, `self.fetch()` or `global.fetch()`.
- **Binding extraction**: the URL path from the first argument (literal strings only), and the HTTP method from `options.method`, which defaults to `GET`.
- **Terminals**: `returnStatement` (any return) and `throwExpression`.

`fetch` is a web API built into the runtime and has no framework behind it, so this is a client pack. It uses the same `PatternPack` interface because the adapter reads both kinds of pack the same way.

## Where it fits in suss

This package depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-web.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
