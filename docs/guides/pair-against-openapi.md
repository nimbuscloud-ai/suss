# Pair your code against an OpenAPI spec

Common scenario: you consume a third-party API (Stripe, an
internal team, anything with an OpenAPI 3.x spec). You want to
know if your client code correctly handles every status the spec
declares, and flags drift when the spec changes.

## The two artifacts

<svg class="suss-diagram" viewBox="0 0 660 268" role="img" aria-labelledby="openapi-title openapi-desc">
  <title id="openapi-title">A vendor's spec and your code, read into the same shape</title>
  <desc id="openapi-desc">The vendor's OpenAPI file goes through the OpenAPI contract reader, and your client code goes through the axios pack. Both produce summary files in the same format, which suss check compares against each other.</desc>

  <defs>
    <marker id="openapi-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="axis" x="95" y="16" text-anchor="middle">Theirs</text>
  <rect class="box" x="10" y="26" width="170" height="42" rx="6" />
  <text class="label-mono" x="95" y="45" text-anchor="middle">stripe-openapi.yaml</text>
  <text class="note" x="95" y="61" text-anchor="middle">what they say they return</text>

  <text class="axis" x="95" y="112" text-anchor="middle">Yours</text>
  <rect class="box" x="10" y="122" width="170" height="42" rx="6" />
  <text class="label-mono" x="95" y="141" text-anchor="middle">src/payments.ts</text>
  <text class="note" x="95" y="157" text-anchor="middle">what you handle</text>

  <line class="arrow" x1="180" y1="47" x2="212" y2="47" marker-end="url(#openapi-arrow)" />
  <line class="arrow" x1="180" y1="143" x2="212" y2="143" marker-end="url(#openapi-arrow)" />

  <rect class="box" x="216" y="26" width="184" height="42" rx="6" />
  <text class="label-mono" x="308" y="52" text-anchor="middle">contract --from openapi</text>

  <rect class="box" x="216" y="122" width="184" height="42" rx="6" />
  <text class="label-mono" x="308" y="148" text-anchor="middle">extract -f axios</text>

  <line class="arrow" x1="400" y1="47" x2="432" y2="47" marker-end="url(#openapi-arrow)" />
  <line class="arrow" x1="400" y1="143" x2="432" y2="143" marker-end="url(#openapi-arrow)" />

  <rect class="box-data" x="436" y="26" width="150" height="42" rx="6" />
  <text class="label-mono" x="511" y="52" text-anchor="middle">stripe.json</text>

  <rect class="box-data" x="436" y="122" width="150" height="42" rx="6" />
  <text class="label-mono" x="511" y="148" text-anchor="middle">client.json</text>

  <text class="note" x="600" y="90" text-anchor="middle">same</text>
  <text class="note" x="600" y="105" text-anchor="middle">shape</text>

  <path class="arrow" d="M511,68 L511,95 L330,95 L330,214" marker-end="url(#openapi-arrow)" />
  <path class="arrow" d="M511,164 L511,190 L330,190" />

  <rect class="box" x="200" y="220" width="260" height="40" rx="6" />
  <text class="label-mono" x="330" y="245" text-anchor="middle">suss check --dir summaries/</text>
</svg>

Both sides come out in the same format, and the checker pairs them by
`(method, normalizedPath)`. It does not care that one side was written
by Stripe and the other was read out of your code.

## Step 1. Turn the spec into a contract

```bash
npm install -D @suss/contract-openapi
npx suss contract --from openapi stripe-openapi.yaml -o summaries/stripe.json
```

A URL works in place of the file path, useful when the vendor
publishes their spec on GitHub or a docs site:

```bash
npx suss contract --from openapi \
  https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml \
  -o summaries/stripe.json
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

- **unhandledProviderCase**, Stripe's spec declares a status
  your client doesn't handle. Either add the branch, or suppress
  with a `.sussignore` entry if the path is unreachable for
  your use case.
- **deadConsumerBranch**: your client reads a status Stripe
  doesn't declare. Often drift from a copy-pasted client:
  delete the branch.
- **lowConfidence**: your client branches on something the
  analyzer can't decompose (dynamic predicate, complex chain).
  Informational; means the finding below it may be incomplete.

## Handling path mismatches

OpenAPI paths use `{id}` syntax; different clients use `:id`
(Express-style) or template literals `` `${id}` ``. The pairing
layer normalizes these, `GET /users/:id`, `GET /users/{id}`,
and `` axios.get(`/users/${id}`) `` all pair.

If pairs aren't matching, inspect what boundaries suss is seeing
on each side:

```bash
npx suss inspect --dir summaries/
```

The output groups summaries by boundary key and shows which ones
didn't match. Common root causes:

- **Base URL prefix**: your client hits `/v1/users/123` but the
  spec declares `/users/{id}` (no `/v1`). The axios pack doesn't
  strip base URLs automatically; fix by either matching the spec's
  path with a leading prefix, or by normalizing before extraction.
- **Encoded segments**, `/search/{q}` vs
  `` axios.get(`/search/${encodeURIComponent(q)}`) ``, parsed the
  same, so this isn't usually a problem.
- **Path as a parameter, not a literal**: if you do
  `axios.get(url)` where `url` is a parameter, the pack can't see
  the path. Wrapper-expansion handles one hop; deeper indirection
  doesn't pair automatically.

## Pair against a subset

Sometimes you only use a slice of a large vendor spec (you hit 5
of Stripe's 200 endpoints). Run the full pair, unmatched
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
about *coverage*, does every declared status have a handler?
Every prop, a scenario? Every field, a resolver?

Run both if you can. They answer different questions.
