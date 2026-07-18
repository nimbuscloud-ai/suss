# Pair a frontend with a backend

A small Express API and a React component that calls it, with two known mismatches: the response field has different names on each side, and the consumer doesn't handle one of the response statuses. suss catches both from source alone, with the OpenAPI document as the contract joining them.

The two sides don't share types or a framework; the only common artifact is the OpenAPI document on the backend.

## Step 1. Set up a workspace

```bash
mkdir suss-pair-tutorial && cd suss-pair-tutorial
npm init -y
npm install --save-dev \
  typescript \
  @suss/cli \
  @suss/framework-express \
  @suss/client-web \
  @suss/contract-openapi \
  @types/express @types/react \
  express react
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
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

The handler returns the user object on 200 (with `fullName`), or a `404` with an error message if the id isn't known.

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

The contract declares both the success and not-found responses. The 200 body shape (`{ id, fullName }`) is the one the handler returns.

## Step 4. Write the frontend component

`frontend/src/UserCard.tsx`:

```tsx
import { useEffect, useState } from "react";

export function UserCard({ id }: { id: string }) {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/users/${id}`)
      .then((res) => res.json())
      .then((data) => setName(data.name));
  }, [id]);

  if (name === null) return <div>Loading…</div>;
  return <div>User: {name}</div>;
}
```

Two things to notice:

1. The component reads `data.name` — but the backend (and the contract) return `fullName`.
2. The component doesn't check `res.status` or `res.ok`, so it has no branch for the 404.

Both are drift bugs that survive type-checking because the frontend never imports the backend's types. Let suss catch them.

## Step 5. Extract summaries

```bash
mkdir summaries
npx suss extract -p tsconfig.json -f express -o summaries/backend.json
npx suss extract -p tsconfig.json -f web -o summaries/frontend.json
npx suss contract --from openapi backend/openapi.yaml -o summaries/contract.json
```

Three summary files, one per source: the backend handler's behavior, the frontend component's behavior, and the contract derived from the OpenAPI document.

Quick look at what came out of the backend:

```bash
npx suss inspect summaries/backend.json
```

You should see the `GET /users/:id` handler with two transitions — a 404 path gated on `!user`, and a default 200 path returning the user object.

## Step 6. Run the checker

```bash
npx suss check --dir summaries
```

Expected output (wording may vary slightly):

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: backend/src/server.ts:14 (express handler)
  consumer: frontend/src/UserCard.tsx:6 (UserCard)
  boundary: GET /users/:id

[ERROR] consumerFieldMismatch
  Consumer reads body.name; provider's 200 body has { id, fullName }
  provider: backend/src/server.ts:14 — body { id, fullName }
  consumer: frontend/src/UserCard.tsx:8 — reads .name
  boundary: GET /users/:id
```

The two findings come from different parts of the IR:

1. **`unhandledProviderCase`** — the provider's transitions include a 404; the consumer's code has no branch on `res.status` or `res.ok`. The checker pairs the two summaries on `(GET, /users/:id)` and notices the asymmetry.
2. **`consumerFieldMismatch`** — the provider's 200 body has shape `{ id, fullName }`; the consumer reads `.name` off the parsed body. Field-level shape comparison handles this in `body/bodyMatch.ts`.

The OpenAPI contract participates too — the `contract.json` summary declares the same 200 and 404 shapes, so the consumer's gaps are gaps against the declared contract, not only against the implementation.

## Step 7. Fix the findings

Update `frontend/src/UserCard.tsx` to handle both the 404 and the correct field name:

```tsx
import { useEffect, useState } from "react";

export function UserCard({ id }: { id: string }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/users/${id}`).then((res) => {
      if (res.status === 404) {
        setError("User not found");
        return;
      }
      return res.json().then((data) => setName(data.fullName));
    });
  }, [id]);

  if (error !== null) return <div>{error}</div>;
  if (name === null) return <div>Loading…</div>;
  return <div>User: {name}</div>;
}
```

Re-extract the frontend and re-check:

```bash
npx suss extract -p tsconfig.json -f web -o summaries/frontend.json
npx suss check --dir summaries
```

Both findings should be gone. `suss check` exits 0.

## What this run exercises

- **Cross-stack pairing.** Express on one side, `fetch` from a React component on the other, no shared types. suss read each side's behavior into the same shape and paired them on `(method, path)` automatically.
- **Field-level body matching.** The consumer's `.name` access compared against the provider's `{ id, fullName }` body went through structural comparison. TypeScript wouldn't catch this — the frontend never imports the backend's types.
- **Status-handling gaps.** The missing 404 branch is a reachability check against the provider's transitions, not a coverage measurement. The finding fires regardless of whether the 404 path is exercised at runtime.

## Further reading

- [Get started](/tutorial/get-started) — the same workflow with ts-rest, where the contract is in the framework rather than a separate document.
- [Pair against OpenAPI](/guides/pair-against-openapi) — recipe form of this workflow once you know it.
- [Findings catalog](/reference/findings) — every finding kind with an example.
- [Three kinds of truth](/contracts) — the specification / observation / derivation taxonomy that grounds the checker's finding semantics.
