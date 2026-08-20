# @suss/contract-openapi

Generate suss `BehavioralSummary[]` from an [OpenAPI 3.x](https://swagger.io/specification/) specification. Lets you check TypeScript consumers against a published API contract, or your own provider against a contract you publish, without having extracted summaries from the provider's source code.

## What this package is

`@suss/contract-openapi` reads an OpenAPI document and emits one `BehavioralSummary` per operation. Each summary has:

- A `kind: "handler"` provider-side form
- `boundaryBinding: { protocol: "http", method, path, framework: "openapi" }`: pairs with extracted handlers/clients via the checker's path normalization (`:id` ↔ `{id}`)
- One transition per declared response status, with body shapes converted from OpenAPI Schema → suss `TypeShape`
- `confidence: { source: "derived", level: "high" }`: declared rather than inferred

The summaries plug into `suss check` exactly like extracted ones.

## Minimal usage

```ts
import { openApiFileToSummaries } from "@suss/contract-openapi";
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
import { openApiToSummaries } from "@suss/contract-openapi";
import type { OpenApiSpec } from "@suss/contract-openapi";

const spec: OpenApiSpec = { openapi: "3.0.3", paths: { /* ... */ } };
const summaries = openApiToSummaries(spec);
```

## What's covered

- All standard HTTP methods on `paths.<path>.<method>`
- Numeric status codes (`"200"`, `"404"`, etc.), range codes (`"2XX"` through `"5XX"`), and `default`
- Response body schemas under `content.<media-type>.schema` (the JSON one when the operation offers it, otherwise the media types in sorted order)
- Path, query, header, and cookie parameters mapped to `Input.role`
- Request body schemas mapped to a single `requestBody` input
- `$ref` to `#/components/schemas/<Name>` with cycle protection (recursive schemas resolve to a `{ type: "ref", name }` placeholder)
- Schema features: `object`/`array`/`string`/`integer`/`number`/`boolean`, `enum`, `oneOf`/`anyOf`, `allOf` (object merge), `nullable`, `additionalProperties` (as `dictionary`)

## Range codes and `default`

A document may declare a response as `"4XX"` rather than as one code. That entry promises the operation can return some status between 400 and 499, without saying which. The reader keeps that meaning in two places: the transition for the entry has `statusCode: null` with the range under `metadata.http.statusRange`, and the declared contract records it under `responseRanges`. The checker treats a consumer branch on any member of the range (a branch on 404 against a declared `4XX`) as agreeing with the contract, and asks whether the consumer covers the range at all, not whether it covers every member.

`default` in OpenAPI documents every status the other entries leave out. It becomes the summary's `isDefault` transition and the contract's `defaultResponse`, and the checker reads it as "the provider may return any status", so no consumer status is ever undeclared or dead against an operation with a `default`. The checker does not ask the consumer to cover the default bucket: the bucket has no concrete status to state an outcome about, and requiring a catch-all would be a style claim rather than a behavioral one.

## Limitations (v0)

- **Headers, links, callbacks, webhooks** sections are not modeled.
- **Security schemes** are not represented as transitions (no synthetic 401/403).
- **Multiple content types** per response: one media type gives the body shape, and which one it was is not recorded, so a producer and a consumer are never compared on the media type itself. #387 tracks that.
- **Polymorphism via `discriminator`** is not modeled (the union shape is correct, but the discriminator field isn't called out).
- **Spec validation is not strict**; invalid specs may produce odd summaries rather than errors.

## Where it fits in suss

Depends only on `@suss/behavioral-ir` (for the IR types it produces) and `yaml` (for spec parsing). It is independent of the language adapter and pattern packs; it doesn't extract from source.

## Coverage

![coverage](../../../.github/badges/coverage-contract-openapi.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md).
