# @suss/client-axios

Client pack for the [axios](https://axios-http.com/) HTTP client. Discovers `axios.<method>(url, ...)` call sites and produces client behavioral summaries.

## What this package is

`@suss/client-axios` returns a `PatternPack` object describing:

- **Discovery** via `axios.get/post/put/delete/patch/head/options(url, ...)` call sites where `axios` is imported as the default export from `"axios"`, whether the call sits on the `axios` import itself, on a variable built by `axios.create(...)`, or on a name imported from wherever that variable was declared
- **Binding extraction**: HTTP method from the called method name; URL path from the first argument (literal strings only)
- **Terminals**: `returnStatement` and `throwExpression`
- **Response semantics**: `response.data` → body, `response.status` → status code, `response.headers` → headers

This is a "client pack": axios is a third-party HTTP client used at consumer call sites, the same role as `@suss/client-web` for native `fetch`.

### Cross-file instances and wrappers

The dominant production shape builds one `axios.create({...})` instance in a shared module and calls it from wherever a request is made, often a different file than the one that built it:

```ts
// client.ts
export const api = axios.create({ baseURL: "/api" });

// users.ts
import { api } from "./client";
export async function getUser(id: string) {
  return api.get(`/users/${id}`);
}
```

`getUser` is discovered as a client boundary with the path extracted from its own call site, the same as if `api` had been built right there. The import can also arrive through a barrel that re-exports the instance; resolution follows the chain to the construction. A hand-written wrapper around the instance composes too, as long as the wrapper is a single method or function whose body forwards its own path argument straight into one call on a resolved instance:

```ts
class Api {
  static get(route: string) {
    return api.get(route);
  }
}
```

`Api.get` is discovered as a client boundary whose path is unresolved (a parameter, not a literal); every caller of `Api.get` with a literal path (`Api.get("/pet/1")`) gets its own synthesized summary, the way any wrapper-shaped client already does.

A project that wraps `axios.create` in its own factory function, rather than calling it directly, names that factory through pack config:

```json
{ "factories": [{ "module": "./src/apiClient", "export": "createApiClient" }] }
```

```
npx suss extract -f axios=config.json ...
```

Every site that imports `createApiClient` from `./src/apiClient` and calls it is then a client instance the same way an `axios.create()` result is, however that importing file spells the path to it (`../apiClient`, `../../src/apiClient`, and so on all resolve to the same configured module).

A bare package name (`{ "module": "some-axios-wrapper", "export": "createClient" }`) is matched by that name directly, the same cheap check `axios` itself uses, so files that don't touch it are skipped before anything is parsed. A path-shaped module carries no such gate: resolving a relative path needs a parsed project, not a file's own import text alone, so every file is walked instead. A project naming several path-shaped factories pays that cost once for the whole run, not per factory.

### Limitations (v0)

- **Bare-call form not supported.** `axios({ url, method })` and `axios.request(config)` aren't matched; only the per-verb method calls are.
- **Aliased default imports calling axios directly are not recognized in the same file.** `import ax from "axios"; ax.get(...)` in one file isn't matched; the pack matches the conventional `import axios from "axios"` for that shape. An aliased default import feeding `axios.create(...)` resolves fine, wherever the resulting instance ends up being called from: the alias only matters for the bare, no-`.create()` call.
- **Wrapper delegation is single-hop.** A wrapper method whose body forwards to another wrapper, rather than straight to a resolved instance, isn't followed through the second hop.
- **A subject the resolution chain can't follow composes nothing.** A client instance passed through a parameter, built behind a conditional, or otherwise not traceable back to an `axios.create()` (or configured factory) call produces no boundary, rather than a guessed one.

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-axios.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
