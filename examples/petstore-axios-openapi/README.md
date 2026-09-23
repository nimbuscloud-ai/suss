# Example: axios consumer ↔ Petstore OpenAPI

A complete example you can run from start to finish. A small TypeScript axios client calls a handful of Petstore endpoints, and an OpenAPI 3.0 spec describes the Petstore API. `suss` extracts the consumer's summary, derives a provider summary from the OpenAPI document, and reports where the two sides of each boundary disagree.

The consumer is written on purpose to cover every pattern that came up when suss was tested on production code: `axios.create()` instances with a `baseURL`, destructured responses, template-literal paths, `try`/`catch` with `err.response.status`, a thin wrapper that passes the path through, and reads of fields the spec declares optional.

## Run it

From this directory:

```sh
make all
```

`make all` runs three steps in order:

1. `make extract` runs `suss extract -p tsconfig.json -f axios -o out/consumer.json`
2. `make contract` runs `suss contract --from openapi openapi.json -o out/provider.json`
3. `make check` runs `suss check --dir out/ --fail-on warning`. It exits non-zero on purpose, because of the warnings this consumer's bugs produce, so a CI pipeline fails on a regression.

Or print each side in a form meant for reading:

```sh
make inspect-consumer
make inspect-provider
```

## What you should see

The `check` step compares two boundaries, `GET /api/v3/pet/{petId}` and `GET /api/v3/pet/findByStatus`, and produces 16 findings: 12 warnings and 4 info. Below is what each one means and which line of the consumer caused it.

Both boundaries have the `/api/v3` prefix. The spec's `servers[0].url` is `https://petstore3.swagger.io/api/v3`, so the provider's routes are read under `/api/v3`. Both `axios.create` calls in this project set the same `baseURL`, so the consumer's paths are too. If one side had the prefix and the other did not, the run would pair nothing and exit non-zero with `nothingPaired`.

### Warnings: provider produces a status the consumer doesn't handle

These are bugs in the consumer, reported as `unhandledProviderCase` at warning severity. Whether an uncovered status is a bug depends on intent the code does not state, which is why the run only fails on them with `--fail-on warning`. Petstore declares 200, 400 and 404 for `GET /api/v3/pet/{petId}`, and 200 and 400 for `findByStatus`. The consumer ignores 400 everywhere, and ignores 404 in two places.

| Consumer | Endpoint | Missed status | Why |
|----------|----------|---------------|-----|
| `getPetById` (line 23)  | `GET /api/v3/pet/{petId}`        | 400 | branches on `status === 404` only |
| `describePet` (line 66) | `GET /api/v3/pet/{petId}`        | 400 + 404 | no status handling at all, assumes 200 |
| `listPets` (line 48)    | `GET /api/v3/pet/findByStatus`   | 400 | wrapper-callsite (via `getJson`), no status handling |
| `describePetViaWrapper` (line 58) | `GET /api/v3/pet/{petId}` | 400 + 404 | wrapper-callsite, no status handling |

`safeGetPet` (line 33) catches failures through `err.response?.status`. A catch on a client that throws counts as handling the status, so it reports nothing.

`listPets` does not call axios directly. It calls `getJson()` from `api-client.ts`, which passes `path` on to `axios.get`. `suss` follows references to wrapper functions and builds a summary for each caller, so the call site can still be paired.

### Warnings: the same gaps, from the contract's side

Each unhandled status above is also reported as a `consumerContractViolation` at warning severity ("Contract declares response 400 but consumer does not handle it"). The first finding comes from pairing the two summaries, and the second from checking the consumer directly against the declared OpenAPI contract. Adding the missing branch to the consumer clears both.

### Info: consumer reads a field the provider declares optional

Petstore's `Pet` schema only lists `name` and `photoUrls` as required. `id` and `status` are optional, so the spec allows a response without them, and the consumer assumes without checking that they will be there.

| Consumer | Field | Notes |
|----------|-------|-------|
| `describePet`           | `id`     | Read as `data.id` after `axios.get` |
| `describePet`           | `status` | Read as `data.status` after `axios.get` |
| `describePetViaWrapper` | `id`     | Read as `pet.id` on the wrapper return value |
| `describePetViaWrapper` | `status` | Read as `pet.status` on the wrapper return value |

The two `describePetViaWrapper` findings go through the whole wrapper-expansion pipeline. `getJson` already unwrapped the response inside `api-client.ts`, so reads on its return value are body fields, and the same rule for optional fields fires.

The finding is at `info` severity, so it does not fail CI by default. It shows where the consumer depends on something the provider does not guarantee.

### Unmatched

Run `make check` with `--all`, and the output lists the 17 Petstore operations the consumer does not use, such as `PUT /api/v3/pet`, `POST /api/v3/pet`, `DELETE /api/v3/pet/{petId}`, and all the `/api/v3/store/*` and `/api/v3/user/*` endpoints. It also lists `getJson` under "nothing in this run paired with this boundary", as `GET ?`. The wrapper passes a parameter through, so it has no route of its own, and its callers are what get checked.

## What this example shows

- **`axios.create()` instances**: `api.get(...)` is matched the same way as `axios.get(...)`.
- **Base URLs on both sides**: the instance's `baseURL` and the spec's `servers[0].url` both become the `/api/v3` prefix, so both sides write the route the same way.
- **Destructured response**: `const { data, status } = await api.get(...)` has its fields tracked correctly, and the status check is recognised.
- **Template-literal paths**: `` `/pet/${petId}` `` becomes `/pet/{petId}`, which pairs with the OpenAPI placeholder syntax through the checker's path normaliser.
- **`try`/`catch` with `err.response.status`**: the status check in the catch block is recognised, even though the response variable is in a different scope.
- **Wrappers that pass the path through**: `getJson(path)` is detected as a wrapper, and suss builds a summary for each caller, so the wrapper's call sites pair with providers.
- **Optional fields**: OpenAPI properties that are not `required` become `union<T, undefined>`, and consumers that read them get info-level findings.

If you change the consumer, for example by adding a 400 branch to `getPetById`, running `make check` again should remove the matching finding. So the example also works as a regression test for the checker.
