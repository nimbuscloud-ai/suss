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

- **Discovery**: a function decorated with a method on the app or on a router, such as `@app.get(path)` or `@router.post(path)`, where the decorator's attribute name is the HTTP verb (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`). `@app.api_route(path, methods=["GET", "POST"])` serves each method in its `methods` list, and GET when it passes none, as FastAPI does. The pack recognizes the app and the router by how they are built: `app = FastAPI()` and `router = APIRouter()`, from an import of `fastapi`, or `fastapi.FastAPI()` after `import fastapi`.
- **Router prefixes**: the pack declares FastAPI's app and routers as a route table. A route on a router gets its path from the `prefix` on each `include_router(...)` call on the way from the app and each router's own `prefix`, through as many routers mounted onto one another as the project writes, in any file. A router mounted twice serves its routes under each mount. In any case the table cannot follow, the pack still discovers the route by name, with no path, and the summary's gap says why.
- **Boundary bindings**: `rest(method, path)`. The `response_model` and `status_code` keywords and the parameter and return annotations are read as the route's contract.
- **Where a parameter comes from**: `Header()`, `Query()`, `Path()`, `Body()`, `Form()` and `Cookie()` say which part of the request a parameter is, and `alias=` which field. A header parameter's underscores become hyphens, as FastAPI sends them, so an intent writes `x_tenant_id: str = Header()` as `input.headers.x-tenant-id`. A parameter defaulted to `Depends(f)` or `Security(f)`, or annotated with a class FastAPI supplies (`Request`, `Response`, `BackgroundTasks`, `WebSocket`, `SecurityScopes`), comes from FastAPI and not from the request.
- **Transitions**: one for each place the handler ends, which means each return and each `HTTPException` it raises. FastAPI sends the raised status, whatever the decorator declares, so a route that raises 404 on one branch and returns on the other comes out as a 404 and a 200, each under the condition that leads to it. The pack lists `HTTPException` under both the module FastAPI exports it from and the Starlette module FastAPI takes it from, so either import matches. When a handler returns a `Response` or `JSONResponse` with a `status_code`, the route responds with that status. A status written as `status.HTTP_404_NOT_FOUND`, from `fastapi` or `starlette`, reads as its number without either installed, because the pack lists Starlette's constants. A `raise` of a name assigned `HTTPException(...)` elsewhere reads the status that call was built with. The keys of a `responses=` dictionary on the route, its router, a mount above it or the app are recorded as statuses the code declares. A spec FastAPI generates lists those statuses for that reason alone, so the check does not ask a path to produce them. A body that runs off its end sends the declared status, the same as a bare `return`. A route that reads any parameter off the request also gets a 422 transition, because FastAPI validates those parameters before the handler runs and sends 422 itself when one does not parse.
- **Wrappers** around the routes. A dependency (`Depends(f)` or `Security(f)` from `fastapi`) counts when it is in the app's or a router's `dependencies=[...]`, in an `include_router(...)` call's, in the decorator's, or a parameter default. A function decorated with `@app.middleware("http")` counts too, and its `call_next` call is where the request goes on to the route. So does one decorated with `@app.exception_handler(SomeError)`, which FastAPI runs only for a request that raised. Each becomes a summary of its own, which is where its 401 or its 500 is recorded, and every route it covers points at it. The Python adapter's DESIGN.md explains how each is read and what is not, such as a middleware added as a class or one decorated on an app another file builds.
- **What serves requests beside the routes**, which `suss check` needs before it reports a call to a path no route serves. The pack states the OpenAPI document and the docs pages the app serves, at the paths `openapi_url`, `docs_url`, `redoc_url` and `swagger_ui_oauth2_redirect_url` give, everything under a path `mount` puts a static file server or another app at, a route added with `add_api_route`, `add_route` or Starlette's `route`, middleware added with `add_middleware`, and an error handler added with `add_exception_handler` for 404 or `HTTPException`. Starlette's CORS middleware covers `OPTIONS` only, and its GZip, trusted host, HTTPS redirect and session middleware cover nothing. A route added on a router, middleware the library does not ship, and a `routes`, `middleware` or `exception_handlers` keyword on the app may serve any path.

## Where it fits in suss

The pack depends on `@suss/adapter-python`, for the `PythonPack` type and the Python extraction pipeline, on `@suss/extractor` for the route table's types, and on `@suss/recognize` for the origins and the dependency callbacks it declares. It has no analysis logic of its own: `@suss/recognize` composes the table.

## When a route has no path

The decorator's path argument and both prefixes go through the value evaluator. A name, two strings joined with `+`, or an f-string over a name the evaluator can settle all come out as the path they produce. An f-string writes a literal brace by doubling it, so `@app.get(f"/v1/{{id}}")` comes out as `/v1/{id}`, which is the path FastAPI serves. If the evaluator cannot settle a placeholder in the path argument, it stays in the path as a hole, the same way a path parameter is written.

The pack never guesses a path. A route keeps its name and has no path when:

- the decorator's path argument does not come out as a string,
- a router's own `prefix` or a mount call's `prefix` on the way from the app does not settle on one string,
- nothing mounts the router, or a loop the pack cannot list may be what mounts it,
- a mount on the way is inside a function, while a loop elsewhere the pack cannot list may mount routers in its place,
- the router is mounted onto a router nothing mounts, or routers mount each other, or
- the decorator is written on a name assigned two routers. Routes bind when the decorator runs, so which router it saw depends on the order things run in.

Mounted sub-apps are not read. `suss check` takes what `mount` puts under a path as served there.

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
