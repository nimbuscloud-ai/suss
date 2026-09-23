# @suss/framework-fastapi

Framework pack for [FastAPI](https://fastapi.tiangolo.com/) routes, read by the Python adapter.

```python
router = APIRouter(prefix="/orders")

@router.get("/{order_id}", response_model=Order)
def get_order(order_id: int):
    order = find_order(order_id)
    if order is None:
        raise HTTPException(status_code=404)
    return order

app = FastAPI()
app.include_router(router, prefix="/v1")
```

## What this package is

`@suss/framework-fastapi` exports a `PythonPack`. It covers:

- **Discovery**: a function decorated with a method on the app or on a router, such as `@app.get(path)` or `@router.post(path)`, where the decorator's attribute name is the HTTP verb (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`). The pack recognizes the app and the router by how they are built: `app = FastAPI()` and `router = APIRouter()`, one assignment back from an import of `fastapi`.
- **Router prefixes**: a route on a router gets its path from the router's own `prefix` and the `prefix` on the single `app.include_router(...)` call that mounts it. That needs both to settle on one string, and the mount has to reach the router through one variable binding, either in the same file or imported from the file that built the router. In any other case the pack still discovers the route by name, with no path, and the summary's gap says why.
- **Boundary bindings**: `rest(method, path)`. The `response_model` and `status_code` keywords and the parameter and return annotations are read as the route's contract.
- **Transitions**: one for each place the handler ends, which means each return and each `HTTPException` it raises. FastAPI sends the raised status, whatever the decorator declares, so a route that raises 404 on one branch and returns on the other comes out as a 404 and a 200, each under the condition that leads to it. The pack lists `HTTPException` under both the module FastAPI exports it from and the Starlette module FastAPI takes it from, so either import matches. When a handler returns a `Response` or `JSONResponse` with a `status_code`, the route responds with that status.
- **Wrappers** around the routes. A dependency (`Depends(f)` or `Security(f)`) counts when it is in the app's or a router's `dependencies=[...]`, in the decorator's `dependencies=[...]`, or a parameter default. A function decorated with `@app.middleware("http")` counts too, and its `call_next` call is where the request goes on to the route. So does one decorated with `@app.exception_handler(SomeError)`, which FastAPI runs only for a request that raised. Each becomes a summary of its own, which is where its 401 or its 500 is recorded, and every route it covers points at it. The Python adapter's README explains how each is read and what is not, such as a dependency on `include_router(...)` or a middleware added as a class.

## Where it fits in suss

The pack depends only on `@suss/adapter-python`, for the `PythonPack` type and the Python extraction pipeline. It has no analysis logic of its own.

## When a route has no path

The decorator's path argument and both prefixes go through the value evaluator. A name, two strings joined with `+`, or an f-string over a name the evaluator can settle all come out as the path they produce. An f-string writes a literal brace by doubling it, so `@app.get(f"/v1/{{id}}")` comes out as `/v1/{id}`, which is the path FastAPI serves. If the evaluator cannot settle a placeholder in the path argument, it stays in the path as a hole, the same way a path parameter is written.

The pack never guesses a path. A route keeps its name and has no path when:

- the decorator's path argument does not come out as a string,
- the router's own `prefix` or the mount call's `prefix` does not settle on one string,
- nothing mounts the router through a single variable binding in the files read,
- the router is mounted more than once,
- the router is mounted onto another router (a second hop), or
- the router's variable is assigned a second router construction. Routes bind when the decorator runs, so which construction a decorator or a mount saw depends on the order things run in, and the pack does not follow that.

Mounted sub-apps are not read.

## A module that re-exports FastAPI

If a project re-exports FastAPI's constructors from a module of its own, declare that module in a dependency stub under `suss/stubs/`. The pack then accepts it as well as `fastapi`, which it always accepts:

```yaml
# suss/stubs/myapp-compat.yaml
package: myapp.compat
statements:
  - kind: re-exports
    of: fastapi
```

`package` is the exact module a file in the project imports from, and suss matches the decorator against each module exactly, so a project with two wrapper modules needs two stubs. `suss infer stub myapp` reads the project's own imports and drafts one stub per wrapper it finds. It guesses `of: fastapi` when every imported name is one the library exports.

The `wrapperModules` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## Coverage

![coverage](../../../.github/badges/coverage-fastapi.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
