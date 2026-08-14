# @suss/client-axios

Client pack for the [axios](https://axios-http.com/) HTTP client. It discovers `axios.<method>(url, ...)` call sites and produces client behavioral summaries.

## What this package is

`@suss/client-axios` returns a `PatternPack` object describing:

- **Discovery** via `axios.get/post/put/delete/patch/head/options(url, ...)` call sites where `axios` is imported as the default export from `"axios"`, whether the call is made on the `axios` import itself, on a variable built by `axios.create(...)`, or on a name imported from wherever that variable was declared
- **Binding extraction**: HTTP method from the called method name; URL path from the first argument (literal strings only)
- **Terminals**: `returnStatement` and `throwExpression`
- **Response semantics**: `response.data` → body, `response.status` → status code, `response.headers` → headers

This is a "client pack": axios is a third-party HTTP client used at consumer call sites, the same role as `@suss/client-web` for native `fetch`.

### Cross-file instances and wrappers

The most common arrangement in production builds one `axios.create({...})` instance in a shared module and calls it from wherever a request is made, often from a different file than the one that built it:

```ts
// client.ts
export const api = axios.create({ baseURL: "/api" });

// users.ts
import { api } from "./client";
export async function getUser(id: string) {
  return api.get(`/users/${id}`);
}
```

`getUser` is discovered as a client boundary with the path extracted from its own call site, the same as if `api` had been built right there. The import can also come through a barrel that re-exports the instance, and resolution follows that chain back to where the instance was constructed. A hand-written wrapper around the instance works too, as long as the wrapper is a single method or function whose body passes its own path argument straight into one call on a resolved instance:

```ts
class Api {
  static get(route: string) {
    return api.get(route);
  }
}
```

`Api.get` is discovered as a client boundary whose path is unresolved, because the path is a parameter rather than a literal. Every caller of `Api.get` with a literal path (`Api.get("/pet/1")`) gets its own synthesized summary, the way any other wrapper-style client already does.

A project that wraps `axios.create` in its own factory function, rather than calling it directly, says which factory that is through the pack config:

```json
{ "factories": [{ "module": "./src/apiClient", "export": "createApiClient" }] }
```

```
npx suss extract -f axios=config.json ...
```

Every site that imports `createApiClient` from `./src/apiClient` and calls it is then a client instance in the same way the result of `axios.create()` is, however the importing file spells the path to it (`../apiClient`, `../../src/apiClient`, and so on all resolve to the same configured module).

A bare package name (`{ "module": "some-axios-wrapper", "export": "createClient" }`) is matched by that name directly, with the same cheap check `axios` itself uses, so files that never mention it are skipped before anything is parsed. A module written as a path has no such gate: resolving a relative path needs a parsed project, not a file's own import text alone, so every file is walked instead. A project that configures several path-shaped factories pays that cost once for the whole run, not once per factory.

### Limitations (v0)

- **Bare-call form not supported.** `axios({ url, method })` and `axios.request(config)` aren't matched, and only the per-verb method calls are.
- **Aliased default imports calling axios directly are not recognized in the same file.** `import ax from "axios"; ax.get(...)` in one file isn't matched, because for that form the pack matches the conventional `import axios from "axios"`. An aliased default import that feeds `axios.create(...)` resolves fine, wherever the resulting instance ends up being called from. The alias only matters for the bare call, the one with no `.create()`.
- **Wrapper delegation is single-hop.** A wrapper method whose body forwards to another wrapper, rather than straight to a resolved instance, isn't followed through the second hop.
- **A subject the resolution chain can't follow produces nothing.** A client instance passed through a parameter, built behind a conditional, or otherwise not traceable back to an `axios.create()` (or configured factory) call produces no boundary at all, rather than a guessed one.

## Where it fits in suss

This package depends only on `@suss/extractor` (for the `PatternPack` type). It contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-axios.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
