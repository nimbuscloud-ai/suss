# @suss/runtime-axios

Runtime pack for the [axios](https://axios-http.com/) HTTP client. Discovers `axios.<method>(url, ...)` call sites and produces client behavioral summaries.

## What this package is

`@suss/runtime-axios` returns a `PatternPack` object describing:

- **Discovery** via `axios.get/post/put/delete/patch/head/options(url, ...)` call sites where `axios` is imported as the default export from `"axios"`
- **Binding extraction**: HTTP method from the called method name; URL path from the first argument (literal strings only)
- **Terminals**: `returnStatement` and `throwExpression`
- **Response semantics**: `response.data` → body, `response.status` → status code, `response.headers` → headers

This is a "runtime pack" — axios is a third-party HTTP client used at consumer call sites, the same role as `@suss/runtime-web` for native `fetch`.

### Limitations (v0)

- **Bare-call form not supported.** `axios({ url, method })` and `axios.request(config)` aren't matched — only the per-verb method calls are.
- **Aliased default imports** (`import myAxios from "axios"`) are not recognized — the pack matches the conventional `import axios from "axios"`.

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-axios.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
