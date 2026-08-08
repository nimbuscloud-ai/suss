# Get started

A Hono endpoint and the code that calls it. suss reads both sides,
works out what each one does, and reports where they disagree. Nothing
runs, and neither side needs a shared type or a generated client.

## Step 1. Set up a workspace

```bash
mkdir suss-tutorial && cd suss-tutorial
npm init -y
npm pkg set type=module

npm install hono
npm install --save-dev @suss/cli @suss/framework-hono @suss/client-web typescript
```

One pack per thing you want read: `framework-hono` for the routes,
`client-web` for the `fetch` calls.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

## Step 2. Write the endpoint

`src/api.ts`:

```ts
import { Hono } from "hono";

const app = new Hono();

app.get("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));

  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({ id: user.id, name: user.name });
});

declare function findUser(
  id: string,
): Promise<{ id: string; name: string } | null>;

export default app;
```

Two outcomes: 404 when there is no such user, 200 with the user
otherwise.

## Step 3. Write the caller

`src/client.ts`:

```ts
export async function loadUser(id: string) {
  const response = await fetch(`/users/${id}`);

  if (response.status === 200) {
    const user = await response.json();
    return { state: "ready", name: user.name };
  }

  return { state: "error" };
}
```

It checks for 200 and treats everything else the same way.

## Step 4. Read both sides

```bash
npx suss extract -f hono -o summaries/api.json
npx suss extract -f fetch -o summaries/web.json
```

Each command writes a summary: a description of what that code does, as
data. There is no tsconfig path to pass, because suss finds the one in
this directory.

Look at what it read:

```bash
npx suss inspect summaries/api.json
```

```
src/api.ts
└─ GET /users/:id  (hono handler | line 5)
       if  !findUser()
         -> 404 { error }
       else
         -> 200 { id, name }

1 summary.
```

That is the endpoint's behaviour rather than its types: which condition
leads to which status, and what the body contains in each case. And
`c.json(body, status)` was read correctly without anyone telling suss
which argument is which.

## Step 5. Compare them

```bash
npx suss check --dir summaries/
```

```
Compared 1 boundary:
  GET /users/{id}: get <-> loadUser

────────────────────────────────────────────────────────────
[ERROR] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadUser (src/client.ts:1)
  boundary: hono (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:404:afd032b" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 1 error, 0 warning, 0 info
```

The endpoint separates "no such user" from every other failure. The
caller does not, so a missing user and a database outage both reach the
screen as `{ state: "error" }`. Both files typecheck, so nothing else
was going to tell you.

The last lines are a rule you can paste, for when you decide to live
with a finding. It matches this finding and no other. See [Suppress a
finding](/guides/suppress-findings).

Give the caller its own branch:

```ts
export async function loadUser(id: string) {
  const response = await fetch(`/users/${id}`);

  if (response.status === 404) {
    return { state: "missing" };
  }

  if (response.status === 200) {
    const user = await response.json();
    return { state: "ready", name: user.name };
  }

  return { state: "error" };
}
```

```bash
npx suss extract -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

```
Compared 1 boundary:
  GET /users/{id}: get <-> loadUser

No findings. Every compared boundary agreed.
```

## Step 6. Change the endpoint and watch it break

A deleted user should look different from a missing one, so add a case
for them:

```ts
  if (user.deletedAt) {
    return c.json({ error: "gone" }, 410);
  }
```

with `findUser` now returning `deletedAt: string | null`. Read the
endpoint again and compare:

```bash
npx suss extract -f hono -o summaries/api.json
npx suss check --dir summaries/
```

```
────────────────────────────────────────────────────────────
[ERROR] unhandledProviderCase
  Provider produces status 410 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadUser (src/client.ts:1)
  boundary: hono (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:410:3b915da" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 1 error, 0 warning, 0 info
```

Nobody touched the caller, and the caller is now wrong. `check` exits
non-zero, so this fails on the pull request that adds the 410 rather
than in a bug report a week later.

## What happened

- `extract` read each side and wrote down its behaviour: the
  conditions, the statuses, and what each body looks like.
- `check` paired the two by method and path, then compared what one
  produces against what the other handles.
- The finding gave a status, a file, and a line on both sides.

## Next

- [Add suss to an existing project](/guides/add-to-project)
- [Set up CI checking](/guides/ci-integration)
- [Compatibility](/reference/compatibility), for languages, module
  systems, and where suss stops
- [Findings catalog](/reference/findings), for every finding kind
