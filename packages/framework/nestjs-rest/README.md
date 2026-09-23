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
- **Terminals**: a bare `return` becomes a response with a default status of 200, since NestJS serializes the returned value as the body. A `throw` records the exception type, so the contract check can pair it with the status the framework would send on the wire. A method that falls off the end also produces a 200 response, so a fire-and-forget controller does not come back with an empty list of transitions.
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
- `@HttpCode(N)`, which is only metadata today, so the default status stays 200.
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
