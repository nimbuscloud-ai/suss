# @suss/stub-openapi

Generate suss `BehavioralSummary[]` from an [OpenAPI 3.x](https://swagger.io/specification/) specification. Lets you check TypeScript consumers against a published API contract — or your own provider against a contract you publish — without having extracted summaries from the provider's source code.

## What this package is

`@suss/stub-openapi` reads an OpenAPI document and emits one `BehavioralSummary` per operation. Each summary carries:

- A `kind: "handler"` provider-side shape
- `boundaryBinding: { protocol: "http", method, path, framework: "openapi" }` — pairs with extracted handlers/clients via the checker's path normalization (`:id` ↔ `{id}`)
- One transition per declared response status, with body shapes converted from OpenAPI Schema → suss `TypeShape`
- `confidence: { source: "stub", level: "high" }` — declared, not inferred

The summaries plug into `suss check` exactly like extracted ones.

## Minimal usage

```ts
import { openApiFileToSummaries } from "@suss/stub-openapi";
import fs from "node:fs";

const summaries = openApiFileToSummaries("openapi.yaml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

Then pair against a consumer extracted from your TS code:

```sh
suss check provider.json consumer.json
```

Or programmatically:

```ts
import { openApiToSummaries } from "@suss/stub-openapi";
import type { OpenApiSpec } from "@suss/stub-openapi";

const spec: OpenApiSpec = { openapi: "3.0.3", paths: { /* ... */ } };
const summaries = openApiToSummaries(spec);
```

## What's covered

- All standard HTTP methods on `paths.<path>.<method>`
- Numeric status codes (`"200"`, `"404"`, etc.) and `default`
- Response body schemas under `content.<media-type>.schema` (first content type wins)
- Path, query, header, and cookie parameters mapped to `Input.role`
- Request body schemas mapped to a single `requestBody` input
- `$ref` to `#/components/schemas/<Name>` with cycle protection (recursive schemas resolve to a `{ type: "ref", name }` placeholder)
- Schema features: `object`/`array`/`string`/`integer`/`number`/`boolean`, `enum`, `oneOf`/`anyOf`, `allOf` (object merge), `nullable`, `additionalProperties` (as `dictionary`)

## Limitations (v0)

- **Range status codes** like `"2XX"` are skipped — checker pairing requires concrete status values.
- **Headers, links, callbacks, webhooks** sections are not modeled.
- **Security schemes** are not represented as transitions (no synthetic 401/403).
- **Multiple content types** per response: only the first one is used for the body shape.
- **Polymorphism via `discriminator`** is not modeled (the union shape is correct, but the discriminator field isn't called out).
- **Spec validation is not strict** — invalid specs may produce odd summaries rather than errors.

## Where it sits in suss

Depends only on `@suss/behavioral-ir` (for the IR types it produces) and `yaml` (for spec parsing). It is independent of the language adapter and pattern packs — it doesn't extract from source.

## Coverage

![coverage](../../../.github/badges/coverage-stub-openapi.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md).
