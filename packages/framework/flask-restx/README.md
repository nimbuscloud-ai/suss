# @suss/framework-flask-restx

Framework pack for [flask-restx](https://flask-restx.readthedocs.io/) `Resource` routes, read by the Python adapter.

## What this package is

`@suss/framework-flask-restx` returns a `PythonPack` object describing:

- **Discovery**: a `Resource` class decorated with `Namespace.route(path)` (or `Api.route(path)`), directly or through a project's own wrapper module re-exporting the decorator. Each HTTP-verb-named method declared on the class (`get`, `post`, `put`, `delete`, `patch`, `head`, `options`) becomes its own discovered route.
- **Boundary bindings**: `rest(method, path)`, built from the method's own name and the path the route is served at.

## Namespace paths

A resource declared on a namespace is served under the namespace's own path, and its decorator states only the part after it. The pack composes the two, so `Namespace(path="/orders")` with `@ns.route("/<int:order_id>")` is read as `/orders/{order_id}`, and `@ns.route("")` is read as `/orders`. Parameters named in the namespace's path are read as path parameters like any other.

The composition needs the namespace constructed with a literal `path` and mounted once, through a variable, by an `add_namespace` call that states no `path` of its own. A route on a namespace written any other way is still discovered, under its name, with no path and a recorded reason: it pairs with nothing rather than with whatever a guessed path would have named.

## Where it sits in suss

Depends only on `@suss/adapter-python` (for the `PythonPack` type and the Python-language extraction pipeline). Contains no analysis logic of its own.

## The wrapper-module option

Most services wrap flask-restx's route decorator in their own module rather than importing it directly. `wrapperModules` names the wrapper a project uses, alongside flask-restx's own module, which is always accepted:

```ts
import { flaskRestxFramework } from "@suss/framework-flask-restx";

const pack = flaskRestxFramework({ wrapperModules: ["myapp.wrappers.restx"] });
```

## Coverage

![coverage](../../../.github/badges/coverage-flask-restx.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
