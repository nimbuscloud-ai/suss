# @suss/framework-flask-restx

Framework pack for [flask-restx](https://flask-restx.readthedocs.io/) `Resource` routes, read by the Python adapter.

```python
ns = Namespace("orders", path="/orders")

@ns.route("/<int:order_id>")
class Order(Resource):
    def get(self, order_id):
        return find_order(order_id), 200
```

## What this package is

`@suss/framework-flask-restx` exports a `PythonPack`. It covers:

- **Discovery**: a `Resource` class decorated with `Namespace.route(path)` or `Api.route(path)`, either directly or through a wrapper module of the project's own that re-exports the decorator. Each method on the class named after an HTTP verb (`get`, `post`, `put`, `delete`, `patch`, `head`, `options`) becomes its own route.
- **Boundary bindings**: `rest(method, path)`, built from the method's name and the path the route is served at.
- **Transitions**: one for each place the method ends. `return body, 201` responds with the status in the tuple. `abort(404)` responds with 404, since Flask raises inside that call and never returns to the method. The pack lists `abort` under the flask-restx, Flask and Werkzeug modules, so a method matches whichever of the three it imports from.
- **Wrappers** around the resources. A function decorated with `@app.before_request` runs first, and Flask sends its return value unless it returns `None`, in which case the resource runs. A function decorated with `@app.errorhandler(SomeError)`, `@api.errorhandler(SomeError)` or `@ns.errorhandler(SomeError)` runs only for a request that raised. The app's and the API's wrappers cover every resource, and a namespace's cover the resources decorated on it. Each becomes a summary of its own, and every resource it covers points at it. A blueprint's own `before_request` is not read. The Python adapter's README explains how each is read.

## Namespace paths

A resource declared on a namespace is served under the namespace's own path, and its decorator gives only the part after it. The pack joins the two, so `Namespace(path="/orders")` with `@ns.route("/<int:order_id>")` comes out as `/orders/{order_id}`, and `@ns.route("")` comes out as `/orders`. A parameter written into the namespace's path becomes a path parameter like any other.

The join only works when the namespace is constructed with a literal `path` and mounted once, through a variable, by an `add_namespace` call that sets no `path` of its own. A route on a namespace written any other way is still discovered, under its name, with no path and a recorded reason. It does not pair with anything, because a guessed path could pair it with the wrong route.

## Where it fits in suss

The pack depends only on `@suss/adapter-python`, for the `PythonPack` type and the Python extraction pipeline. It has no analysis logic of its own.

## A module that re-exports flask-restx

Most services wrap flask-restx's route decorator in a module of their own instead of importing it directly. A dependency stub under `suss/stubs/` tells suss which wrapper a project uses. flask-restx's own module is always accepted as well.

```yaml
# suss/stubs/restx-wrapper.yaml
package: myapp.wrappers.restx
statements:
  - kind: re-exports
    of: flask_restx
```

`package` is the exact module a file in the project imports from, and suss matches the decorator against each module exactly, so a project with two wrapper modules needs two stubs. `suss infer stub myapp` reads the project's own imports and drafts one stub per wrapper it finds. It guesses `of: flask_restx` when every imported name is one the library exports.

The `wrapperModules` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## Coverage

![coverage](../../../.github/badges/coverage-flask-restx.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
