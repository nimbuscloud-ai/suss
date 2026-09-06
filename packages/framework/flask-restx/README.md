# @suss/framework-flask-restx

Framework pack for [flask-restx](https://flask-restx.readthedocs.io/) `Resource` routes, read by the Python adapter.

## What this package is

`@suss/framework-flask-restx` returns a `PythonPack` object describing:

- **Discovery**: a `Resource` class decorated with `Namespace.route(path)` (or `Api.route(path)`), directly or through a project's own wrapper module re-exporting the decorator. Each HTTP-verb-named method declared on the class (`get`, `post`, `put`, `delete`, `patch`, `head`, `options`) becomes its own discovered route.
- **Boundary bindings**: `rest(method, path)`, built from the method's own name and the path the route is served at.
- **Transitions**: one per place the method ends. A `return body, 201` responds with the status the tuple states, and an `abort(404)` responds with 404, since Flask raises inside that call and never comes back to the method. The pack lists `abort` under flask-restx's module, Flask's and Werkzeug's, so a method matches whichever of the three it imports from.
- **Wrappers** around the resources: a function decorated with `@app.before_request`, which Flask sends the return value of and goes on to the resource only where it returns `None`; and one decorated with `@app.errorhandler(SomeError)`, `@api.errorhandler(SomeError)` or `@ns.errorhandler(SomeError)`, which runs only for a request that raised. The app's and the API's cover every resource; a namespace's covers the resources decorated on it. Each becomes a summary of its own, and every resource it covers points at it. A blueprint's own `before_request` is not read. The Python adapter's README says how each is read.

## Namespace paths

A resource declared on a namespace is served under the namespace's own path, and its decorator states only the part after it. The pack composes the two, so `Namespace(path="/orders")` with `@ns.route("/<int:order_id>")` comes out as `/orders/{order_id}`, and `@ns.route("")` comes out as `/orders`. Parameters written into the namespace's path become path parameters like any other.

The composition needs the namespace constructed with a literal `path` and mounted once, through a variable, by an `add_namespace` call that states no `path` of its own. A route on a namespace written any other way is still discovered, under its name, with no path and a recorded reason: it pairs with nothing rather than with whatever route a guessed path would have picked out.

## Where it fits in suss

Depends only on `@suss/adapter-python` (for the `PythonPack` type and the Python-language extraction pipeline). Contains no analysis logic of its own.

## A module that re-exports flask-restx

Most services wrap flask-restx's route decorator in their own module rather than importing it directly. A dependency stub under `suss/stubs/` says which wrapper a project uses, alongside flask-restx's own module, which is always accepted:

```yaml
# suss/stubs/restx-wrapper.yaml
package: myapp.wrappers.restx
statements:
  - kind: re-exports
    of: flask_restx
```

`package` is the exact module a file in the project imports from, and the decorator match is exact per module, so a project with two wrapper modules needs two stubs. `suss infer stub myapp` reads the project's own imports and drafts one stub per wrapper it finds, guessing `of: flask_restx` when the imported names are all ones the library exports.

The `wrapperModules` pack option said the same thing until 0.21.0 removed it. A config file setting it now stops the run and points here.

## Coverage

![coverage](../../../.github/badges/coverage-flask-restx.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
