# @suss/contract-openapi

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from an [OpenAPI 3.x](https://swagger.io/specification/) specification. With it you can check TypeScript consumers against a published API contract, or check your own provider against a contract you publish, without extracting summaries from the provider's source code.

## What this package is

`@suss/contract-openapi` reads an OpenAPI document and produces one `BehavioralSummary` per operation. Each summary has:

- A `kind: "handler"` provider-side form.
- `boundaryBinding: { protocol: "http", method, path, framework: "openapi" }`, which pairs with extracted handlers and clients through the checker's path normalization (`:id` ↔ `{id}`).
- One transition per declared response status, with body shapes converted from OpenAPI Schema to suss `TypeShape`.
- `confidence: { source: "derived", level: "high" }`, since the behavior is declared and not inferred.

`suss check` accepts these summaries exactly as it accepts extracted ones.

## Minimal usage

```ts
import { openApiFileToSummaries } from "@suss/contract-openapi";
import fs from "node:fs";

const summaries = openApiFileToSummaries("openapi.yaml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

Then pair it with a consumer extracted from your TS code:

```sh
suss check provider.json consumer.json
```

Or from code:

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

A document can declare a response as `"4XX"` instead of one code. That entry means the operation can return some status between 400 and 499, without saying which. The reader keeps that meaning in two places. The entry's transition has `statusCode: null`, with the range under `metadata.http.statusRange`, and the declared contract records it under `responseRanges`. The checker treats a consumer branch on any status in the range (a branch on 404 against a declared `4XX`) as agreeing with the contract. It asks whether the consumer covers the range at all, and does not require it to cover every status in it.

In OpenAPI, `default` covers every status the other entries leave out. It becomes the summary's `isDefault` transition and the contract's `defaultResponse`. The checker reads it as "the provider may return any status", so against an operation with a `default`, no consumer status is ever undeclared or dead. The checker does not ask the consumer to handle the default case either. That case has no concrete status to state an outcome for, and requiring a catch-all would be a rule about style, with no behavior behind it.

## Limitations (v0)

- **Headers, links, callbacks and webhooks** sections are not modeled.
- **Security schemes** do not become transitions, so there is no synthetic 401/403.
- **Multiple content types** per response: one media type gives the body shape, and the reader does not record which one. So a producer and a consumer are never compared on the media type itself. #387 tracks that.
- **Polymorphism through `discriminator`** is not modeled. The union shape is correct, but the discriminator field is not marked.
- **Spec validation is not strict.** An invalid spec may produce odd summaries instead of errors.

## Where it fits in suss

The package depends only on `@suss/behavioral-ir`, for the IR types it produces, and `yaml`, for parsing the spec. It does not use the language adapter or pattern packs, since it does not extract from source.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-openapi.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md).
