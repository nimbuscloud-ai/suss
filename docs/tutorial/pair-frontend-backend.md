# Pair a frontend with a backend

An Express API, an OpenAPI document, and the frontend code that calls the
API. The frontend has two bugs. It reads a field the backend does not
send, and it has no branch for the 404. Both compile. suss finds both
from source alone.

The two sides share no types and no framework. The OpenAPI document is
the only artifact they have in common.

## Step 1. Set up a workspace

```bash
mkdir suss-pair-tutorial && cd suss-pair-tutorial
npm init -y
npm install express
npm install --save-dev \
  typescript \
  @suss/cli \
  @suss/framework-express \
  @suss/client-web \
  @suss/contract-openapi \
  @types/express
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["backend/src", "frontend/src"]
}
```

```bash
mkdir -p backend/src frontend/src
```

## Step 2. Write the backend handler

`backend/src/server.ts`:

```ts
import express, { Request, Response } from "express";

interface User {
  id: string;
  fullName: string;
}

const users: Record<string, User> = {
  "1": { id: "1", fullName: "Ada Lovelace" },
};

const app = express();

app.get("/users/:id", (req: Request, res: Response) => {
  const user = users[req.params.id];
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(user);
});
```

Two outcomes. A 404 with an error message when the id is unknown, and a
200 with the user in it.

## Step 3. Declare the contract

`backend/openapi.yaml`:

```yaml
openapi: 3.1.0
info:
  title: Users API
  version: 1.0.0
paths:
  /users/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: User found
          content:
            application/json:
              schema:
                type: object
                required: [id, fullName]
                properties:
                  id: { type: string }
                  fullName: { type: string }
        "404":
          description: User not found
          content:
            application/json:
              schema:
                type: object
                required: [error]
                properties:
                  error: { type: string }
```

The contract declares both responses, and the 200 body matches what the
handler returns.

## Step 4. Write the frontend loader

`frontend/src/loadUser.ts`:

```ts
export function loadUser(id: string) {
  return fetch(`/users/${id}`)
    .then((res) => res.json())
    .then((data) => data.name);
}
```

This is the code a component would call. Two things are wrong with it.

It reads `data.name`, and the backend sends `fullName`. It never looks at
`res.status`, so a 404 body flows on as if it were a user. Neither is a
type error, because the frontend never imports the backend's types.

## Step 5. Read all three

```bash
mkdir summaries
npx suss extract -p tsconfig.json -f express -o summaries/backend.json
npx suss extract -p tsconfig.json -f fetch -o summaries/frontend.json
npx suss contract --from openapi backend/openapi.yaml -o summaries/contract.json
```

Three summary files: what the handler does, what the loader expects, and
what the document promises. All three are in the same format.

Look at the backend:

```bash
npx suss inspect summaries/backend.json
```

```
backend/src/server.ts
└─ GET /users/:id  (express handler | line 14)
       if  !user
         -> 404 { error }
       else
         -> 200 { id, fullName }

1 summary.
```

## Step 6. Compare them

```bash
npx suss check --dir summaries --fail-on warning
```

The missing 404 branch is a warning: whether the loader's fall-through
is the intended handling is a judgement, so a default run does not fail
on it. `--fail-on warning` prints warnings and fails on them, which is
what this tutorial wants. The `.name` read is an error either way.

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: backend/src/server.ts::get (backend/src/server.ts:14)
    also from: openapi:openapi.yaml::GET /users/{id}
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:404:afd032b" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "name", but the 200 body the provider sends does not include it, and neither does any other response. The read comes back undefined and no error says so.
  provider: backend/src/server.ts::get (backend/src/server.ts:14)
    also from: openapi:openapi.yaml::GET /users/{id}
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: misreadProviderResponse
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:200:ddaf2ab" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[WARNING] consumerContractViolation
  Contract declares response 404 but consumer does not handle it
  provider: openapi:openapi.yaml::GET /users/{id} (openapi:openapi.yaml:0)
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: openapi (http) GET /users/{id}
────────────────────────────────────────────────────────────
[WARNING] consumerContractViolation
  Consumer reads fields on status 200 that the declared contract does not promise, so it relies on something the provider never agreed to keep
  provider: openapi:openapi.yaml::GET /users/{id} (openapi:openapi.yaml:0)
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: openapi (http) GET /users/{id}
  to silence this one, add to the rules in .sussignore.yml:
    - kind: consumerContractViolation
      boundary: "GET /users/{id}"
      consumer: { transitionId: "loadUser:return:none:da39a3e" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
4 findings: 1 error, 3 warning, 0 info
```

Both bugs are there, and each is reported twice: once from pairing the
two summaries, once from checking the loader against the declared
contract.

The `.name` read is the interesting one. suss followed the response
through two `.then` callbacks to work out which fields the loader
depends on, then compared that list against the handler's 200 body.

The run ends with a note that two files claim `GET /users/{id}`. That is
expected here, since the handler and the document describe the same
endpoint.

## Step 7. Fix the loader

`frontend/src/loadUser.ts`:

```ts
export async function loadUser(id: string) {
  const res = await fetch(`/users/${id}`);

  if (res.status === 404) {
    return null;
  }

  return res.json().then((data) => data.fullName);
}
```

Re-read the frontend and compare again:

```bash
npx suss extract -p tsconfig.json -f fetch -o summaries/frontend.json
npx suss check --dir summaries --fail-on warning
```

```
Compared 1 boundary.

No findings. Every compared boundary agreed.
```

`suss check` exits 0.

## What this run exercises

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

## Further reading

- [Get started](/tutorial/get-started), the same idea with Hono and no separate document.
- [Pair against OpenAPI](/guides/pair-against-openapi), the recipe form once you know the workflow.
- [Findings catalog](/reference/findings), every finding kind with an example.
- [Three kinds of truth](/contracts), the split between specification, observation, and derivation that gives the findings their meaning.
