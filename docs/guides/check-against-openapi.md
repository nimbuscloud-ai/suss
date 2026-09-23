---
title: Check against OpenAPI
description: Read an OpenAPI 3.x document into summaries and compare it against the client that calls the API, the handler that serves it, or both at once.
---

# Check against OpenAPI

Compare an OpenAPI 3.x document against the code on either side of it. `suss contract` reads the document and writes summaries in the same format `extract` writes from source, and `check` compares the two.

```bash
npx suss contract --from openapi openapi.yaml -o summaries/contract.json
npx suss check --dir summaries/
```

Everything ships inside `@suss/cli`, so `npm install --save-dev @suss/cli` is the only install.

There are two directions, and they catch different things:

- **You call the API.** The document is the provider. If it declares a status your client never branches on, your client will meet that status in production.
- **You serve the API.** The document says what you promised your clients. If your handler produces a status the document leaves out, no client written against the document will handle it.

<!-- suss:example -->

Every example below runs against one small project, which has a document, a client that calls it and a handler that serves it.

`openapi.yaml`, the document:

```yaml
openapi: 3.0.3
info:
  title: Accounts
  version: "1.0.0"
paths:
  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: The user
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  name: { type: string }
                  email: { type: string }
        "404":
          description: No such user
          content:
            application/json:
              schema:
                type: object
                properties:
                  error: { type: string }
        "429":
          description: Too many requests
          content:
            application/json:
              schema:
                type: object
                properties:
                  error: { type: string }
                  retryAfter: { type: integer }
```

## The consumer side

`src/loadUser.ts`, a client that handles the 404 and nothing else:

```ts
export async function loadUser(id: string) {
  const res = await fetch(`https://accounts.example.com/users/${id}`);

  if (res.status === 404) {
    return null;
  }

  const body = (await res.json()) as { id: string; email: string };
  return body.email;
}
```

Read both sides into one folder. The document becomes one summary per operation, with the declared parameters as inputs and one transition per declared status:

```bash
suss contract --from openapi openapi.yaml -o consumer/contract.json
suss inspect consumer/contract.json
```

```
openapi:openapi.yaml
└─ GET /users/{id}  (openapi handler | line 0)
     Contract: 200, 404, 429
       -> 200 { id, name, email }
       -> 404 { error }
       -> 429 { error, retryAfter }

1 summary.
```

You can pass a URL in place of the file path, which helps when the vendor publishes the document on GitHub or on a docs site: `suss contract --from openapi https://example.com/openapi/spec3.yaml -o summaries/vendor.json`.

Now read the client and compare:

```bash
suss extract --dir . -f fetch -o consumer/client.json
suss check --dir consumer/ --all
```

`--all` writes out every pair and every finding, instead of only counting the quiet ones. There is one pair here, the document against the client, and two things are wrong with it:

<!-- suss:excerpt -->

```
────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 429 but no consumer branch handles it
  provider: openapi:openapi.yaml::getUser (openapi:openapi.yaml:0)
  consumer: src/loadUser.ts::loadUser (src/loadUser.ts:1)
  boundary: openapi (http) GET /users/{id}
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "getUser:response:429:stub" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[WARNING] consumerContractViolation
  Contract declares response 429 but consumer does not handle it
  provider: openapi:openapi.yaml::getUser (openapi:openapi.yaml:0)
  consumer: src/loadUser.ts::loadUser (src/loadUser.ts:1)
  boundary: openapi (http) GET /users/{id}
────────────────────────────────────────────────────────────
2 findings: 0 error, 2 warning, 0 info
```

The client falls through to `res.json()` on a 429 and reads `body.email` off a rate-limit payload that has no `email` in it. Add the branch, or accept the finding with a `.sussignore` rule when the path is unreachable for your use of the API.

When the vendor publishes a new version of the document, re-run this to see what your client stopped covering.

The axios and Apollo packs work the same way: `-f axios` recognizes both `axios.get(...)` and a factory-bound `const api = axios.create({ baseURL }); api.get(...)`, and `-f apollo-client` reads the hooks and `client.query`.

## The provider side

`src/server.ts`, the handler that serves it:

```ts
import express from "express";

declare const db: {
  findById(id: string): Promise<{
    id: string;
    name: string;
    email: string;
    deletedAt: string | null;
  } | null>;
};

const app = express();

app.get("/users/:id", async (req, res) => {
  const user = await db.findById(req.params.id);

  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }

  if (user.deletedAt) {
    res.status(410).json({ error: "gone" });
    return;
  }

  res.status(200).json({ id: user.id, name: user.name });
});

export default app;
```

