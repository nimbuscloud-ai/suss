---
title: Check against OpenAPI
description: Read an OpenAPI 3.x document into summaries and compare it against the code that calls the API, or the handlers that serve it.
---

# Check against OpenAPI

You call an API somebody else owns and you have its OpenAPI 3.x
document. Find out which statuses it declares that your client never
handles, and get told when the vendor publishes a new version and your
code drifts away from it.

You don't have the vendor's source, so `extract` has nothing to read.
`contract` reads the spec instead and produces summaries in the same
format, which `check` then compares against your call sites.

## What gets compared

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

  <path class="arrow" d="M586,47 L616,47 L616,240 L468,240" marker-end="url(#openapi-arrow)" />
  <path class="arrow" d="M586,143 L616,143" />

  <rect class="box" x="204" y="220" width="260" height="40" rx="6" />
  <text class="label-mono" x="334" y="245" text-anchor="middle">suss check --dir summaries/</text>
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

One summary per operation. Each one has:
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
npm install -D @suss/cli   # the axios, fetch and apollo packs ship with it
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
  It's informational, and it means the finding below it may be
  incomplete.

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

- **Base URL prefix**: the spec's `servers[0].url` (or a Swagger
  2.0 `basePath`) goes in front of every route it declares, and a
  `baseURL` on the axios instance goes in front of every path the
  client writes, so `axios.create({ baseURL: "/v1" })` plus
  `api.get("/users/1")` pairs with a spec serving `/users/{id}`
  under `/v1`. An absolute base keeps only its path, and a base of
  `/` adds nothing. A base suss cannot read, one computed at
  runtime such as `process.env.API_URL`, leaves the path bare,
  which is where the two sides can still disagree.
- **Encoded segments**, `/search/{q}` vs
  `` axios.get(`/search/${encodeURIComponent(q)}`) ``. suss parses
  both the same way, so this isn't usually a problem.
- **Path as a parameter, not a literal**: if you do
  `axios.get(url)` where `url` is a parameter, the pack can't see
  the path. Wrapper expansion handles one hop, and anything deeper
  doesn't pair automatically.

## Pair against a subset

Sometimes you only use a slice of a large vendor spec (you hit 5
of Stripe's 200 endpoints). Run the full pair. The provider
summaries that don't match land in `unmatched.providers` and don't
fail the build. [Run suss in CI](/guides/ci-integration) shows the
`--fail-on error` default that makes this work without tuning.

If you want to be strict about what's *in use*, filter the
summaries file before checking:

```bash
# Keep only /v1/charges and /v1/refunds
jq '[.[] | select(.identity.boundaryBinding.semantics.path | test("^/v1/(charges|refunds)"))]' \
  summaries/stripe.json > summaries/stripe-subset.json
npx suss check summaries/stripe-subset.json summaries/client.json
```

Alternatively, commit a filter config as part of your CI setup.
The filtering happens before the check, so all the check flags
still apply.

## Check your own handlers against the document

The other direction: you serve the API and you keep the OpenAPI
document for it. `extract` reads the handlers, `contract` reads the
document, and `check` compares the two.

```bash
npx suss extract -p tsconfig.json -f express -o summaries/backend.json
npx suss contract --from openapi openapi.yaml -o summaries/contract.json
npx suss check --dir summaries --fail-on warning
```

A status a handler produces that the document leaves out is an error. A
status the document declares that no path in the handler produces is a
warning, since documents often declare the 401 the middleware sends.

Put the client summaries in the same folder and all three sides are
compared in one run: what the handler does, what the client expects,
and what the document promises. A single bug is then reported twice,
once from pairing the two summaries and once from checking the client
against the declared contract. `also from:` on a finding says where
each side came from.

```
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "name", but the 200 body the provider sends does not include it, and neither does any other response.
  provider: backend/src/server.ts::get (backend/src/server.ts:14)
    also from: openapi:openapi.yaml::GET /users/{id}
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: express (http) GET /users/:id
```

## What a three-way run exercises

**Cross-stack pairing.** Express on one side, `fetch` on the other, no
shared types. suss read each side into the same format and paired them
on `(method, path)`.

**Field-level body matching.** The loader's `.name` read went through
two `.then` callbacks before it reached a comparison against
`{ id, fullName }`. TypeScript never sees this, because the frontend
never imports the backend's types.

**Status handling.** suss finds the missing 404 branch by checking the
loader against the handler's transitions, asking which of them the
loader can reach. It reports this whether or not any test exercises the
404.

**Status checks have to be visible.** suss reads the branch on
`res.status` at the top of the loader. A status check buried in a
callback whose value nobody returns leaves no transition for suss to
read, so keep the branch where the loader returns from.

## When to use this vs writing a contract test

Contract tests (Pact, dredd, openapi-validator) verify requests
and responses at runtime. They're authoritative but require
running the code. suss analyzes the code statically and cares
about *coverage*, does every declared status have a handler?
Every prop, a scenario? Every field, a resolver?

Run both if you can. They answer different questions.
