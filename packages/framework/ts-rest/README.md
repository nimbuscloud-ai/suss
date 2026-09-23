# @suss/framework-ts-rest

Framework pack for [ts-rest](https://ts-rest.com/). It finds ts-rest handlers and client call sites, reads what each handler returns, and reads the contract both sides are built from.

## What this package is

`@suss/framework-ts-rest` exports a `PatternPack`. The pack is data with no code of its own, and the language adapter applies its patterns to the AST. It covers:

- **Provider discovery**: `initServer().router(contract, handlers)` registration calls.
- **Client discovery**: `initClient(contract)` call sites.
- **Terminals**: `return { status, body }` object literals.
- **Contract reading**: `initContract().router(...)`, from which it reads `responses` and `pathParams`.
- **Input mapping**: the destructured `{ params, body, query, headers }`, each with its role.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type. It has no analysis logic of its own, and the adapter does all the work.

## Coverage

![coverage](../../../.github/badges/coverage-ts-rest.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