Run the same two commands, pointed at the handler instead of the client:

```bash
suss extract --dir . -f express -o provider/backend.json
suss contract --from openapi openapi.yaml -o provider/contract.json
suss check --dir provider/
```

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[ERROR] providerContractViolation
  Handler produces status 410 which the openapi document does not declare
  provider: src/server.ts::get (src/server.ts:14)
  consumer: openapi:openapi.yaml::getUser (openapi:openapi.yaml:0)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: providerContractViolation
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:410:3b915da" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
2 findings: 1 error, 1 warning, 0 info

Not shown: 1 providerContractViolation (warning). Run the same command with --all to see it.

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

A status the handler produces that the document leaves out is an error, because a client written against the document has no branch for it. The other direction is a warning, and that is the finding this run counted without printing: the document declares a 429 and no path in the handler produces it. suss keeps that one at warning because documents routinely declare a 401 that middleware sends.

## Both at once

Put all three summaries in one folder and suss compares every pair: the handler against the client, the handler against the document, and the document against the client.

```bash
suss extract --dir . -f express -f fetch -o summaries/code.json
suss contract --from openapi openapi.yaml -o summaries/contract.json
suss check --dir summaries/
```

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[ERROR] providerContractViolation
  Handler produces status 410 which the openapi document does not declare
  provider: src/server.ts::get (src/server.ts:14)
  consumer: openapi:openapi.yaml::getUser (openapi:openapi.yaml:0)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: providerContractViolation
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:410:3b915da" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
5 findings: 1 error, 4 warning, 0 info

Not shown: 2 unhandledProviderCase (warning), 1 consumerContractViolation (warning), 1 providerContractViolation (warning). Run the same command with --all to see them.

suss met a call it could not follow in one unit, of 3, so that one is described in part. `suss inspect` says which calls.
```

Three pairs produced five findings. Each of the two runs above found two, and the fifth comes from the pair neither of them had, the handler against the client. suss now reports the 410 twice, once because the document does not declare it and once because the client has no branch for it. When several sources agree on one boundary, the `also from:` line on a finding tells you where each side came from.

The handler and the client share no types here. The client is a `fetch` call site in a browser bundle, the handler is Express in Node, and nothing imports anything across that line. suss reads both into the same format and pairs them on `(method, path)`, so the 410 shows up against the client as well as against the document.

## When a pair does not form

OpenAPI writes path parameters as `{id}`, Express writes them as `:id`, and a client writes a template literal. All three normalize to the same key, so `GET /users/:id`, `GET /users/{id}` and ``fetch(`/users/${id}`)`` pair.

When something is not pairing, look at what each side claims:

```bash
suss inspect --dir summaries/
```

The usual causes, in order:

- **A base URL in front of the path.** The document's `servers[0].url` (or a Swagger 2.0 `basePath`) goes in front of every route it declares, and a `baseURL` on an axios instance goes in front of every path the client writes. So `axios.create({ baseURL: "/v1" })` plus `api.get("/users/1")` pairs with a document serving `/users/{id}` under `/v1`. An absolute base keeps only its path, and a base of `/` adds nothing. When suss cannot read the base, because it is computed at run time from something like `process.env.API_URL`, the path stays bare, and that is where the two sides can still disagree.
- **The path is a parameter instead of a literal.** In `axios.get(url)`, where `url` is an argument, the pack has no path to read.
- **Encoded segments.** `/search/{q}` against ``axios.get(`/search/${encodeURIComponent(q)}`)`` parses the same on both sides, so this one is rarely the problem.

## A slice of a large document

<!-- suss:unchecked the vendor document it filters is not one this repository checks in -->

Your client may use only a handful of a vendor's operations. Run the whole pair anyway. The provider summaries that match nothing land in `unmatched.providers` and they do not fail the build, so there is nothing to tune.

To be strict about what is in use, filter the summaries before checking:

```bash
jq '[.[] | select(.identity.boundaryBinding.semantics.path | test("^/v1/(charges|refunds)"))]' \
  summaries/vendor.json > summaries/vendor-subset.json
npx suss check summaries/vendor-subset.json summaries/client.json
```

The filtering happens before the check, so every check flag still applies.

## Against a contract test

A contract test, such as Pact or dredd, sends requests and inspects the responses at run time. It is authoritative about the traffic it generates, and it needs your code running. suss reads the source instead and asks a coverage question: does every declared status have a branch, does every declared field get read, and does every field the code reads get declared?

Run both if you can. They answer different questions, and the static one runs on a pull request in seconds.
