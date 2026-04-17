# @suss/framework-ts-rest

Framework pack for [ts-rest](https://ts-rest.com/). Declarative patterns describing how to find ts-rest handlers and client call sites, what terminals look like, and how to read declared contracts.

## What this package is

`@suss/framework-ts-rest` returns a `PatternPack` object — data, not code. The language adapter interprets these patterns against the AST. This pack describes:

- **Provider discovery** via `initServer().router(contract, handlers)` registration calls
- **Client discovery** via `initClient(contract)` call sites
- **Terminals**: `return { status, body }` object literals
- **Contract reading**: `initContract().router(...)` with `responses` and `pathParams` extraction
- **Input mapping**: destructured `{ params, body, query, headers }` with semantic roles

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains no analysis logic — the adapter does all the work.

## Coverage

![coverage](../../../.github/badges/coverage-ts-rest.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
