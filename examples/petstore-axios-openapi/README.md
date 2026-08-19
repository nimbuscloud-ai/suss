# Example: axios consumer ↔ Petstore OpenAPI

A complete, runnable end-to-end example. A small TypeScript axios client calls a handful of Petstore endpoints; the Petstore API is described as an OpenAPI 3.0 spec. `suss` extracts the consumer's behavioral summary, derives a provider summary from the OpenAPI document, and reports cross-boundary findings.

The consumer is deliberately written to exercise every shape that came up in real-world testing — `axios.create()` instances, destructured responses, template-literal paths, `try`/`catch` with `err.response.status`, a thin path-passthrough wrapper, and reads of fields the spec declares optional.

## Run it

From this directory:

```sh
make all
```

`make all` runs three steps in order:

1. `make extract` runs `suss extract -p tsconfig.json -f axios -o out/consumer.json`
2. `make contract` runs `suss contract --from openapi petstore-openapi.json -o out/provider.json`
3. `make check` runs `suss check --dir out/ --fail-on warning` (intentionally exits non-zero on the warnings this consumer's bugs produce, so CI pipelines fail on regressions)

Or inspect each side as a human-readable rendering:

```sh
make inspect-consumer
make inspect-provider
```

## What you should see

The `check` step produces 16 findings: 12 warnings and 4 info. Below is what each one means and which line of the consumer caused it.

### Warnings: provider produces a status the consumer doesn't handle

These are bugs in the consumer, reported as `unhandledProviderCase` at warning severity: whether an uncovered status is a defect depends on intent the code does not state, which is why the run gates on them only with `--fail-on warning`. Petstore declares 200, 400, and 404 for `GET /pet/{petId}` (and 200, 400 for `findByStatus`); the consumer ignores 400 in every shape and ignores 404 in two.

| Consumer | Endpoint | Missed status | Why |
|----------|----------|---------------|-----|
| `getPetById` (line 23)  | `GET /pet/{petId}`        | 400 | branches on `status === 404` only |
| `describePet` (line 66) | `GET /pet/{petId}`        | 400 + 404 | no status handling at all, assumes 200 |
| `listPets` (line 48)    | `GET /pet/findByStatus`   | 400 | wrapper-callsite (via `getJson`), no status handling |
| `describePetViaWrapper` (line 58) | `GET /pet/{petId}` | 400 + 404 | wrapper-callsite, no status handling |

`safeGetPet` (line 33) catches thrown failures via `err.response?.status`, and a catch on a client that throws counts as coverage, so it reports nothing.

Note that `listPets` doesn't directly call axios. It calls `getJson()` from `api-client.ts`, which forwards `path` to `axios.get`. `suss` walks references to wrapper functions and synthesises a per-caller summary so the call site is still pairable.

### Warnings: the same gaps, from the contract's side

Each unhandled status above is also reported as a `consumerContractViolation` at warning severity ("Contract declares response 400 but consumer does not handle it"). One comes from pairing the two summaries; the other comes from checking the consumer against the declared OpenAPI contract directly. Adding the missing consumer branch clears both together.

### Info — consumer reads a field the provider declares optional

Petstore's `Pet` schema lists only `name` and `photoUrls` as required. `id` and `status` are optional — meaning the spec permits a response that omits them, and the consumer is implicitly assuming they'll be present.

| Consumer | Field | Notes |
|----------|-------|-------|
| `describePet`           | `id`     | Read as `data.id` after `axios.get` |
| `describePet`           | `status` | Read as `data.status` after `axios.get` |
| `describePetViaWrapper` | `id`     | Read as `pet.id` on the wrapper return value |
| `describePetViaWrapper` | `status` | Read as `pet.status` on the wrapper return value |

The two `describePetViaWrapper` findings exercise the wrapper-expansion pipeline end-to-end: `getJson` already unwrapped the response inside `api-client.ts`, so accesses on its return value are direct body fields and the same optional-field rule fires.

The check is severity `info` — it doesn't fail CI by default, but tells you where the consumer is implicitly depending on something the provider doesn't guarantee.

### Unmatched

The output also lists every Petstore operation the consumer doesn't touch (`PUT /pet`, `POST /pet`, `DELETE /pet/{petId}`, all the `/store/*` and `/user/*` endpoints) and notes that the `getJson` wrapper itself has no boundary binding (which is correct — its callers are what get checked).

## What this example deliberately demonstrates

- **`axios.create()` instances** — `api.get(...)` is matched the same as `axios.get(...)`.
- **Destructured response** — `const { data, status } = await api.get(...)` is field-tracked correctly; the status check is recognised.
- **Template-literal paths** — `` `/pet/${petId}` `` becomes `/pet/{petId}`, which pairs with the OpenAPI placeholder syntax via the checker's path normaliser.
- **`try`/`catch` with `err.response.status`** — the catch-block status check is recognised even though the response variable lives in a different scope.
- **Path-passthrough wrappers** — `getJson(path)` is detected as a wrapper and per-caller summaries are synthesised so wrapper-callsites pair with providers.
- **Optional-field tracking** — non-`required` OpenAPI properties are wrapped in `union<T, undefined>`; consumers reading them get info-level findings.

If you change the consumer (e.g. add a 400 branch to `getPetById`), re-running `make check` should drop the corresponding finding — the example doubles as a living regression test for the cross-boundary checker.
