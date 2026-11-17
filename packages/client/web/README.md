# @suss/client-web

Client pack for the web `fetch` API. It finds `fetch()` call sites, reads the method and path from the arguments, and produces client summaries.

```ts
const response = await fetch("/api/orders/42", { method: "DELETE" });
```

## What this package is

`@suss/client-web` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Requests**: calls to `fetch()`, declared with `@suss/recognize`'s `httpRequests`. There is no import to match, since `fetch` is built in. The call can be written bare or through the global object, as `globalThis.fetch()`, `window.fetch()`, `self.fetch()` or `global.fetch()`. A `fetch` the program binds itself, such as one a caller hands in or one a fetch library exports, is read as `fetch` too, since it is nearly always an implementation of it.
- **Binding**: the URL from the first argument, evaluated, and the HTTP method from `options.method`, which is `GET` when the call states none or states one suss cannot settle. `options.redirect` says whether the call follows a redirect. A `data:` URL makes no request.
- **Terminals**: `returnStatement` (any return) and `throwExpression`.

`fetch` is a web API built into the runtime and has no framework behind it, so this is a client pack. It uses the same `PatternPack` interface because the adapter reads both kinds of pack the same way.

## Where it fits in suss

The pack declares its calls with `@suss/recognize`'s `httpRequests`, and depends on `@suss/extractor` for the `PatternPack` type. It has no analysis of its own. The adapter's discovery hands each call in a file to the declaration.

## Coverage

![coverage](../../../.github/badges/coverage-web.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
