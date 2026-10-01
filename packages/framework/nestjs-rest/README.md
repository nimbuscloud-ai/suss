# @suss/framework-nestjs-rest

Framework pack for [NestJS](https://nestjs.com/) REST controllers built on `@nestjs/common`. It finds routes by their decorators. NestJS wires routing internally, so user code has no `app.get(...)` call for a registration pattern like the Express or Fastify pack's to find.

```ts
@Controller("orders")
export class OrdersController {
  @Get(":id")
  find(@Param("id") id: string) {
    return this.orders.find(id);
  }
}
```

## What this package is

`@suss/framework-nestjs-rest` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery**: `decoratedRoute` against `@nestjs/common`, which matches a class decorated with `@Controller(pathPrefix?)` whose methods have an HTTP-verb decorator. The route joins the class decorator's first argument with the method decorator's first argument. Both are optional, so `@Controller()` mounts at the root and a bare `@Get()` matches the prefix exactly. The HTTP method comes from the decorator: `@Get` becomes `GET`, `@Post` becomes `POST`, and `@All` becomes `*`, which pairing treats as a wildcard over every method. `@Options`, `@Head`, `@Put`, `@Delete` and `@Patch` are read too.
- **Global prefix**: `app.setGlobalPrefix("api")` on the app `NestFactory.create` made puts `/api` in front of every route. The call can be in the bootstrap, or in a function the bootstrap hands the app to, in any file that imports from `@nestjs/common` or `@nestjs/core`. The prefix can be a constant or an environment variable's default. Routes in its `exclude` list keep their own path, whether an entry is a path, a path ending in a wildcard, or `{ path, method }` with a `RequestMethod` member.
- **API versions**: once `app.enableVersioning()` is called on the same app, a route serves the versions its `@Version()` states, or else its controller's `@Controller({ version })`, or else the call's `defaultVersion`. Under URI versioning, the default, each version goes in the path after the global prefix, so `version: "2"` serves `/api/v2/orders`, and `VERSION_NEUTRAL` keeps the path as written. Under header, media type or custom versioning every version shares the path, and the contract check compares no handler with a spec operation that two functions serve. With no `enableVersioning` call and `NestFactory.create` in the run, Nest ignores the version, and so does the pack. When the versioning type or a version does not read, or the run never sees the app being made, a route that states a version claims no path and pairs with nothing.
- **Terminals**: a bare `return` becomes a response, since NestJS serializes the returned value as the body. Its status is 201 under `@Post` and 200 under every other verb, and `@HttpCode(n)` replaces either, including when it is written `@HttpCode(HttpStatus.NO_CONTENT)` or with a constant. A `throw new NotFoundException()`, or any other exception class `@nestjs/common` exports, becomes a response with the status Nest sends for that class. Any other throw records the exception type and claims no status, and so does `new HttpException(body, status)`, which takes its status second. When `@nestjs/common` is not installed, the pack reads a member of its `HttpStatus` enum from a copy of the enum that ships with the pack. A throw in a service the handler calls stays on the service's summary. A method that falls off the end produces the same response as a bare `return`, so a fire-and-forget controller does not come back with an empty list of transitions.
- **Declared statuses**: `@ApiResponse({ status })`, `@ApiNotFoundResponse()` and the other response decorators `@nestjs/swagger` exports, on the method or its class, list statuses the route declares. A spec generated from them declares those statuses whether or not a path sends one, so the contract check does not report a declared status that no path produces.
- **Input mapping**: `decoratedParams`, which maps `@Body`, `@Param`, `@Query`, `@Headers`, `@Req` / `@Request`, `@Res` / `@Response`, `@Next`, `@Session`, `@Ip`, `@HostParam`, `@UploadedFile` and `@UploadedFiles` to their roles.

## Options

If a controller's class decorator is not called `@Controller` at the call site, declare it in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-http-kit.yaml
package: "@acme/http-kit"
statements:
  - kind: composes-decorator
    export: ApiController
    composes: { module: "@nestjs/common", name: Controller }
```

A wrapper written inside the project needs no statement. The adapter resolves a class decorator to the function behind it, and accepts that function when its body calls `Controller` from `@nestjs/common`. A stub is for a wrapper whose body is outside the project, where there is nothing to read. suss tries the framework's own `Controller` first, then the stubbed decorators in order, and the first match wins.

The `classDecorators` pack option did the same job until 0.21.0 removed it. A config file that sets it now stops the run and points here.

## Not covered yet

- Field-level decorator arguments. `@Param('id')` and `@Query('search')` land as a single `pathParams` or `queryParams` Input whatever the field name is. That is enough for the binding identity, but checking types per argument would need fuller parsing of decorator arguments.
- A global prefix per app. suss applies the prefix to every controller in the run when all the `setGlobalPrefix` calls it finds agree, and applies none when they differ. So two Nest apps with different prefixes in one run get no prefix, and an app with no prefix beside one with a prefix gets it too.
- An `exclude` entry written some other way than above: it is dropped, and that route gets the prefix.
- A version chosen by a header, for pairing with a client. Every version of such a route has the same path, so a client pairs with each of them.
- A status set on the response object, as in `@Res({ passthrough: true }) res` with `res.status(200)`. An `@HttpCode` argument that does not read as a number falls back to the verb's status.
- NestJS-style path globs (`*` and `(.*)`). The joined path goes through unchanged.
- Class inheritance and mixins. A controller split across an abstract base and a concrete child is discovered as two units, and pairing does not merge them.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-nestjs-rest.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
