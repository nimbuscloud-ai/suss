# Pair your code against an OpenAPI spec

Common scenario: you consume a third-party API (Stripe, an
internal team, anything with an OpenAPI 3.x spec). You want to
know if your client code correctly handles every status the spec
declares, and flags drift when the spec changes.

## The two artifacts

```
spec.yaml / spec.json   ─── @suss/contract-openapi ───▶  stub.json
                                                        │
your client code        ─── @suss/client-axios  ───▶  client.json
                                                        │
                                                        ▼
                                       suss check stub.json client.json
```

Both produce the same `BehavioralSummary[]` shape; the checker
pairs them by `(method, normalizedPath)` without caring which side
came from code vs a spec.

## Step 1. Turn the spec into a stub

```bash
npm install -D @suss/contract-openapi
npx suss contract --from openapi stripe-openapi.yaml -o summaries/stripe.json
```

One summary per operation. Each carries:
- Method + path
- Inputs for every declared parameter (path, query, header, cookie)
  + request body
- One transition per declared response status, with the body
  `TypeShape` derived from the OpenAPI schema

Quick check it worked:

```bash
npx suss inspect summaries/stripe.json | head -30
```

## Step 2. Extract your client code

```bash
npm install -D @suss/client-axios   # or fetch, or apollo-client
npx suss extract -p tsconfig.json -f axios -o summaries/client.json
```

Each `axios.get("/v1/charges", ...)` call becomes a client-kind
summary. The axios pack recognizes both the direct forms
(`axios.get(...)`) and factory-bound forms
(`const api = axios.create({ baseURL }); api.get(...)`).

## Step 3. Pair them

```bash
npx suss check summaries/stripe.json summaries/client.json
```

Typical findings:

- **unhandledProviderCase** — Stripe's spec declares a status
  your client doesn't handle. Either add the branch, or suppress
  with a `.sussignore` entry if the path is unreachable for
  your use case.
- **deadConsumerBranch** — your client reads a status Stripe
  doesn't declare. Often drift from a copy-pasted client:
  delete the branch.
- **lowConfidence** — your client branches on something the
  analyzer can't decompose (dynamic predicate, complex chain).
  Informational; means the finding below it may be incomplete.

## Handling path mismatches

OpenAPI paths use `{id}` syntax; different clients use `:id`
(Express-style) or template literals `` `${id}` ``. The pairing
layer normalizes these — `GET /users/:id`, `GET /users/{id}`,
and `` axios.get(`/users/${id}`) `` all pair.

If pairs aren't matching, inspect what boundaries suss is seeing
on each side:

```bash
npx suss inspect --dir summaries/
```

The output groups summaries by boundary key and shows which ones
didn't match. Common root causes:

- **Base URL prefix** — your client hits `/v1/users/123` but the
  spec declares `/users/{id}` (no `/v1`). The axios pack doesn't
  strip base URLs automatically; fix by either matching the spec's
  path with a leading prefix, or by normalizing before extraction.
- **Encoded segments** — `/search/{q}` vs
  `` axios.get(`/search/${encodeURIComponent(q)}`) `` — parsed the
  same, so this isn't usually a problem.
- **Path as a parameter, not a literal** — if you do
  `axios.get(url)` where `url` is a parameter, the pack can't see
  the path. Wrapper-expansion handles one hop; deeper indirection
  doesn't pair automatically.

## Pair against a subset

Sometimes you only use a slice of a large vendor spec (you hit 5
of Stripe's 200 endpoints). Run the full pair — unmatched
provider summaries land in `unmatched.providers` and don't fail
the build. The [CI guide](/guides/ci-integration) shows the
`--fail-on error` default that makes this work without tuning.

If you want to be strict about what's *in use*, filter the
summaries file before checking:

```bash
# Keep only /v1/charges and /v1/refunds
jq '[.[] | select(.identity.boundaryBinding.semantics.path | test("^/v1/(charges|refunds)"))]' \
  summaries/stripe.json > summaries/stripe-subset.json
npx suss check summaries/stripe-subset.json summaries/client.json
```

Alternatively, commit a filter config as part of your CI setup;
the filtering is pre-check so all the check flags still apply.

## When to use this vs writing a contract test

Contract tests (Pact, dredd, openapi-validator) verify requests
and responses at runtime. They're authoritative but require
running the code. suss analyzes the code statically and cares
about *coverage* — does every declared status have a handler?
Every prop, a scenario? Every field, a resolver?

Run both if you can. They answer different questions.
