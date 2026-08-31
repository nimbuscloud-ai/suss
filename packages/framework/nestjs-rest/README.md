# @suss/framework-nestjs-rest

Framework pack for [NestJS](https://nestjs.com/) REST controllers built on `@nestjs/common`. Discovery is decorator-driven, because NestJS wires routing internally and there is no `app.get(...)` registration call in user code for the Express and Fastify packs to find.

## What this package is

`@suss/framework-nestjs-rest` returns a `PatternPack` object describing:

- **Discovery** via `decoratedRoute` against `@nestjs/common`: a class decorated with `@Controller(pathPrefix?)` whose methods have an HTTP-verb decorator. The route is the class decorator's first argument joined with the method decorator's first argument, both optional, so `@Controller()` mounts at the root and a bare `@Get()` matches the prefix exactly. The HTTP method comes from the decorator itself, so `@Get` becomes `GET`, `@Post` becomes `POST`, and `@All` becomes `*`, which downstream pairing treats as a wildcard over every method. `@Options`, `@Head`, `@Put`, `@Delete`, and `@Patch` are read too.
- **Terminals**: a bare `return` becomes a response with a default status of 200, since NestJS serializes the returned value as the body; a `throw` records the exception type so contract-checking can pair it with the wire status the framework would emit; falling off the end of a method also produces a 200 response, so a fire-and-forget controller does not come back with an empty transition list.
- **Input mapping**: `decoratedParams`, mapping `@Body`, `@Param`, `@Query`, `@Headers`, `@Req` / `@Request`, `@Res` / `@Response`, `@Next`, `@Session`, `@Ip`, `@HostParam`, `@UploadedFile`, and `@UploadedFiles` to their roles.

## Options

A controller that does not use `@Controller` by that name at the call site is declared in a dependency stub under `suss/stubs/`:

```yaml
# suss/stubs/acme-http-kit.yaml
package: "@acme/http-kit"
statements:
  - kind: composes-decorator
    export: ApiController
    composes: { module: "@nestjs/common", name: Controller }
```

A wrapper written inside the project needs no statement, because the adapter resolves a class decorator to the function behind it and accepts that function when its body calls `Controller` from `@nestjs/common`. What a stub is for is a wrapper whose body is not in the project, so there is nothing to read. The framework's own `Controller` is tried first, then the stubbed decorators in order, and the first match wins.

The `classDecorators` pack option said the same thing until 0.21.0 removed it. A config file setting it now stops the run and points here.

## Not covered yet

- Field-level decorator arguments. `@Param('id')` and `@Query('search')` land as a single `pathParams` or `queryParams` Input regardless of the declared field name. That is enough for the binding identity, but pairing logic that wants per-argument type checking will need richer decorator-argument parsing.
- `@HttpCode(N)`, which is metadata-only today, so the default status stays 200.
- NestJS-style path globs (`*` and `(.*)`). The joined path goes through unchanged.
- Class inheritance and mixins. A controller split across an abstract base and a concrete child is discovered as two units and pairing does not collapse them.

## Where it fits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-nestjs-rest.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
