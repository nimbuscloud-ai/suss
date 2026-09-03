# @suss/framework-fastapi

Framework pack for [FastAPI](https://fastapi.tiangolo.com/) routes, read by the Python adapter.

## What this package is

`@suss/framework-fastapi` returns a `PythonPack` object describing:

- **Discovery**: a function decorated with a verb-named method on the app or on a router (`@app.get(path)`, `@router.post(path)`), where the decorator's own attribute name is the HTTP verb (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`). The app and router are recognized by construction: `app = FastAPI()`, `router = APIRouter()`, one assignment back from an import of `fastapi`.
- **Router prefix composition**: a route on a router composes its path from the router's own `prefix` and the `prefix` at the single `app.include_router(...)` call that mounts it, when both are string literals and the mount reaches the router through one variable binding (same file, or imported from the file that constructed it). Beyond that, the pack abstains: it still discovers the route by name, with no path, and the summary's gap says why.
- **Boundary bindings**: `rest(method, path)`, with the declared `response_model` / `status_code` keywords and parameter / return annotations read as the route's contract.

## Where it fits in suss

Depends only on `@suss/adapter-python` (for the `PythonPack` type and the Python-language extraction pipeline). Contains no analysis logic of its own.

## What abstains

The pack never guesses a path. A route keeps its name and has no path when:

- the decorator's path argument is not a string literal,
- the router's own `prefix` or the mount call's `prefix` is not a string literal,
- nothing mounts the router through a single variable binding in the files read,
- the router is mounted more than once,
- the router is mounted onto another router (a second hop), or
- the router's variable name is assigned a second router construction (routes bind at decoration time, so which construction a decorator or mount saw depends on the order things run in, and the pack does not follow that).

Dependencies, middleware, and mounted sub-apps are not read in v0.

## A module that re-exports FastAPI

A project that re-exports FastAPI's constructors from its own module says so in a dependency stub under `suss/stubs/`, and the pack accepts that module alongside `fastapi`, which is always accepted:

```yaml
# suss/stubs/myapp-compat.yaml
package: myapp.compat
statements:
  - kind: re-exports
    of: fastapi
```

`package` is the exact module a file in the project imports from, and the decorator match is exact per module, so a project with two wrapper modules needs two stubs. `suss infer stub myapp` reads the project's own imports and drafts one stub per wrapper it finds, guessing `of: fastapi` when the imported names are all ones the library exports.

The `wrapperModules` pack option said the same thing until 0.21.0 removed it. A config file setting it now stops the run and points here.

## Coverage

![coverage](../../../.github/badges/coverage-fastapi.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
