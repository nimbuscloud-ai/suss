# @suss/client-axios

Client pack for the [axios](https://axios-http.com/) HTTP client. It finds `axios.<method>(url, ...)` call sites and produces client summaries.

## What this package is

`@suss/client-axios` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: calls to `get`, `post`, `put`, `delete`, `patch`, `head` and `options` with a URL, where `axios` is the default import from `"axios"`. The call can be on the `axios` import itself, on a variable built by `axios.create(...)`, or on a name imported from wherever that variable was declared. A request written as one config object is read the same way, whether as `axios({ url, method })`, as `api({ url })` on an instance, or as `axios.request(config)`.
- **Binding extraction**: the HTTP method comes from the method called, or from the `method` property of a config object (GET when there is none). The URL path comes from the first argument, or from the `url` property of a config object, under the `baseURL` of the instance the call is made on. The argument is evaluated, so a name, a concatenation, or a spread from an object the evaluator can follow all come out with a path.
- **Terminals**: `returnStatement` and `throwExpression`.
- **Response semantics**: `response.data` → body, `response.status` → status code, `response.headers` → headers.

axios is a third-party HTTP client used at the call sites of a consumer, so this is a client pack. It plays the same role for axios that `@suss/client-web` plays for native `fetch`.

### Cross-file instances and wrappers

Most production code builds one `axios.create({...})` instance in a shared module and calls it wherever a request is made, often from a different file:

```ts
// client.ts
export const api = axios.create({ baseURL: "/api" });

// users.ts
import { api } from "./client";
export async function getUser(id: string) {
  return api.get(`/users/${id}`);
}
```

`getUser` is discovered as a client boundary at `GET /api/users/{id}`, the same as if `api` had been built in that file. The path comes from its own call site, and the instance's `baseURL` goes in front of it. On the provider side, a spec's `servers[0].url` already goes in front of the routes it declares, and the two sides only pair when both are read the same way. An absolute base keeps only its path, so `https://petstore3.swagger.io/api/v3` gives `/api/v3`. A base of `/` adds nothing. A base computed at run time leaves the path as the call site wrote it, so the pack does not guess. The import can also come through a barrel that re-exports the instance, and resolution follows that chain back to where the instance was constructed.

A wrapper written by hand around the instance works too, as long as it is a single method or function whose body passes its own path argument directly into one call on a resolved instance:

```ts
class Api {
  static get(route: string) {
    return api.get(route);
  }
}
```

`Api.get` is discovered as a client boundary with an unresolved path, because the path is a parameter. Each caller of `Api.get` with a literal path (`Api.get("/pet/1")`) gets its own synthesized summary, the same as with any other client wrapper.

If a project wraps `axios.create` in a factory from a package suss cannot read, declare the factory in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-http.yaml
package: "@acme/http"
statements:
  - kind: performs-call
    system: axios
    export: createApiClient
```

Every site that imports `createApiClient` from `@acme/http` and calls it then counts as a client instance, the same as the result of `axios.create()`.

A bare package name is matched by name, with the same inexpensive check `axios` itself uses, so files that never mention it are skipped before anything is parsed. A module written as a path does not get that check. Resolving a relative path needs a parsed project, and a file's own import text is not enough, so every file is walked instead. A project that declares several factories by path pays that cost once for the whole run, and not once per factory.

The `factories` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

### Limitations (v0)

- **An aliased default import that calls axios directly is not recognized.** `import ax from "axios"; ax.get(...)` in one file does not match, because for that form the pack matches the conventional `import axios from "axios"`. An aliased default import that feeds `axios.create(...)` resolves fine, wherever the instance is called from. The alias only matters for the bare call without `.create()`.
- **Wrapper delegation is single-hop.** When a wrapper method's body forwards to another wrapper, and not directly to a resolved instance, the pack does not follow the second hop.
- **A client the resolution chain cannot follow produces nothing.** A client instance passed through a parameter, built behind a conditional, or otherwise not traceable to an `axios.create()` call (or a configured factory) does not produce a boundary at all, so the pack never records a guessed one.

## Where it fits in suss

This package depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-axios.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
